import type { ReviewCard } from '../changeset/reviewFlow';
import type { ContextCard } from '../context/agentPrompt';
import { AgentRun, STOPPED_DURING_APPROVAL, type ApprovalDecision } from './agentRun';
import { describeTurnError, isConnectionFailure, trueForgeUnreachableMessage } from './errors';
import { RunViewBuilder, type RunView } from './runView';
import type { PendingApproval, SessionsApi, TurnEvent } from './turnRunner';

export interface AgentControllerOptions {
  baseUrl: () => string;
  agentName: string;
  sessions: () => SessionsApi;
  /** Creates a session for the named saved agent and returns its id. */
  createSession: (agentName: string) => Promise<string>;
  /** Runs before each request, so a stale or missing setup is fixed or explained. Returns the model. */
  ensureReady: () => Promise<string>;
  onChange: () => void;
  onEvent?: (event: TurnEvent) => void;
  /** Takes over an approval, such as opening the hunk review for apply_changes. Undefined leaves it to decide(). */
  reviewApproval?: (approval: PendingApproval, signal: AbortSignal) => Promise<ApprovalDecision> | undefined;
  /** True when an approval needs no person. It still goes through TrueForge as an allow. */
  autoApprove?: (approval: PendingApproval) => boolean;
  /** A stop, a failure or a new chat: whatever is staged will never be reviewed, so drop it. */
  discardStaged?: () => void;
  now?: () => number;
  /** Milliseconds between "Waiting for the model… 23 s" updates. */
  heartbeatMs?: number;
}

export interface SendOptions {
  /** Defaults to the panel's agent. A different agent gets its own session. */
  agentName?: string;
  /** What the panel shows, when the prompt itself is longer than a person wants to read. */
  display?: string;
  /** Always start a new session, because this request stands alone. */
  freshSession?: boolean;
  /** Builds what the agent receives from what the user typed, such as adding a Context Pack. */
  prepare?: (message: string) => Promise<{ prompt: string; card?: ContextCard }>;
  /** Runs after a finished turn, while Stop still works. A returned message is shown as a failure. */
  afterTurn?: (output: string, signal: AbortSignal) => Promise<string | undefined>;
}

interface WaitingApproval {
  resolve: (decision: ApprovalDecision) => void;
}

