import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { ReviewCard } from '../changeset/reviewFlow';
import type { ContextCard } from '../context/agentPrompt';
import { resolveToolCall, shortArgs } from './toolCalls';
import { messageText, type TurnEvent, type TurnOutcome } from './turnRunner';

export type ToolStatus = 'running' | 'awaiting-approval' | 'done' | 'error' | 'denied' | 'cancelled';
export type RunStatus = 'idle' | 'running' | 'stopping' | 'awaiting-approval' | 'done' | 'cancelled' | 'error';

export interface ToolItem {
  kind: 'tool';
  id: string;
  threadId: string;
  name: string;
  server: string | undefined;
  argsSummary: string;
  args: Record<string, unknown>;
  system: boolean;
  viaCallTool: boolean;
  /** Allowed by the safe list rather than a person. */
  autoApproved?: boolean;
  status: ToolStatus;
  durationMs: number | undefined;
  result: string | undefined;
}

export interface TextItem {
  kind: 'text';
  id: string;
  text: string;
}

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
}

export interface ThreadItem {
  kind: 'thread';
  id: string;
  title: string;
  done: boolean;
  items: ViewItem[];
}

export interface ReviewItem extends ReviewCard {
  kind: 'review';
}

export interface ContextItem extends ContextCard {
  kind: 'context';
  id: string;
}

/** Something the harness did on its own, shown so it does not look like a stall. */
export interface NoticeItem {
  kind: 'notice';
  id: string;
  text: string;
}

export type ViewItem = ToolItem | TextItem | UserItem | ThreadItem | ReviewItem | ContextItem | NoticeItem;

export interface RunView {
  status: RunStatus;
  /** Short status line under the transcript. */
  statusText: string;
  error: string | undefined;
  model: string | undefined;
  sessionUrl: string | undefined;
  items: ViewItem[];
}

const MAX_RESULT_CHARS = 4_000;
const RESULT_HEAD_CHARS = 1_000;
const WAITING_TEXT = 'Waiting for the model…';

/** Pure: turns TurnRunner events into what the panel shows. Replaying a recording gives the same view. */
export class RunViewBuilder {
  private view: RunView = {
    status: 'idle',
    statusText: '',
    error: undefined,
    model: undefined,
    sessionUrl: undefined,
    items: [],
  };
  private readonly threadItems = new Map<string, ViewItem[]>();
  private readonly threadById = new Map<string, ThreadItem>();
  private readonly toolById = new Map<string, ToolItem>();
  private readonly toolStartedAt = new Map<string, number>();
  private readonly textById = new Map<string, TextItem>();
  private readonly reviewById = new Map<string, ReviewItem>();
  private turnCounter = 0;
  /** Since when the model has been silent; undefined while it is producing output or a tool is running. */
  private waitingSince: number | undefined;
  /** Set when this request wrote to disk, because then "workspace unchanged" would be false. */
  private appliedText: string | undefined;

  constructor(private readonly now: () => number = Date.now) {
    this.threadItems.set('main', this.view.items);
  }

  get snapshot(): RunView {
    return this.view;
  }

  setSession(model: string | undefined, sessionUrl: string | undefined): void {
    this.view.model = model;
    this.view.sessionUrl = sessionUrl;
  }

  /** Work after the agent's turn, such as a review ForgeLens opened itself, has finished. */
  finishLocalWork(stopped: boolean): void {
    this.applyOutcome(stopped ? { status: 'cancelled', reason: 'client-cancelled' } : { status: 'done', output: '' });
  }

  /** Clears the transcript for a new conversation; the model stays. */
  reset(): void {
    this.view.items.length = 0;
    this.threadItems.clear();
    this.threadItems.set('main', this.view.items);
    this.threadById.clear();
    this.toolById.clear();
    this.toolStartedAt.clear();
    this.textById.clear();
    this.reviewById.clear();
    this.waitingSince = undefined;
    this.appliedText = undefined;
    this.view.sessionUrl = undefined;
    this.setStatus('idle', '');
    this.view.error = undefined;
  }

  userMessage(text: string): void {
    this.turnCounter += 1;
    this.view.items.push({ kind: 'user', id: `user-${this.turnCounter}`, text });
    this.view.error = undefined;
    this.appliedText = undefined;
    this.waitingSince = this.now();
    this.setStatus('running', WAITING_TEXT);
  }

  /** Called about once a second, so a slow model step shows a live count rather than looking hung. */
  heartbeat(): void {
    if (this.waitingSince === undefined || this.view.status !== 'running') return;
    const seconds = Math.floor((this.now() - this.waitingSince) / 1000);
    this.setStatus('running', seconds >= 1 ? `${WAITING_TEXT} ${seconds} s` : WAITING_TEXT);
  }

