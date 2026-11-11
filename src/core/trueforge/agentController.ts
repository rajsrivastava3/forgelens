import type { ReviewCard } from '../changeset/reviewFlow';
import type { ContextCard } from '../context/agentPrompt';
import type { PlanStep } from '../context/plan';
import { AgentRun, STOPPED_DURING_APPROVAL, type ApprovalDecision } from './agentRun';
import { describeTurnError, failureAction, isConnectionFailure, shortReason, trueForgeUnreachableMessage, type DescribedTurnError } from './errors';
import { RunViewBuilder, type RunView } from './runView';
import type { PendingApproval, SessionsApi, TurnEvent, TurnOutcome } from './turnRunner';

export interface AgentControllerOptions {
  baseUrl: () => string;
  agentName: string;
  sessions: () => SessionsApi;
  /** Creates a session for the named agent on this model and returns its id. */
  createSession: (agentName: string, model: string) => Promise<string>;
  /** Models to try, in order. The first is the primary. Defaults to the model setup chose. */
  models?: () => readonly string[];
  /** No model output within this long ends the attempt as a timeout. Only before the first output. */
  firstTokenMs?: number;
  /** Waits before each retry of the same model. Jitter is added. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Runs before each request, so a stale or missing setup is fixed or explained. Returns the model. */
  ensureReady: () => Promise<string>;
  onChange: () => void;
  onEvent?: (event: TurnEvent) => void;
  /** Takes over an approval, such as opening the hunk review for apply_changes. Undefined leaves it to decide(). */
  reviewApproval?: (approval: PendingApproval, signal: AbortSignal) => Promise<ApprovalDecision> | undefined;
  /** Called as each turn starts, before it is sent: a request's first turn, a follow-up, a retry. */
  onTurnStart?: (readLimit: number | undefined) => void;
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
  /**
   * Reads a finished first turn and may ask for one more in the same session, such as carrying out the plan the
   * first turn ended with. Not asked when the first turn already opened a review.
   */
  followUp?: (output: string) => { prompt: string; plan?: PlanStep[] } | undefined;
  /** How many reads and searches the first turn may make. A follow-up turn gets the usual limit. */
  firstTurnReadLimit?: number;
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
  private model: string | undefined;
  private wakeFromSleep: (() => void) | undefined;

  constructor(private readonly options: AgentControllerOptions) {
    this.builder = new RunViewBuilder(options.now);
  }

