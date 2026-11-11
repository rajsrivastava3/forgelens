import { describe, expect, it, vi } from 'vitest';
import { AgentRun } from '../../src/core/trueforge/agentRun';
import { describeTurnError } from '../../src/core/trueforge/errors';
import { RunViewBuilder, type ThreadItem, type ToolItem, type ViewItem } from '../../src/core/trueforge/runView';
import { TurnRunner, type SessionsApi, type TurnEvent, type TurnInput, type TurnStream } from '../../src/core/trueforge/turnRunner';
import { asDeltas, loadRecording, replaySessions } from './helpers/fixtures';

const INPUT: TurnInput[] = [{ type: 'user.message', content: 'hi' }];

function tools(items: readonly ViewItem[]): ToolItem[] {
  return items.flatMap((item) => (item.kind === 'tool' ? [item] : item.kind === 'thread' ? tools(item.items) : []));
}

describe('TurnRunner replaying recorded turns', () => {
  it('reports a recorded pause with the real tool name and arguments', async () => {
    const { sessionId, turns } = loadRecording('deferred-deny');
    const runner = new TurnRunner({ sessions: replaySessions(turns), sessionId });
    const outcome = await runner.runTurn(INPUT);
    if (outcome.status !== 'paused') throw new Error(`expected a pause, got ${outcome.status}`);
    expect(outcome.approvals).toHaveLength(1);
    expect(outcome.approvals[0]?.call.name).toBe('apply_changes_probe');
    expect(outcome.approvals[0]?.call.args['summary']).toMatch(/^probe-deferred-deny-/);
    expect(outcome.approvals[0]?.threadId).toBe('main');
  });

  it('groups events per thread', async () => {
    const { sessionId, turns } = loadRecording('subagent-read');
    const runner = new TurnRunner({ sessions: replaySessions(turns), sessionId });
    const outcome = await runner.runTurn(INPUT);
    expect(outcome.status).toBe('done');
    const sub = [...runner.threads.values()].find((thread) => thread.threadId !== 'main');
    expect(sub).toMatchObject({ title: 'helpers-reader-agent', done: true, parent: { threadId: 'main' } });
    expect(sub?.eventIds.length).toBeGreaterThan(1);
    expect(runner.threads.get('main')?.eventIds.length).toBeGreaterThan(1);
  });

  it('turns a recorded model failure into a clear message', async () => {
    const { sessionId, turns } = loadRecording('error-429');
    const runner = new TurnRunner({ sessions: replaySessions(turns), sessionId });
    const outcome = await runner.runTurn(INPUT);
    if (outcome.status !== 'error') throw new Error(`expected an error, got ${outcome.status}`);
    expect(outcome.error.kind).toBe('quota');
    expect(outcome.error.message).toContain('requests per day');
    expect(outcome.error.message).toMatch(/Retry in (\d+h)?(\d+m)?\d+s\.$/);
    expect(outcome.error.message).not.toContain('[Model Error]');
  });

  it('merges deltas into the indexed message', async () => {
    const { sessionId, turns } = loadRecording('subagent-read');
    const main = turns[0] ?? [];
    const finalMessage = [...main].reverse().find((event) => event.type === 'model.message');
    if (finalMessage?.type !== 'model.message') throw new Error('no final message');
    const streamed = main.flatMap((event) => (event === finalMessage ? asDeltas(finalMessage) : [event]));

    const seen: string[] = [];
    const runner = new TurnRunner({
      sessions: replaySessions([streamed]),
      sessionId,
      onEvent: (event, current) => {
        if (event.type === 'model.message.delta' && current.type === 'model.message') {
          seen.push(String(current.content));
        }
      },
    });
    await runner.runTurn(INPUT);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1)).toBe(finalMessage.content);
    const stored = runner.events.get(finalMessage.id);
    expect(stored?.type === 'model.message' && stored.content).toBe(finalMessage.content);
  });
});

/** A live-like stream that stays open until the test says what happens next. */
function controllableSessions() {
  let push: ((event: TurnEvent) => void) | undefined;
  let finish: (() => void) | undefined;
  const queue: TurnEvent[] = [];
  const stream: TurnStream = {
    withMetadata: () =>
      (async function* () {
        for (;;) {
          const event = queue.shift();
          if (event) {
            yield { data: event };
            if (event.type === 'turn.done') return;
            continue;
          }
          const ended = await new Promise<boolean>((resolve) => {
            push = () => resolve(false);
            finish = () => resolve(true);
          });
          if (ended) return;
        }
      })(),
  };
  const cancelledState: TurnEvent = {
    type: 'turn.done',
    id: 'done-1',
    createdAt: '2026-11-03T00:00:00.000Z',
    threadId: null,
    state: { status: 'cancelled', reason: 'client-cancelled', completedAt: '2026-11-03T00:00:00.000Z' },
  };
  const send = (event: TurnEvent): void => {
    queue.push(event);
    push?.(event);
  };
  const sessions: SessionsApi & { cancel: ReturnType<typeof vi.fn> } = {
    createTurnStream: () => Promise.resolve(stream),
    cancel: vi.fn(() => {
      send(cancelledState);
      return Promise.resolve();
    }),
  };
  return { sessions, send, end: () => finish?.() };
}