  /** Shows what the Context Pack holds, right under the request it belongs to. */
  contextCard(card: ContextCard): void {
    this.view.items.push({ kind: 'context', id: `context-${this.turnCounter}`, ...card });
  }

  toolAutoApproved(toolCallId: string): void {
    const tool = this.toolById.get(toolCallId);
    if (tool) tool.autoApproved = true;
  }

  /** Adds or updates the card for a review. */
  review(card: ReviewCard): void {
    let item = this.reviewById.get(card.id);
    if (!item) {
      item = { kind: 'review', ...card };
      this.reviewById.set(card.id, item);
      this.view.items.push(item);
    } else {
      Object.assign(item, card);
    }
    if (card.phase === 'reviewing') this.setStatus('awaiting-approval', 'Waiting for your review');
    if (card.phase === 'applied' && card.accepted > 0) this.appliedText = card.text;
    if (card.phase === 'undone' || card.phase === 'failed') this.appliedText = undefined;
  }

  markStopping(): void {
    if (this.isActive()) this.setStatus('stopping', 'Stopping…');
  }

  /** The user decided: an allowed call starts timing now, not when the model asked. */
  approvalDecided(toolCallId: string, allow: boolean): void {
    const tool = this.toolById.get(toolCallId);
    if (tool) {
      tool.status = allow ? 'running' : 'denied';
      if (allow) this.toolStartedAt.set(toolCallId, this.now());
    }
    this.waitingSince = allow ? undefined : this.now();
    this.setStatus('running', allow ? 'Running the approved tool…' : 'Telling the model you declined…');
  }

  apply(event: TurnEvent, current: TurnEvent): void {
    switch (event.type) {
      case 'model.message':
      case 'model.message.delta':
        if (current.type === 'model.message') this.applyMessage(current);
        break;
      case 'thread.created':
        this.applyThreadCreated(event);
        break;
      case 'thread.done': {
        const thread = this.threadById.get(event.threadId);
        if (thread) thread.done = true;
        break;
      }
      case 'tool.response':
        this.applyToolResponse(event);
        break;
      case 'thread.context_compaction_started':
        this.notice(event.threadId, 'Compacting the conversation to free up context…');
        break;
      case 'thread.context_compaction_finished':
        this.notice(event.threadId, 'Compacted the conversation to free up context.');
        break;
      case 'tool.approval_required':
        for (const ref of event.toolCalls) {
          const tool = this.toolById.get(ref.id);
          if (tool) tool.status = 'awaiting-approval';
        }
        this.waitingSince = undefined;
        this.setStatus('awaiting-approval', 'Waiting for your approval');
        break;
      default:
        break;
    }
  }

  applyOutcome(outcome: TurnOutcome): void {
    this.waitingSince = undefined;
    switch (outcome.status) {
      case 'done':
        this.settleTools();
        this.setStatus('done', 'Done');
        break;
      case 'paused':
        this.setStatus('awaiting-approval', 'Waiting for your approval');
        break;
      case 'cancelled':
        this.settleTools();
        // Nothing can touch disk without a reviewed apply, so a stop never leaves partial edits.
        this.setStatus(
          'cancelled',
          this.appliedText ? `Cancelled. ${this.appliedText} before you stopped; Undo reverts them` : 'Cancelled, workspace unchanged',
        );
        break;
      case 'error':
        this.settleTools();
        this.view.error = outcome.error.message;
        this.setStatus('error', this.failureText());
        break;
    }
  }

  fail(message: string): void {
    this.settleTools();
    this.waitingSince = undefined;
    this.view.error = message;
    this.setStatus('error', this.failureText());
  }

  private failureText(): string {
    return this.appliedText ? `Failed after this was applied: ${this.appliedText}` : 'Failed, workspace unchanged';
  }

  private notice(threadId: string, text: string): void {
    const id = `compaction-${this.turnCounter}-${threadId}`;
    const existing = this.view.items.find((item): item is NoticeItem => item.kind === 'notice' && item.id === id);
    if (existing) existing.text = text;
    else this.view.items.push({ kind: 'notice', id, text });
  }

  private isActive(): boolean {
    return this.view.status === 'running' || this.view.status === 'awaiting-approval';
  }

  private setStatus(status: RunStatus, statusText: string): void {
    // Once the user pressed Stop, in-flight events must not flip the status back.
    if (this.view.status === 'stopping' && status !== 'cancelled' && status !== 'error' && status !== 'done') return;
    this.view.status = status;
    this.view.statusText = statusText;
  }

