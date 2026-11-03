import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { SessionsApi, TurnEvent, TurnInput, TurnStream } from '../../../src/core/trueforge/turnRunner';

/** The stored log uses the wire format; the SDK hands the same events to us in camelCase. */
function camelize(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => camelize(item, parentKey));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
      camelize(inner, key),
    ]),
  );
}

interface Recording {
  session_id: string;
  turns: { turn_id: string; events: unknown[] }[];
}

/** Events recorded from real P0 sessions against TrueForge 0.183.0, one array per turn. */
export function loadRecording(name: string): { sessionId: string; turns: TurnEvent[][] } {
  const file = path.resolve(__dirname, '../../fixtures', `${name}.json`);
  const recording = JSON.parse(readFileSync(file, 'utf8')) as Recording;
  return {
    sessionId: recording.session_id,
    turns: recording.turns.map((turn) => turn.events.map((event) => camelize(event) as TurnEvent)),
  };
}

function streamOf(events: readonly TurnEvent[], onEach?: (event: TurnEvent) => Promise<void> | void): TurnStream {
  return {
    withMetadata: () =>
      (async function* () {
        let seq = 0;
        for (const event of events) {
          await onEach?.(event);
          seq += 1;
          // A copy, so merging deltas into the index cannot change the recording between runs.
          yield { data: structuredClone(event), id: String(seq) };
        }
      })(),
  };
}

export interface ReplayApi extends SessionsApi {
  inputs: TurnInput[][];
  cancelCalls: number;
}

/** A SessionsApi that plays back one recorded turn per createTurnStream call. */
export function replaySessions(turns: readonly TurnEvent[][]): ReplayApi {
  let next = 0;
  const api: ReplayApi = {
    inputs: [],
    cancelCalls: 0,
    createTurnStream: (_sessionId, request) => {
      api.inputs.push(request.input);
      const events = turns[next];
      next += 1;
      if (!events) return Promise.reject(new Error('The replay has no more turns.'));
      return Promise.resolve(streamOf(events));
    },
    cancel: () => {
      api.cancelCalls += 1;
      return Promise.resolve();
    },
  };
  return api;
}

/** Splits one recorded model.message into a shell plus deltas, the shape a live stream has. */
export function asDeltas(message: Extract<TurnEvent, { type: 'model.message' }>, chunkSize = 5): TurnEvent[] {
  const text = typeof message.content === 'string' ? message.content : '';
  const { content: _content, toolCalls: _toolCalls, ...rest } = message;
  void _content;
  void _toolCalls;
  const deltas: TurnEvent[] = [{ ...rest, type: 'model.message', content: '' }];
  for (let i = 0; i < text.length; i += chunkSize) {
    deltas.push({ type: 'model.message.delta', id: message.id, threadId: message.threadId, content: text.slice(i, i + chunkSize) });
  }
  return deltas;
}
