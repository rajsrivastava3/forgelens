import { RunViewBuilder } from './runView';
import { TurnRunner, type PendingApproval, type SessionsApi, type TurnEvent, type TurnOutcome } from './turnRunner';

export type ApprovalDecision = { allow: true } | { allow: false; reason: string };

export interface AgentRunOptions {
  sessions: SessionsApi;
  sessionId: string;
  baseUrl?: string;
  view: RunViewBuilder;
  /** Asks the human. Rejecting or never settling is fine: stop() ends the wait. */
  decide: (approval: PendingApproval, signal: AbortSignal) => Promise<ApprovalDecision>;
  onChange?: () => void;
  onEvent?: (event: TurnEvent) => void;
  cancelGraceMs?: number;
}

/** One user request in a session: runs turns until the agent finishes, resuming after each approval. */
export class AgentRun {
  private readonly runner: TurnRunner;
  private readonly stopController = new AbortController();

  constructor(private readonly options: AgentRunOptions) {
    this.runner = new TurnRunner({
      sessions: options.sessions,
      sessionId: options.sessionId,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
      onEvent: (event, current) => {
        options.view.apply(event, current);
        options.onEvent?.(event);
        options.onChange?.();
      },
    });
  }

  get stopped(): boolean {
    return this.stopController.signal.aborted;
  }

  async send(message: string): Promise<TurnOutcome> {
    let outcome = await this.runner.runTurn([{ type: 'user.message', content: message }]);
    while (outcome.status === 'paused') {
      this.options.view.applyOutcome(outcome);
      this.options.onChange?.();

      const decisions = await this.collectDecisions(outcome.approvals);
      // A stop during the pause needs no server call: the turn has ended and nothing is running.
      if (!decisions) {
        outcome = { status: 'cancelled', reason: 'client-cancelled' };
        break;
      }
      outcome = await this.runner.runTurn(
        decisions.map(({ approval, decision }) => ({
          type: 'user.tool_approval' as const,
          threadId: approval.threadId,
          toolCallId: approval.toolCallId,
          approval: decision.allow ? { status: 'allow' as const } : { status: 'deny' as const, reason: decision.reason },
        })),
      );
    }
    this.options.view.applyOutcome(outcome);
    this.options.onChange?.();
    return outcome;
  }

  /** Returns at once; the view shows "Stopping…" straight away and the stream then ends by itself. */
  stop(): void {
    if (this.stopController.signal.aborted) return;
    this.stopController.abort();
    this.options.view.markStopping();
    this.options.onChange?.();
    void this.runner.cancel();
  }

  private async collectDecisions(
    approvals: readonly PendingApproval[],
  ): Promise<{ approval: PendingApproval; decision: ApprovalDecision }[] | undefined> {
    const { signal } = this.stopController;
    if (signal.aborted) return undefined;
    const stopped = new Promise<undefined>((resolve) => {
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    const results: { approval: PendingApproval; decision: ApprovalDecision }[] = [];
    // Parallel threads can pause together, and TrueForge expects one decision per call in one turn.
    for (const approval of approvals) {
      const decision = await Promise.race([this.options.decide(approval, signal), stopped]);
      if (!decision) return undefined;
      this.options.view.approvalDecided(approval.toolCallId, decision.allow);
      this.options.onChange?.();
      results.push({ approval, decision });
    }
    return results;
  }
}
