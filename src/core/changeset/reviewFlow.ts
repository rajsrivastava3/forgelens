import type { ApprovalDecision } from '../trueforge/agentRun';
import type { FileWrite, WritablePort } from '../tools/editorPort';
import { Changeset, type DriftReport, type FileChange } from './changeset';
import { bytesEqual, decodeText } from './encoding';
import type { Hunk } from './hunks';

export const APPLY_TOOL = 'apply_changes';

export type HunkDecision = 'accepted' | 'rejected' | 'pending';
export type ReviewPhase = 'reviewing' | 'applying' | 'applied' | 'rejected' | 'discarded' | 'failed' | 'undone';

/** What the panel shows for one review. Updated in place, by id. */
export interface ReviewCard {
  id: string;
  phase: ReviewPhase;
  text: string;
  files: number;
  hunks: number;
  accepted: number;
  rejected: number;
  pending: number;
  /** Only the newest applied change can be undone. */
  canUndo: boolean;
  warning: string | undefined;
}

export interface ReviewFlowEvents {
  /** The hunks or decisions changed, or a review opened or closed. */
  onChange?: () => void;
  onCard?: (card: ReviewCard) => void;
  /** The user needs to hear this even if the panel is out of sight. */
  onWarning?: (message: string) => void;
}

interface ApprovedChange {
  reviewId: string;
  decisions: Map<string, HunkDecision>;
}

interface AppliedChange {
  card: ReviewCard;
  before: FileWrite[];
  after: FileWrite[];
}

export interface UndoResult {
  ok: boolean;
  message: string;
  files: number;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The whole path from staged edits to disk, with no editor UI in it, so it is testable without a model. */
export class ReviewFlow {
  readonly changeset: Changeset;

  private readonly decisions = new Map<string, HunkDecision>();
  private active: { card: ReviewCard; resolve: (decision: ApprovalDecision) => void } | undefined;
  private approved: ApprovedChange | undefined;
  private lastCard: ReviewCard | undefined;
  private readonly undoStack: AppliedChange[] = [];
  private reviewCounter = 0;

  /** How many reviews have opened, so a caller can tell whether one happened during its request. */
  get reviewsStarted(): number {
    return this.reviewCounter;
  }

  constructor(
    private readonly port: WritablePort,
    private readonly events: ReviewFlowEvents = {},
  ) {
    this.changeset = new Changeset(port);
  }

  get isReviewing(): boolean {
    return this.active !== undefined;
  }