  get view(): RunView {
    return this.builder.snapshot;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** The model of the current or last request, which differs from the primary after a fallback. */
  get activeModel(): string | undefined {
    return this.model;
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
      let prompt = message;
      if (sendOptions.prepare) {
        const prepared = await sendOptions.prepare(message);
        prompt = prepared.prompt;
        if (prepared.card) this.builder.contextCard(prepared.card);
        this.options.onChange();
      }
      const chain = [...new Set([model, ...(this.options.models?.() ?? [])])].filter((name, index, all) => index === 0 || all.indexOf(name) === index);
      await this.runChain(chain, agentName, prompt, sendOptions);
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

  /** Tries each model in turn, retrying the ones whose failure may pass. The same prompt and Context Pack go to each. */
  private async runChain(chain: readonly string[], agentName: string, prompt: string, sendOptions: SendOptions, freshPrompt?: string): Promise<void> {
    const delays = this.options.retryDelaysMs ?? [1_000, 3_000];
    for (let index = 0; index < chain.length; index += 1) {
      const model = chain[index] as string;
      for (let attempt = 0; ; attempt += 1) {
        if (this.stopRequested) {
          this.builder.applyOutcome({ status: 'cancelled', reason: 'client-cancelled' });
          return;
        }
        const fresh = index > 0 || attempt > 0 || sendOptions.freshSession === true;
        // A follow-up turn that has to start a new session carries what the old one knew: the request and the plan.
        const sent = fresh && freshPrompt ? freshPrompt : prompt;
        const result = await this.attempt(model, agentName, sent, fresh, sendOptions.firstTurnReadLimit);
        // Once accepted hunks are on disk, a later failure must not undo them or start another model: the
        // change stays, the run ends with a note, and Undo is there.
        const applied = this.builder.appliedThisRequest();
        if (applied && ((result.kind === 'outcome' && result.outcome.status === 'error') || result.kind === 'failed')) {
          const error = result.kind === 'failed' ? result.error : result.outcome.status === 'error' ? result.outcome.error : undefined;
          this.builder.settleAfterApply(error ? shortReason(error) : 'unknown error');
          return;
        }
        if (result.kind === 'outcome') {
          const { outcome } = result;
          if (outcome.status === 'cancelled' || outcome.status === 'error') this.options.discardStaged?.();
          if (outcome.status === 'cancelled' && outcome.reason === STOPPED_DURING_APPROVAL) this.sessionId = undefined;
          if (outcome.status === 'done' && sendOptions.followUp && !this.stopRequested && !this.builder.reviewedThisRequest()) {
            const next = sendOptions.followUp(outcome.output);
            if (next) {
              if (next.plan) this.builder.planCard(next.plan);
              this.options.onChange();
              const replay = `${sent}\n\n## Your plan, from the turn before\n${outcome.output}\n\n${next.prompt}`;
              await this.runChain(chain.slice(index), agentName, next.prompt, { ...sendOptions, followUp: undefined, freshSession: false, firstTurnReadLimit: undefined }, replay);
              return;
            }
          }
          if (outcome.status === 'done' && sendOptions.afterTurn && !this.stopRequested) {
            await this.runAfterTurn(outcome.output, sendOptions.afterTurn);
          }
          return;
        }

        // The attempt failed. Whatever it staged will never be reviewed.
        this.options.discardStaged?.();
        const { error } = result;
        const action = failureAction(error);
        // Names without their provider keep notices on one or two lines; the role says which model it was.
        const short = (name: string): string => name.split('/').pop() ?? name;
        const who = index === 0 ? 'Primary model' : `Fallback model ${short(model)}`;
        if (action === 'stop') {
          this.builder.fail(error.message);
          return;
        }
        if (action === 'retry' && attempt < delays.length) {
          const wait = Math.round((delays[attempt] ?? 1_000) * (0.8 + Math.random() * 0.4));
          this.builder.retrying(`${who}: ${shortReason(error)}. Trying again in ${Math.max(1, Math.round(wait / 1000))} s…`);
          this.options.onChange();
          await this.pause(wait);
          continue;
        }
        const next = chain[index + 1];
        if (next) {
          this.builder.fallback(`${who} failed: ${shortReason(error)}. Switched to ${short(next)} automatically.`);
          this.options.onChange();
          break;
        }
        this.builder.fail(
          chain.length > 1 ? `Every configured model failed. The last, ${model}: ${error.message}` : error.message,
          'switch-model',
        );
        return;
      }
    }
  }

  /** One request to one model. A failure the chain can act on comes back as an error, not an outcome. */
  private async attempt(
    model: string,
    agentName: string,
    prompt: string,
    fresh: boolean,
    readLimit?: number,
  ): Promise<{ kind: 'outcome'; outcome: TurnOutcome } | { kind: 'failed'; error: DescribedTurnError }> {
    this.model = model;
    this.options.onTurnStart?.(readLimit);
    // A session keeps the model it started with, so a switch needs a new one.
    if (fresh || !this.sessionId || model !== this.sessionModel || agentName !== this.sessionAgent) {
      this.sessionId = await this.options.createSession(agentName, model);
      this.sessionModel = model;
      this.sessionAgent = agentName;
    }
    this.builder.setSession(model, `${this.options.baseUrl()}/sessions/${this.sessionId}`);
    this.options.onChange();

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = new AgentRun({
      sessions: this.options.sessions(),
      sessionId: this.sessionId,
      baseUrl: this.options.baseUrl(),
      view: this.builder,
      decide: (approval, signal) => this.waitForDecision(approval, signal),
      onChange: this.options.onChange,
      onEvent: (event) => {
        // The first output proves the model is answering; after that, slowness is not a failure.
        if (timer && event.type === 'model.message' && ((event.toolCalls?.length ?? 0) > 0 || (typeof event.content === 'string' && event.content.length > 0))) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (timer && event.type === 'model.message.delta') {
          clearTimeout(timer);
          timer = undefined;
        }
        this.options.onEvent?.(event);
      },
    });
    this.run = run;
    if (this.options.firstTokenMs) {
      timer = setTimeout(() => {
        timedOut = true;
        void run.cancelForRetry();
      }, this.options.firstTokenMs);
    }
    try {
      const outcome = await run.send(prompt);
      if (timedOut && !this.stopRequested) {
        return { kind: 'failed', error: { kind: 'timeout', httpStatus: undefined, message: `${model} did not answer within ${Math.round((this.options.firstTokenMs ?? 0) / 1000)} s.`, raw: 'first-token timeout' } };
      }
      if (outcome.status === 'error') return { kind: 'failed', error: outcome.error };
      return { kind: 'outcome', outcome };
    } finally {
      clearTimeout(timer);
      this.run = undefined;
    }
  }

  private pause(ms: number): Promise<void> {
    const sleep = this.options.sleep ?? ((wait: number) => new Promise<void>((resolve) => setTimeout(resolve, wait)));
    return new Promise<void>((resolve) => {
      this.wakeFromSleep = resolve;
      void sleep(ms).then(() => resolve());
    }).then(() => {
      this.wakeFromSleep = undefined;
    });
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
    this.wakeFromSleep?.();
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