/** Owns the conversation behind the panel. Knows nothing about VS Code, so it can be tested headlessly. */
export class AgentController {
  private readonly builder: RunViewBuilder;
  private sessionId: string | undefined;
  private sessionModel: string | undefined;
  private sessionAgent: string | undefined;
  private afterTurnStop: AbortController | undefined;
  private run: AgentRun | undefined;
  private stopRequested = false;
  private busy = false;
  private readonly waiting = new Map<string, WaitingApproval>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: AgentControllerOptions) {
    this.builder = new RunViewBuilder(options.now);
  }

  get view(): RunView {
    return this.builder.snapshot;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  setModel(model: string | undefined): void {
    this.builder.setSession(model, this.view.sessionUrl);
    this.options.onChange();
  }

  updateReview(card: ReviewCard): void {
    this.builder.review(card);
    this.options.onChange();
  }

  /** Resolves when this request has fully ended. Never rejects; failures appear in the view. */
  async send(text: string, sendOptions: SendOptions = {}): Promise<void> {
    const message = text.trim();
    if (!message || this.busy) return;
    this.busy = true;
    this.stopRequested = false;
    this.builder.userMessage(sendOptions.display ?? message);
    this.options.onChange();
    const agentName = sendOptions.agentName ?? this.options.agentName;
    this.heartbeat = setInterval(() => {
      this.builder.heartbeat();
      this.options.onChange();
    }, this.options.heartbeatMs ?? 1000);

    let model: string;
    try {
      model = await this.options.ensureReady();
    } catch (error) {
      // Setup failures are already written for the user, including what to do next.
      this.builder.fail(error instanceof Error ? error.message : String(error));
      clearInterval(this.heartbeat);
      this.busy = false;
      this.options.onChange();
      return;
    }

    try {
      // A session keeps the model it started with, so a switch needs a new one.
      if (!this.sessionId || model !== this.sessionModel || agentName !== this.sessionAgent || sendOptions.freshSession) {
        this.sessionId = await this.options.createSession(agentName);
        this.sessionModel = model;
        this.sessionAgent = agentName;
      }
      this.builder.setSession(model, `${this.options.baseUrl()}/sessions/${this.sessionId}`);
      this.options.onChange();

      if (this.stopRequested) {
        this.builder.applyOutcome({ status: 'cancelled', reason: 'client-cancelled' });
        return;
      }
      let prompt = message;
      if (sendOptions.prepare) {
        const prepared = await sendOptions.prepare(message);
        prompt = prepared.prompt;
        if (prepared.card) this.builder.contextCard(prepared.card);
        this.options.onChange();
        if (this.stopRequested) {
          this.builder.applyOutcome({ status: 'cancelled', reason: 'client-cancelled' });
          return;
        }
      }
      this.run = new AgentRun({
        sessions: this.options.sessions(),
        sessionId: this.sessionId,
        baseUrl: this.options.baseUrl(),
        view: this.builder,
        decide: (approval, signal) => this.waitForDecision(approval, signal),
        onChange: this.options.onChange,
        ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      });
      const outcome = await this.run.send(prompt);
      if (outcome.status === 'cancelled' || outcome.status === 'error') this.options.discardStaged?.();
      if (outcome.status === 'cancelled' && outcome.reason === STOPPED_DURING_APPROVAL) this.sessionId = undefined;
      if (outcome.status === 'done' && sendOptions.afterTurn && !this.stopRequested) {
        await this.runAfterTurn(outcome.output, sendOptions.afterTurn);
      }
    } catch (error) {
      this.options.discardStaged?.();
      const raw = error instanceof Error ? error.message : String(error);
      this.builder.fail(isConnectionFailure(raw) ? trueForgeUnreachableMessage(this.options.baseUrl()) : describeTurnError(raw).message);
    } finally {
      clearInterval(this.heartbeat);
      this.run = undefined;
      this.busy = false;
      this.waiting.clear();
      this.options.onChange();
    }
  }

  private async runAfterTurn(output: string, afterTurn: NonNullable<SendOptions['afterTurn']>): Promise<void> {
    this.afterTurnStop = new AbortController();
    const { signal } = this.afterTurnStop;
    const problem = await afterTurn(output, signal);
    this.afterTurnStop = undefined;
    if (problem) this.builder.fail(problem);
    else this.builder.finishLocalWork(signal.aborted);
  }

  /** Updates the view at once. The promise settles when the server has been told. */
  stop(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    this.stopRequested = true;
    this.builder.markStopping();
    this.options.onChange();
    this.options.discardStaged?.();
    this.afterTurnStop?.abort();
    return this.run?.stop() ?? Promise.resolve();
  }

  decide(toolCallId: string, allow: boolean): void {
    const waiting = this.waiting.get(toolCallId);
    if (!waiting) return;
    this.waiting.delete(toolCallId);
    waiting.resolve(allow ? { allow: true } : { allow: false, reason: 'The user declined this tool call.' });
  }

  newChat(): void {
    if (this.busy) return;
    this.sessionId = undefined;
    this.sessionModel = undefined;
    this.sessionAgent = undefined;
    this.options.discardStaged?.();
    this.builder.reset();
    this.options.onChange();
  }

  private waitForDecision(approval: PendingApproval, signal: AbortSignal): Promise<ApprovalDecision> {
    if (this.options.autoApprove?.(approval)) {
      this.builder.toolAutoApproved(approval.toolCallId);
      return Promise.resolve({ allow: true });
    }
    const reviewed = this.options.reviewApproval?.(approval, signal);
    if (reviewed) return reviewed;
    return new Promise((resolve) => {
      this.waiting.set(approval.toolCallId, { resolve });
      signal.addEventListener('abort', () => this.waiting.delete(approval.toolCallId), { once: true });
    });
  }
}
