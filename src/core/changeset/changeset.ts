import * as path from 'node:path';
import type { EditorPort, WritablePort } from '../tools/editorPort';
import { resolveInsideWorkspace } from '../tools/nodeEditorPort';
import { bytesEqual, decodeText, encodeText, type TextEncodingName } from './encoding';
import { applyAcceptedHunks, computeHunks, hunkBlocks, type Hunk } from './hunks';

export type ChangeKind = 'edit' | 'create' | 'delete';

export interface FileChange {
  path: string;
  kind: ChangeKind;
  /** Bytes on disk when this file was first staged; undefined for a new file. */
  originalBytes: Uint8Array | undefined;
  original: string;
  /** Proposed text; empty for a deleted file. */
  staged: string;
  encoding: TextEncodingName;
  hunks: Hunk[];
}

export interface DriftReport {
  path: string;
  /** Hunks that could be placed on the new content, with their ids. */
  carried: string[];
  /** Hunks that no longer fit and were dropped. */
  lost: string[];
}

/** A file's text in the changeset, as tools should see it. */
export type StagedLookup = { state: 'unstaged' } | { state: 'staged'; text: string } | { state: 'deleted' };

export class StageError extends Error {}

/** Forward slashes, relative to the workspace root. Rejects anything outside it or inside .git. */
export function normalizeStagePath(workspaceRoot: string, input: string): string {
  const absolute = resolveInsideWorkspace(workspaceRoot, input);
  const relative = path.relative(path.resolve(workspaceRoot), absolute).replace(/\\/g, '/');
  if (relative === '.git' || relative.startsWith('.git/')) throw new StageError(`Cannot change files inside .git: ${input}`);
  return relative;
}

/** Per-file snapshot plus staged content. Nothing here writes to disk. */
export class Changeset {
  private readonly changes = new Map<string, FileChange>();

  constructor(private readonly port: WritablePort) {}

  get isEmpty(): boolean {
    return this.changes.size === 0;
  }

  get files(): FileChange[] {
    return [...this.changes.values()];
  }

  get hunks(): Hunk[] {
    return this.files.flatMap((file) => file.hunks);
  }

  get(relativePath: string): FileChange | undefined {
    return this.changes.get(relativePath);
  }

  lookup(relativePath: string): StagedLookup {
    const change = this.changes.get(relativePath);
    if (!change) return { state: 'unstaged' };
    return change.kind === 'delete' ? { state: 'deleted' } : { state: 'staged', text: change.staged };
  }

  /** The text edits should build on: what is staged, otherwise what is on disk. */
  async currentText(relativePath: string): Promise<string> {
    const lookup = this.lookup(relativePath);
    if (lookup.state === 'staged') return lookup.text;
    if (lookup.state === 'deleted') throw new StageError(`${relativePath} is staged for deletion.`);
    this.refuseUnsaved(relativePath);
    const bytes = await this.port.readDiskBytes(relativePath);
    if (bytes === undefined) throw new StageError(`${relativePath} does not exist. Use stage_create_file to add it.`);
    const decoded = decodeText(bytes);
    if (!decoded) throw new StageError(`${relativePath} looks like a binary file and cannot be edited as text.`);
    return decoded.text;
  }

  async stageText(relativePath: string, text: string): Promise<FileChange | undefined> {
    const existing = this.changes.get(relativePath);
    if (existing) {
      existing.staged = text;
      return this.settle(existing);
    }
    this.refuseUnsaved(relativePath);
    const bytes = await this.port.readDiskBytes(relativePath);
    if (bytes === undefined) throw new StageError(`${relativePath} does not exist. Use stage_create_file to add it.`);
    const decoded = decodeText(bytes);
    if (!decoded) throw new StageError(`${relativePath} looks like a binary file and cannot be edited as text.`);
    return this.settle({
      path: relativePath,
      kind: 'edit',
      originalBytes: bytes,
      original: decoded.text,
      staged: text,
      encoding: decoded.encoding,
      hunks: [],
    });
  }

  async stageCreate(relativePath: string, content: string): Promise<FileChange | undefined> {
    const existing = this.changes.get(relativePath);
    if (existing?.kind === 'delete') {
      // Deleted and recreated in one changeset is an edit of the file on disk.
      existing.kind = 'edit';
      existing.staged = content;
      return this.settle(existing);
    }
    if (existing || (await this.port.readDiskBytes(relativePath)) !== undefined) {
      throw new StageError(`${relativePath} already exists. Use stage_edit to change it.`);
    }
    return this.settle({
      path: relativePath,
      kind: 'create',
      originalBytes: undefined,
      original: '',
      staged: content,
      encoding: 'utf8',
      hunks: [],
    });
  }

  async stageDelete(relativePath: string): Promise<FileChange | undefined> {
    const existing = this.changes.get(relativePath);
    if (existing?.kind === 'create') {
      this.changes.delete(relativePath);
      return undefined;
    }
    if (existing?.kind === 'delete') throw new StageError(`${relativePath} is already staged for deletion.`);
    if (existing) {
      existing.kind = 'delete';
      existing.staged = '';
      return this.settle(existing);
    }
    this.refuseUnsaved(relativePath);
    const bytes = await this.port.readDiskBytes(relativePath);
    if (bytes === undefined) throw new StageError(`${relativePath} does not exist.`);
    const decoded = decodeText(bytes);
    return this.settle({
      path: relativePath,
      kind: 'delete',
      originalBytes: bytes,
      original: decoded?.text ?? '',
      staged: '',
      encoding: decoded?.encoding ?? 'utf8',
      hunks: [],
    });
  }