describe('cancellation', () => {
  it('asks the server, lets the stream end, and reports cancelled', async () => {
    const { sessions } = controllableSessions();
    const runner = new TurnRunner({ sessions, sessionId: 's' });
    const running = runner.runTurn(INPUT);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.cancel();
    const outcome = await running;
    expect(sessions.cancel).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'cancelled', reason: 'client-cancelled' });
    expect(runner.running).toBe(false);
  });

  it('is safe to call twice', async () => {
    const { sessions } = controllableSessions();
    const runner = new TurnRunner({ sessions, sessionId: 's' });
    const running = runner.runTurn(INPUT);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all([runner.cancel(), runner.cancel()]);
    await running;
    expect(sessions.cancel).toHaveBeenCalledTimes(1);
  });

  it('abandons the stream if the server never closes it', async () => {
    const hanging: SessionsApi = {
      createTurnStream: (_id, _request, options) =>
        Promise.resolve({
          withMetadata: () =>
            (async function* () {
              yield await new Promise<never>((_, reject) => {
                options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
              });
            })(),
        }),
      cancel: () => Promise.resolve(),
    };
    const runner = new TurnRunner({ sessions: hanging, sessionId: 's', cancelGraceMs: 10 });
    const running = runner.runTurn(INPUT);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.cancel();
    expect(await running).toEqual({ status: 'cancelled', reason: 'abandoned-by-client' });
  });

  it('reads no more once the server cannot be reached to cancel', async () => {
    const unreachable: SessionsApi = {
      createTurnStream: (_id, _request, options) =>
        Promise.resolve({
          withMetadata: () =>
            (async function* () {
              yield await new Promise<never>((_, reject) => {
                options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
              });
            })(),
        }),
      cancel: () => Promise.reject(new Error('fetch failed')),
    };
    const runner = new TurnRunner({ sessions: unreachable, sessionId: 's', cancelGraceMs: 60_000 });
    const running = runner.runTurn(INPUT);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.cancel();
    expect((await running).status).toBe('cancelled');
  });

  it('reports an unreachable server clearly, with no stack trace', async () => {
    const down: SessionsApi = {
      createTurnStream: () => Promise.reject(new TypeError('fetch failed')),
      cancel: () => Promise.resolve(),
    };
    const runner = new TurnRunner({ sessions: down, sessionId: 's', baseUrl: 'http://localhost:8790' });
    const outcome = await runner.runTurn(INPUT);
    if (outcome.status !== 'error') throw new Error('expected error');
    expect(outcome.error.kind).toBe('unreachable');
    expect(outcome.error.message).toContain('TrueForge is not running at http://localhost:8790');
  });

  it('flags a stream that ends without turn.done', async () => {
    const empty: SessionsApi = {
      createTurnStream: () => Promise.resolve({ withMetadata: () => (async function* () {})() }),
      cancel: () => Promise.resolve(),
    };
    const outcome = await new TurnRunner({ sessions: empty, sessionId: 's' }).runTurn(INPUT);
    expect(outcome.status).toBe('error');
  });
});

describe('AgentRun approval loop on recordings', () => {
  it('allows: resumes with the right input and finishes', async () => {
    const { sessionId, turns } = loadRecording('preloaded-allow');
    const sessions = replaySessions(turns);
    const view = new RunViewBuilder();
    view.userMessage('go');
    const seenByHuman: string[] = [];
    const run = new AgentRun({
      sessions,
      sessionId,
      view,
      decide: (approval) => {
        seenByHuman.push(approval.call.name);
        expect(tools(view.snapshot.items)[0]?.status).toBe('awaiting-approval');
        expect(view.snapshot.status).toBe('awaiting-approval');
        return Promise.resolve({ allow: true });
      },
    });
    const outcome = await run.send('go');
    expect(outcome.status).toBe('done');
    expect(seenByHuman).toEqual(['apply_changes_probe']);
    expect(sessions.inputs[1]?.[0]).toMatchObject({ type: 'user.tool_approval', threadId: 'main', approval: { status: 'allow' } });
    expect(tools(view.snapshot.items)[0]?.status).toBe('done');
    expect(view.snapshot.status).toBe('done');
  });

  it('denies: sends the reason and shows the card as declined', async () => {
    const { sessionId, turns } = loadRecording('deferred-deny');
    const sessions = replaySessions(turns);
    const view = new RunViewBuilder();
    view.userMessage('go');
    const run = new AgentRun({
      sessions,
      sessionId,
      view,
      decide: () => Promise.resolve({ allow: false, reason: 'not now' }),
    });
    await run.send('go');
    expect(sessions.inputs[1]?.[0]).toMatchObject({ approval: { status: 'deny', reason: 'not now' } });
    const card = tools(view.snapshot.items).find((tool) => tool.name === 'apply_changes_probe');
    expect(card?.status).toBe('denied');
    expect(card?.viaCallTool).toBe(true);
  });

  it('passes the subagent thread id when approving its call', async () => {
    const { sessionId, turns } = loadRecording('subagent-allow');
    const sessions = replaySessions(turns);
    const view = new RunViewBuilder();
    view.userMessage('go');
    await new AgentRun({ sessions, sessionId, view, decide: () => Promise.resolve({ allow: true }) }).send('go');
    const resume = sessions.inputs[1]?.[0];
    expect(resume).toMatchObject({ type: 'user.tool_approval' });
    expect(resume && 'threadId' in resume && resume.threadId).not.toBe('main');
  });

  it('stop during an approval wait ends the run without another turn', async () => {
    const { sessionId, turns } = loadRecording('preloaded-allow');
    const sessions = replaySessions(turns);
    const view = new RunViewBuilder();
    view.userMessage('go');
    let reached: () => void = () => undefined;
    const atApproval = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const run = new AgentRun({
      sessions,
      sessionId,
      view,
      decide: () => {
        reached();
        return new Promise(() => undefined);
      },
    });
    const sending = run.send('go');
    await atApproval;
    run.stop();
    expect(view.snapshot.statusText).toBe('Stopping…');
    const outcome = await sending;
    expect(outcome.status).toBe('cancelled');
    expect(sessions.inputs).toHaveLength(1);
    expect(view.snapshot.statusText).toBe('Cancelled, workspace unchanged');
    expect(tools(view.snapshot.items)[0]?.status).toBe('cancelled');
  });
});