  get isApprovedChangeWaiting(): boolean {
    return this.approved !== undefined;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  decisionOf(hunkId: string): HunkDecision {
    return this.decisions.get(hunkId) ?? 'pending';
  }

  /** Runs when the agent's apply_changes call pauses for approval. Settles when the user applies or stops. */
  requestReview(signal?: AbortSignal, note?: string): Promise<ApprovalDecision> {
    if (this.approved) {
      return Promise.resolve({ allow: false, reason: 'This change was already reviewed; wait for its result.' });
    }
    if (this.changeset.isEmpty) {
      return Promise.resolve({
        allow: false,
        reason: 'Nothing is staged, so there is nothing to review. Stage edits first, or finish if the work is done.',
      });
    }
    this.reviewCounter += 1;
    this.decisions.clear();
    const card = { ...this.buildCard(`review-${this.reviewCounter}`, 'reviewing'), warning: note };
    return new Promise((resolve) => {
      this.active = { card, resolve };
      signal?.addEventListener(
        'abort',
        () => {
          this.discard();
          resolve({ allow: false, reason: 'The user stopped this request.' });
        },
        { once: true },
      );
      this.publish();
    });
  }

  setDecision(hunkId: string, decision: HunkDecision): void {
    if (!this.active || !this.changeset.hunks.some((hunk) => hunk.id === hunkId)) return;
    this.decisions.set(hunkId, decision);
    this.publish();
  }

  setAll(decision: HunkDecision): void {
    if (!this.active) return;
    for (const hunk of this.changeset.hunks) this.decisions.set(hunk.id, decision);
    this.publish();
  }

  /**
   * The user pressed Apply. If a file changed underneath the review, it is re-diffed and the user decides
   * again, since what they approved is no longer what would land. Undecided hunks count as rejected.
   */
  async applyDecisions(): Promise<'sent' | 'changed-on-disk' | 'no-review'> {
    if (!this.active) return 'no-review';
    const { card, resolve } = this.active;

    const drift = await this.changeset.reconcileWithDisk();
    if (!this.active) return 'no-review'; // Stop arrived during the disk check.
    if (drift.length > 0) {
      this.warnAboutDrift(card, drift);
      if (this.changeset.isEmpty) {
        this.finishReview(card, 'discarded', 'The files changed on disk, so no proposal is left. Nothing was written.');
        resolve({ allow: false, reason: 'The user changed the files during review, so every hunk was dropped. Nothing was written.' });
        return 'sent';
      }
      this.publish();
      return 'changed-on-disk';
    }

    const hunks = this.changeset.hunks;
    const accepted = hunks.filter((hunk) => this.decisionOf(hunk.id) === 'accepted');
    if (accepted.length === 0) {
      const ids = hunks.map((hunk) => hunk.id).join(', ');
      this.finishReview(card, 'rejected', `Rejected all ${plural(hunks.length, 'hunk')}. Nothing was written.`);
      resolve({ allow: false, reason: `user rejected all hunks: ${ids}` });
      return 'sent';
    }

    this.approved = { reviewId: card.id, decisions: new Map(this.decisions) };
    this.active = undefined;
    this.emitCard({ ...this.buildCard(card.id, 'applying'), text: `Applying ${accepted.length}/${hunks.length} hunks…` });
    this.events.onChange?.();
    resolve({ allow: true });
    return 'sent';
  }

  /**
   * The body of apply_changes. Only what a person approved can land: without a reviewed change this
   * writes nothing, even if the approval gate were misconfigured.
   */
  async applyApproved(summary: string): Promise<string> {
    const approved = this.approved;
    if (!approved) {
      throw new Error(
        this.changeset.isEmpty
          ? 'Nothing is staged, so nothing was applied.'
          : 'No reviewed change is waiting, so nothing was written. Call apply_changes through the approval flow.',
      );
    }
    this.approved = undefined;

    const files = this.changeset.files;
    const applied: Hunk[] = [];
    const rejected: Hunk[] = [];
    const conflicted: Hunk[] = [];
    const writes: FileWrite[] = [];
    const before: FileWrite[] = [];

    for (const change of files) {
      const accepted = change.hunks.filter((hunk) => approved.decisions.get(hunk.id) === 'accepted');
      rejected.push(...change.hunks.filter((hunk) => approved.decisions.get(hunk.id) !== 'accepted'));
      if (accepted.length === 0) continue;
      // Last line of defence: the file changed after the user pressed Apply, so it is left alone.
      if (!(await this.changeset.isUnchangedOnDisk(change))) {
        conflicted.push(...accepted);
        continue;
      }
      applied.push(...accepted);
      before.push({ path: change.path, bytes: change.originalBytes });
      writes.push({ path: change.path, bytes: this.bytesFor(change, accepted) });
    }

    const total = applied.length + rejected.length + conflicted.length;
    const card = this.buildCardFrom(approved.reviewId, files.length, total);
    this.changeset.clear();
    this.decisions.clear();

    if (writes.length > 0) {
      try {
        await this.port.writeFiles(writes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitCard({ ...card, phase: 'failed', text: `Could not write the changes: ${message}. The workspace is unchanged.` });
        this.events.onChange?.();
        throw new Error(`Writing failed and every file was restored, so nothing was applied: ${message}`, { cause: error });
      }
    }

    const warning = conflicted.length > 0 ? `${plural(conflicted.length, 'hunk')} skipped: the file changed on disk after review.` : undefined;
    const done: ReviewCard = {
      ...card,
      phase: 'applied',
      accepted: applied.length,
      rejected: rejected.length,
      pending: 0,
      text: `Applied ${applied.length}/${total} hunks in ${plural(writes.length, 'file')}`,
      canUndo: writes.length > 0,
      warning,
    };
    if (writes.length > 0) {
      const previous = this.undoStack.at(-1);
      if (previous) this.emitCard({ ...previous.card, canUndo: false });
      this.undoStack.push({ card: done, before, after: writes });
    }
    this.emitCard(done);
    this.events.onChange?.();
    if (warning) this.events.onWarning?.(`ForgeLens: ${warning}`);
    return describeResult(summary, applied, rejected, conflicted);
  }

  /** Drops everything staged and closes any review. Nothing on disk changes. Safe to call at any time. */
  discard(): void {
    const active = this.active;
    this.approved = undefined;
    this.changeset.clear();
    this.decisions.clear();
    this.active = undefined;
    if (active) this.emitCard({ ...active.card, phase: 'discarded', text: 'Review closed. Nothing was written.', canUndo: false });
    else if (this.lastCard?.phase === 'applying') {
      this.emitCard({ ...this.lastCard, phase: 'discarded', text: 'Stopped before applying. Nothing was written.', canUndo: false });
    }
    this.events.onChange?.();
  }

  /** Restores the newest applied change, all files or none. Refuses if that would overwrite later edits. */
  async undoLast(): Promise<UndoResult> {
    const entry = this.undoStack.at(-1);
    if (!entry) return { ok: false, message: 'There is no applied change to undo.', files: 0 };

    const changedSince: string[] = [];
    for (const write of entry.after) {
      const current = await this.port.readDiskBytes(write.path);
      if (this.port.hasUnsavedChanges(write.path) || !bytesEqual(current, write.bytes)) changedSince.push(write.path);
    }
    if (changedSince.length > 0) {
      return {
        ok: false,
        message: `Not undone: ${changedSince.join(', ')} changed after this was applied, and undoing would overwrite that. No file was touched.`,
        files: 0,
      };
    }

    return this.revert(entry);
  }

  /** True when this file is part of the newest applied change. */
  lastAppliedTouches(relativePath: string): boolean {
    return this.undoStack.at(-1)?.before.some((write) => write.path === relativePath) ?? false;
  }

  /**
   * Ctrl+Z in an editor reverts the text of every file in the apply, but only in the editors: disk keeps the
   * change and the undo stack does not know. Once every file matches what it was before the apply, this saves
   * them and records the revert. A partial undo, or any other edit, leaves everything as it is.
   */
  async syncAfterEditorUndo(): Promise<UndoResult | undefined> {
    const entry = this.undoStack.at(-1);
    if (!entry) return undefined;
    for (const write of entry.before) {
      const open = this.port.openDocumentText?.(write.path);
      if (open !== undefined) {
        const wanted = write.bytes === undefined ? undefined : decodeText(write.bytes)?.text;
        if (wanted === undefined || open.replace(/\r\n/g, '\n') !== wanted.replace(/\r\n/g, '\n')) return undefined;
      } else if (!bytesEqual(await this.port.readDiskBytes(write.path), write.bytes)) {
        return undefined;
      }
    }
    return this.revert(entry);
  }

  private async revert(entry: AppliedChange): Promise<UndoResult> {
    try {
      await this.port.writeFiles(entry.before);
    } catch (error) {
      return { ok: false, message: `Undo failed and no file was changed: ${error instanceof Error ? error.message : String(error)}`, files: 0 };
    }
    this.undoStack.pop();
    const count = entry.before.length;
    this.emitCard({ ...entry.card, phase: 'undone', text: `${entry.card.text}, then reverted ${plural(count, 'file')}`, canUndo: false });
    const previous = this.undoStack.at(-1);
    if (previous) this.emitCard({ ...previous.card, canUndo: true });
    this.events.onChange?.();
    return { ok: true, message: `Reverted ${plural(count, 'file')}`, files: count };
  }

  private bytesFor(change: FileChange, accepted: readonly Hunk[]): Uint8Array | undefined {
    return this.changeset.bytesWithAccepted(change, new Set(accepted.map((hunk) => hunk.id)));
  }

  private warnAboutDrift(card: ReviewCard, drift: readonly DriftReport[]): void {
    const lost = drift.reduce((sum, report) => sum + report.lost.length, 0);
    const message = `${drift.map((report) => report.path).join(', ')} changed while you were reviewing. The diff was recomputed${
      lost > 0 ? ` and ${plural(lost, 'hunk')} no longer fit and ${lost === 1 ? 'was' : 'were'} dropped` : ''
    }. Check it, then apply again.`;
    card.warning = message;
    this.events.onWarning?.(`ForgeLens: ${message}`);
  }

  private finishReview(card: ReviewCard, phase: ReviewPhase, text: string): void {
    this.changeset.clear();
    this.decisions.clear();
    this.active = undefined;
    this.emitCard({ ...card, phase, text, pending: 0, canUndo: false });
    this.events.onChange?.();
  }

  private publish(): void {
    if (this.active) {
      const warning = this.active.card.warning;
      this.active.card = { ...this.buildCard(this.active.card.id, 'reviewing'), warning };
      this.emitCard(this.active.card);
    }
    this.events.onChange?.();
  }

  private emitCard(card: ReviewCard): void {
    this.lastCard = card;
    this.events.onCard?.(card);
  }

  private buildCardFrom(id: string, files: number, hunks: number): ReviewCard {
    return { id, phase: 'applying', text: '', files, hunks, accepted: 0, rejected: 0, pending: 0, canUndo: false, warning: undefined };
  }

  private buildCard(id: string, phase: ReviewPhase): ReviewCard {
    const hunks = this.changeset.hunks;
    const count = (decision: HunkDecision): number => hunks.filter((hunk) => this.decisionOf(hunk.id) === decision).length;
    const files = this.changeset.files.length;
    return {
      id,
      phase,
      text: `${plural(files, 'file')}, ${plural(hunks.length, 'hunk')}, waiting for your review`,
      files,
      hunks: hunks.length,
      accepted: count('accepted'),
      rejected: count('rejected'),
      pending: count('pending'),
      canUndo: false,
      warning: undefined,
    };
  }
}

function describeResult(summary: string, applied: readonly Hunk[], rejected: readonly Hunk[], conflicted: readonly Hunk[]): string {
  const list = (hunks: readonly Hunk[]): string =>
    hunks.length === 0 ? 'none' : hunks.map((hunk) => `${hunk.id} (${hunk.path}:${hunk.oldStart})`).join(', ');
  const total = applied.length + rejected.length + conflicted.length;
  const lines = [
    `The user reviewed this change ("${summary}"). ${applied.length} of ${total} hunks are now on disk.`,
    `Applied: ${list(applied)}`,
    `Rejected by the user: ${list(rejected)}`,
  ];
  if (conflicted.length > 0) lines.push(`Skipped, the file changed on disk after review: ${list(conflicted)}`);
  lines.push('Nothing else is staged. Do not stage rejected hunks again unless the user asks.');
  return lines.join('\n');
}
