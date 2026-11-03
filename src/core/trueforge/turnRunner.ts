import { isEventDelta, mergeEventDelta, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describeTurnError, type DescribedTurnError } from './errors';
import { resolveToolCall, type ResolvedToolCall } from './toolCalls';

export type TurnEvent = TrueForgeApi.TurnStreamingEvent;
export type TurnInput = TrueForgeApi.TurnInputItem;

export interface TurnStream {
  withMetadata(): AsyncIterable<{ data: TurnEvent; id?: string | undefined }>;
}

/** The part of the TrueForge client a runner uses. A recorded replay can stand in for it in tests. */
export interface SessionsApi {
  createTurnStream(
    sessionId: string,
    request: { input: TurnInput[] },
    options?: { abortSignal?: AbortSignal; timeoutInSeconds?: number },
  ): PromiseLike<TurnStream>;
  cancel(sessionId: string): PromiseLike<unknown>;
}

export interface PendingApproval {
  threadId: string;
  /** Provider id of the paused tool call. */
  toolCallId: string;
  call: ResolvedToolCall;
}

export type TurnOutcome =
  | { status: 'done'; output: string; metrics?: TrueForgeApi.TurnMetrics | undefined }
  | { status: 'paused'; approvals: PendingApproval[] }
  | { status: 'cancelled'; reason: string }
  | { status: 'error'; error: DescribedTurnError };

export interface ThreadGroup {
  threadId: string;
  title: string;
  /** Tool call that spawned this thread, in the parent thread. */
  parent: { threadId: string; toolCallId: string } | undefined;
  done: boolean;
  eventIds: string[];
}

export interface TurnRunnerOptions {
  sessions: SessionsApi;
  sessionId: string;
  baseUrl?: string;
  /** Called for every event, deltas already merged into `current`. */
  onEvent?: (event: TurnEvent, current: TurnEvent) => void;
  /** How long Stop waits for the stream to end by itself before abandoning it. */
  cancelGraceMs?: number;
}

const DEFAULT_CANCEL_GRACE_MS = 15_000;
const TURN_STREAM_TIMEOUT_S = 600;

export function messageText(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : ''))
    .join('');
}

/**
 * One session's turns: the event index, delta merging, per-thread grouping, pause detection and
 * cancellation. Cancel asks the server and lets the stream end itself, because TrueForge finishes
 * running tool calls before it closes; a timer abandons the stream only if the server never answers.
 */
export class TurnRunner {
  readonly events = new Map<string, TurnEvent>();
  readonly threads = new Map<string, ThreadGroup>();

  private readonly sessions: SessionsApi;
  private readonly sessionId: string;
  private readonly baseUrl: string | undefined;
  private readonly onEvent: TurnRunnerOptions['onEvent'];
  private readonly cancelGraceMs: number;
  private activeTurn: AbortController | undefined;
  private cancelling = false;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: TurnRunnerOptions) {
    this.sessions = options.sessions;
    this.sessionId = options.sessionId;
    this.baseUrl = options.baseUrl;
    this.onEvent = options.onEvent;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  }

  get running(): boolean {
    return this.activeTurn !== undefined;
  }

  /** Runs one turn to its end. Never rejects: failures come back as an outcome. */
  async runTurn(input: TurnInput[]): Promise<TurnOutcome> {
    const abort = new AbortController();
    this.activeTurn = abort;
    this.cancelling = false;
    const pending: PendingApproval[] = [];
    let outcome: TurnOutcome | undefined;

    try {
      const stream = await this.sessions.createTurnStream(
        this.sessionId,
        { input },
        { abortSignal: abort.signal, timeoutInSeconds: TURN_STREAM_TIMEOUT_S },
      );
      for await (const { data: event } of stream.withMetadata()) {
        const current = this.index(event);
        if (event.type === 'tool.approval_required') {
          for (const ref of event.toolCalls) {
            const approval = this.resolveApproval(event.threadId, ref);
            if (approval) pending.push(approval);
          }
        }
        if (event.type === 'turn.done') outcome = this.outcomeFrom(event, pending);
        this.onEvent?.(event, current);
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      outcome = this.cancelling
        ? { status: 'cancelled', reason: 'abandoned-by-client' }
        : { status: 'error', error: describeTurnError(raw, this.baseUrl) };
    } finally {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
      this.activeTurn = undefined;
    }

    if (outcome) return outcome;
    return this.cancelling
      ? { status: 'cancelled', reason: 'stream-ended' }
      : { status: 'error', error: describeTurnError('The event stream ended before the turn finished.', this.baseUrl) };
  }

  /** Safe to call at any time, repeatedly. Resolves once the server has been asked. */
  async cancel(): Promise<void> {
    if (this.cancelling) return;
    this.cancelling = true;
    const active = this.activeTurn;
    if (active) {
      this.graceTimer = setTimeout(() => active.abort(), this.cancelGraceMs);
    }
    try {
      await this.sessions.cancel(this.sessionId);
    } catch {
      active?.abort(); // The server cannot be told, so stop reading now.
    }
  }

  private index(event: TurnEvent): TurnEvent {
    if (isEventDelta(event)) {
      const base = this.events.get(event.id);
      if (base) {
        mergeEventDelta(base, event);
        return base;
      }
      return event;
    }
    this.events.set(event.id, event);
    if (event.type === 'thread.created') {
      this.threads.set(event.threadId, {
        threadId: event.threadId,
        title: event.title,
        parent: { threadId: event.parent.threadId, toolCallId: event.parent.toolCallId },
        done: false,
        eventIds: [],
      });
    }
    const threadId = 'threadId' in event ? event.threadId : null;
    if (typeof threadId === 'string') {
      const group = this.threads.get(threadId) ?? {
        threadId,
        title: threadId,
        parent: undefined,
        done: false,
        eventIds: [],
      };
      group.eventIds.push(event.id);
      if (event.type === 'thread.done') group.done = true;
      this.threads.set(threadId, group);
    }
    return event;
  }

  private resolveApproval(threadId: string, ref: TrueForgeApi.ToolCallRef): PendingApproval | undefined {
    const message = this.events.get(ref.sourceEventId);
    if (message?.type !== 'model.message') return undefined;
    const call = message.toolCalls?.find((candidate) => candidate.id === ref.id);
    return call ? { threadId, toolCallId: ref.id, call: resolveToolCall(call) } : undefined;
  }

  private outcomeFrom(event: TrueForgeApi.TurnDoneEvent, pending: PendingApproval[]): TurnOutcome {
    const state = event.state;
    if (state.status === 'error') {
      return { status: 'error', error: describeTurnError(state.message, this.baseUrl) };
    }
    if (state.status === 'cancelled') return { status: 'cancelled', reason: state.reason };
    if (pending.length > 0) return { status: 'paused', approvals: pending };
    return { status: 'done', output: messageText(state.output?.content), metrics: state.metrics };
  }
}