  /** The bytes this file should have with only these hunks accepted; undefined means deleted. */
  bytesWithAccepted(change: FileChange, accepted: ReadonlySet<string>): Uint8Array | undefined {
    if (change.kind === 'delete') return undefined;
    const text = applyAcceptedHunks(change.original, change.staged, change.hunks, accepted);
    return encodeText(text, change.encoding);
  }

  async isUnchangedOnDisk(change: FileChange): Promise<boolean> {
    if (this.port.hasUnsavedChanges(change.path)) return false;
    return bytesEqual(await this.port.readDiskBytes(change.path), change.originalBytes);
  }

  /**
   * Re-diffs any file that changed on disk since staging. Hunks that still fit are carried onto the new
   * content; the others are dropped and reported. Files with unsaved editor changes are left to the caller.
   */
  async reconcileWithDisk(): Promise<DriftReport[]> {
    const reports: DriftReport[] = [];
    for (const change of this.files) {
      if (await this.isUnchangedOnDisk(change)) continue;
      reports.push(await this.reconcile(change));
    }
    return reports;
  }

  clear(): void {
    this.changes.clear();
  }

  /** Drops what is staged for one file, so edits start again from the file on disk. True when there was something. */
  unstage(relativePath: string): boolean {
    return this.changes.delete(relativePath);
  }

  private async reconcile(change: FileChange): Promise<DriftReport> {
    const bytes = this.port.hasUnsavedChanges(change.path) ? change.originalBytes : await this.port.readDiskBytes(change.path);
    const decoded = bytes === undefined ? undefined : decodeText(bytes);
    const ids = change.hunks.map((hunk) => hunk.id);

    // A created file now exists, a deleted one changed, an edited one vanished, or the user has unsaved
    // edits: none of these can be merged safely, so the proposal for this file is dropped.
    if (change.kind !== 'edit' || !decoded || bytes === undefined || this.port.hasUnsavedChanges(change.path)) {
      this.changes.delete(change.path);
      return { path: change.path, carried: [], lost: ids };
    }

    let merged = decoded.text;
    const lost: string[] = [];
    for (const hunk of change.hunks) {
      const { before, after } = hunkBlocks(change.original, change.staged, hunk);
      const at = merged.indexOf(before);
      if (before && at !== -1 && merged.indexOf(before, at + 1) === -1) {
        merged = `${merged.slice(0, at)}${after}${merged.slice(at + before.length)}`;
      } else {
        lost.push(hunk.id);
      }
    }
    change.originalBytes = bytes;
    change.original = decoded.text;
    change.encoding = decoded.encoding;
    change.staged = merged;
    this.settle(change);
    return { path: change.path, carried: this.changes.get(change.path)?.hunks.map((h) => h.id) ?? [], lost };
  }

  private settle(change: FileChange): FileChange | undefined {
    change.hunks = computeHunks(change.path, change.original, change.staged);
    if (change.hunks.length === 0 && change.kind === 'edit') {
      this.changes.delete(change.path); // Back to what is on disk, so nothing is proposed.
      return undefined;
    }
    if (change.hunks.length === 0) {
      // Creating or deleting an empty file still needs a decision.
      change.hunks = [
        { id: `h-empty-${change.kind}`, path: change.path, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [], added: 0, removed: 0 },
      ];
    }
    this.changes.set(change.path, change);
    return change;
  }

  private refuseUnsaved(relativePath: string): void {
    if (this.port.hasUnsavedChanges(relativePath)) {
      throw new StageError(`${relativePath} has unsaved changes in the editor. Ask the user to save or revert it first.`);
    }
  }
}

/** Shows tools the workspace as it will be: staged text, staged deletions and new files. */
export class StagedEditorPort implements EditorPort {
  constructor(
    private readonly base: EditorPort,
    private readonly changeset: Changeset,
  ) {}

  get workspaceRoot(): string {
    return this.base.workspaceRoot;
  }

  private lookup(input: string): StagedLookup {
    try {
      return this.changeset.lookup(normalizeStagePath(this.workspaceRoot, input));
    } catch {
      return { state: 'unstaged' };
    }
  }

  isStaged(input: string): boolean {
    return this.lookup(input).state === 'staged';
  }

  readTextFile(input: string): Promise<string> {
    const lookup = this.lookup(input);
    if (lookup.state === 'staged') return Promise.resolve(lookup.text);
    if (lookup.state === 'deleted') return Promise.reject(new Error(`${input} is staged for deletion.`));
    return this.base.readTextFile(input);
  }

  async listFiles(): Promise<string[]> {
    const files = new Set(await this.base.listFiles());
    for (const change of this.changeset.files) {
      if (change.kind === 'delete') files.delete(change.path);
      else files.add(change.path);
    }
    return [...files];
  }

  getDiagnostics(input?: string): ReturnType<EditorPort['getDiagnostics']> {
    return this.base.getDiagnostics(input);
  }
}