describe('RunViewBuilder', () => {
  it('nests a subagent in place of its create_sub_agent card', async () => {
    const { sessionId, turns } = loadRecording('subagent-read');
    const view = new RunViewBuilder();
    view.userMessage('go');
    await new AgentRun({ sessions: replaySessions(turns), sessionId, view, decide: () => Promise.reject(new Error('no')) }).send('go');
    const items = view.snapshot.items;
    expect(items.some((item) => item.kind === 'tool' && item.name === 'create_sub_agent')).toBe(false);
    const thread = items.find((item): item is ThreadItem => item.kind === 'thread');
    expect(thread).toMatchObject({ title: 'helpers-reader-agent', done: true });
    expect(tools(thread?.items ?? [])[0]).toMatchObject({ name: 'read_file', status: 'done', threadId: thread?.id });
    expect(tools(thread?.items ?? [])[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('holds "Stopping…" against late events until the turn ends', () => {
    const view = new RunViewBuilder();
    view.userMessage('go');
    view.markStopping();
    view.apply(
      { type: 'tool.approval_required', id: 'x', createdAt: '', threadId: 'main', toolCalls: [] },
      { type: 'tool.approval_required', id: 'x', createdAt: '', threadId: 'main', toolCalls: [] },
    );
    expect(view.snapshot.status).toBe('stopping');
    view.applyOutcome({ status: 'cancelled', reason: 'client-cancelled' });
    expect(view.snapshot.status).toBe('cancelled');
  });

  it('shows a failure as a message and settles open cards', async () => {
    const { sessionId, turns } = loadRecording('error-429');
    const view = new RunViewBuilder();
    view.userMessage('go');
    await new AgentRun({ sessions: replaySessions(turns), sessionId, view, decide: () => Promise.reject(new Error('no')) }).send('go');
    expect(view.snapshot.status).toBe('error');
    expect(view.snapshot.error).toContain('Model quota exceeded (429)');
    expect(view.snapshot.statusText).toBe('Failed, workspace unchanged');
  });
});

describe('describeTurnError', () => {
  it.each([
    ['[Model Error] Request failed (401): Invalid API key provided.', 'auth', 'rejected the API key'],
    ['[Model Error] Request failed (403): Forbidden.', 'auth', 'rejected the API key'],
    ['[Model Error] Request failed (404): The model `x` does not exist or you do not have access to it.', 'model-not-found', 'Model not available'],
    ['[Model Error] Request failed (503): This model is currently experiencing high demand. Spikes in demand are usually temporary.', 'overloaded', 'high demand'],
    ["[Model Error] Request failed (400): 'messages.2' : property 'reasoning_content' is unsupported", 'bad-request', 'rejected the request'],
    ['connect ECONNREFUSED 127.0.0.1:8790', 'unreachable', 'TrueForge is not running'],
    ['Something odd', 'other', 'Something odd'],
  ])('%s', (raw, kind, phrase) => {
    const described = describeTurnError(raw);
    expect(described.kind).toBe(kind);
    expect(described.message).toContain(phrase);
    expect(described.message).not.toContain('[Model Error]');
    expect(described.raw).toBe(raw);
  });
});

describe('describeTurnError for billing', () => {
  it('says plainly that it is a billing refusal', () => {
    const raw = '[Model Error] Request failed (402): Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.';
    expect(describeTurnError(raw)).toMatchObject({
      kind: 'billing',
      httpStatus: 402,
      message: "The model provider's prepaid credits are depleted (402): Your prepayment credits are depleted. Top up the credit or switch to another provider.",
    });
  });
});
