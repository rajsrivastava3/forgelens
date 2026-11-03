import { AgentRun, type ApprovalDecision } from './agentRun';
import { describeTurnError, isConnectionFailure, trueForgeUnreachableMessage } from './errors';
import { RunViewBuilder, type RunView } from './runView';
import type { PendingApproval, SessionsApi, TurnEvent } from './turnRunner';

export interface AgentControllerOptions {
  baseUrl: () => string;
  agentName: string;
  sessions: () => SessionsApi;
  /** Creates a session for the saved agent and returns its id. */
  createSession: () => Promise<string>;
  /** Runs before each request, so a stale or missing setup is fixed or explained. Returns the model. */
  ensureReady: () => Promise<string>;
  onChange: () => void;
  onEvent?: (event: TurnEvent) => void;
  now?: () => number;
}

interface WaitingApproval {
  resolve: (decision: ApprovalDecision) => void;
}

/** Owns the conversation behind the panel. Knows nothing about VS Code, so it can be tested headlessly. */
export class AgentController {
  private readonly builder: RunViewBuilder;
  private sessionId: string | undefined;
  private sessionModel: string | undefined;
  private run: AgentRun | undefined;
  private stopRequested = false;
  private busy = false;
  private readonly waiting = new Map<string, WaitingApproval>();

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

  /** Resolves when this request has fully ended. Never rejects; failures appear in the view. */
  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.busy) return;
    this.busy = true;
    this.stopRequested = false;
    this.builder.userMessage(message);
    this.options.onChange();

    let model: string;
    try {
      model = await this.options.ensureReady();
    } catch (error) {
      // Setup failures are already written for the user, including what to do next.
      this.builder.fail(error instanceof Error ? error.message : String(error));
      this.busy = false;
      this.options.onChange();
      return;
    }

    try {
      // A session keeps the model it started with, so a switch needs a new one.
      if (!this.sessionId || model !== this.sessionModel) {
        this.sessionId = await this.options.createSession();
        this.sessionModel = model;
      }
      this.builder.setSession(model, `${this.options.baseUrl()}/sessions/${this.sessionId}`);
      this.options.onChange();

      if (this.stopRequested) {
        this.builder.applyOutcome({ status: 'cancelled', reason: 'client-cancelled' });
        return;
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
      await this.run.send(message);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      this.builder.fail(isConnectionFailure(raw) ? trueForgeUnreachableMessage(this.options.baseUrl()) : describeTurnError(raw).message);
    } finally {
      this.run = undefined;
      this.busy = false;
      this.waiting.clear();
      this.options.onChange();
    }
  }

  stop(): void {
    if (!this.busy) return;
    this.stopRequested = true;
    this.builder.markStopping();
    this.options.onChange();
    this.run?.stop();
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
    this.builder.reset();
    this.options.onChange();
  }

  private waitForDecision(approval: PendingApproval, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      this.waiting.set(approval.toolCallId, { resolve });
      signal.addEventListener('abort', () => this.waiting.delete(approval.toolCallId), { once: true });
    });
  }
}