  private itemsFor(threadId: string): ViewItem[] {
    let items = this.threadItems.get(threadId);
    if (!items) {
      items = [];
      this.threadItems.set(threadId, items);
      const thread: ThreadItem = { kind: 'thread', id: threadId, title: threadId, done: false, items };
      this.threadById.set(threadId, thread);
      this.view.items.push(thread);
    }
    return items;
  }

  private applyMessage(message: TrueForgeApi.ModelMessageEvent): void {
    const items = this.itemsFor(message.threadId);
    const text = messageText(message.content);
    if (text) {
      let item = this.textById.get(message.id);
      if (!item) {
        item = { kind: 'text', id: message.id, text };
        this.textById.set(message.id, item);
        items.push(item);
      }
      item.text = text;
    }
    const calls = (message.toolCalls ?? []).filter((call) => call.id);
    // An empty shell announces a message but is not output, so the count keeps going until something real arrives.
    if (text || calls.length > 0) this.waitingSince = undefined;
    if (this.view.status === 'running' && this.waitingSince === undefined) {
      this.setStatus('running', calls.length > 0 ? 'Running tools…' : 'Streaming…');
    }

    for (const call of message.toolCalls ?? []) {
      if (!call.id) continue;
      const resolved = resolveToolCall(call);
      let tool = this.toolById.get(call.id);
      if (!tool) {
        tool = {
          kind: 'tool',
          id: call.id,
          threadId: message.threadId,
          name: resolved.name,
          server: resolved.server,
          argsSummary: '',
          args: {},
          system: resolved.system,
          viaCallTool: resolved.viaCallTool,
          status: 'running',
          durationMs: undefined,
          result: undefined,
        };
        this.toolById.set(call.id, tool);
        items.push(tool);
      }
      // The call is ready when the model finishes writing it, which is the last time it changes. Timing from
      // the message's start would count the model's own thinking as tool time.
      if (tool.status === 'running') this.toolStartedAt.set(call.id, this.now());
      tool.name = resolved.name;
      tool.server = resolved.server;
      tool.args = resolved.args;
      tool.argsSummary = shortArgs(resolved.args);
      tool.system = resolved.system;
      tool.viaCallTool = resolved.viaCallTool;
    }
  }

  private applyThreadCreated(event: TrueForgeApi.ThreadCreatedEvent): void {
    const parentItems = this.itemsFor(event.parent.threadId);
    const items = this.threadItems.get(event.threadId) ?? [];
    this.threadItems.set(event.threadId, items);
    const thread: ThreadItem = { kind: 'thread', id: event.threadId, title: event.title, done: false, items };
    this.threadById.set(event.threadId, thread);

    // The thread replaces the card of the create_sub_agent call that spawned it.
    const spawnIndex = parentItems.findIndex((item) => item.kind === 'tool' && item.id === event.parent.toolCallId);
    if (spawnIndex >= 0) parentItems.splice(spawnIndex, 1, thread);
    else parentItems.push(thread);
  }

  private applyToolResponse(event: TrueForgeApi.ToolResponseEvent): void {
    const tool = this.toolById.get(event.toolCallId);
    if (!tool) return;
    const content = event.content;
    tool.status = /User denied tool call/.test(content)
      ? 'denied'
      : /^(Error:|\{"error")/.test(content.trimStart())
        ? 'error'
        : 'done';
    // Both ends: what ran is at the start of a long result, and a test summary is at its end.
    tool.result =
      content.length > MAX_RESULT_CHARS
        ? `${content.slice(0, RESULT_HEAD_CHARS)}\n[shortened for display]\n${content.slice(-(MAX_RESULT_CHARS - RESULT_HEAD_CHARS))}`
        : content;
    const started = this.toolStartedAt.get(event.toolCallId);
    tool.durationMs = started === undefined ? undefined : Math.max(0, this.now() - started);
    // Once no tool is still running, the turn is waiting on the model again.
    const toolRunning = [...this.toolById.values()].some((other) => other.status === 'running');
    if (!toolRunning && this.view.status === 'running') {
      this.waitingSince = this.now();
      this.setStatus('running', WAITING_TEXT);
    }
  }

  /** Cards still spinning when a turn ends will never hear back. */
  private settleTools(): void {
    for (const tool of this.toolById.values()) {
      if (tool.status === 'running' || tool.status === 'awaiting-approval') tool.status = 'cancelled';
    }
    for (const thread of this.threadById.values()) thread.done = true;
  }
}
