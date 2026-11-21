import { copyFile, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Changeset } from '../changeset/changeset';
import { encodeText } from '../changeset/encoding';

export const MAX_SHADOW_BYTES = 500_000_000;

export interface ShadowSyncResult {
  root: string;
  copied: number;
  overlaid: number;
}

/** True when `inner` is `outer` or below it. */
function isInside(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A private copy of the workspace with the staged edits applied, so tests can run against them before anyone
 * reviews a hunk. The real workspace is only ever read. Unchanged files are skipped on later syncs.
 */
export class ShadowWorkspace {
  private synced = false;
  private overlaid = new Set<string>();
  private preparing: Promise<unknown> | undefined;

  constructor(
    private readonly workspaceRoot: () => string,
    private readonly shadowRoot: string,
    private readonly listFiles: () => Promise<string[]>,
    private readonly changeset: Changeset,
  ) {}

  /**
   * Starts the first copy in the background, once a change is planned, so the staged test run does not wait for
   * it. Only real files are copied here; the staged edits are laid over them in `sync`, which waits for this.
   */
  prepare(): void {
    if (this.synced || this.preparing) return;
    // A failure here is not reported: `sync` copies again and reports its own.
    this.preparing = this.copyWorkspace().catch(() => undefined);
  }

  async sync(): Promise<ShadowSyncResult> {
    if (this.preparing) await this.preparing;
    const { files, copied } = await this.copyWorkspace();
    // What the last run staged may be gone by now. Copies of real files came back above, by their changed time.
    const listed = new Set(files);
    for (const previous of this.overlaid) {
      if (!listed.has(previous)) await rm(path.join(this.shadowRoot, previous), { force: true });
    }
    const overlaid = new Set<string>();
    for (const change of this.changeset.files) {
      const to = path.join(this.shadowRoot, change.path);
      if (change.kind === 'delete') {
        await rm(to, { force: true });
      } else {
        await mkdir(path.dirname(to), { recursive: true });
        await writeFile(to, encodeText(change.staged, change.encoding));
      }
      overlaid.add(change.path);
    }
    this.overlaid = overlaid;
    return { root: this.shadowRoot, copied, overlaid: overlaid.size };
  }

  /** Copies every workspace file that is new or changed since the last copy. */
  private async copyWorkspace(): Promise<{ files: string[]; copied: number }> {
    const source = this.workspaceRoot();
    if (isInside(source, this.shadowRoot) || isInside(this.shadowRoot, source)) {
      throw new Error(`The shadow workspace must be outside the workspace: ${this.shadowRoot}`);
    }
    // The first copy starts empty, so nothing from an earlier session can change a test result.
    if (!this.synced) {
      await rm(this.shadowRoot, { recursive: true, force: true });
      this.synced = true;
    }
    await mkdir(this.shadowRoot, { recursive: true });

    const files = await this.listFiles();
    let copied = 0;
    let totalBytes = 0;
    for (const file of files) {
      const from = path.join(source, file);
      const to = path.join(this.shadowRoot, file);
      let sourceStat;
      try {
        sourceStat = await stat(from);
      } catch {
        continue; // Listed but gone, for example deleted a moment ago.
      }
      if (!sourceStat.isFile()) continue;
      totalBytes += sourceStat.size;
      if (totalBytes > MAX_SHADOW_BYTES) throw new Error(`The workspace is over ${MAX_SHADOW_BYTES / 1_000_000} MB, too large to copy for a staged run. Use target "workspace".`);
      const existing = await stat(to).catch(() => undefined);
      if (existing?.size === sourceStat.size && Math.abs(existing.mtimeMs - sourceStat.mtimeMs) < 2) continue;
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      await utimes(to, sourceStat.atime, sourceStat.mtime);
      copied += 1;
    }
    return { files, copied };
  }
}
