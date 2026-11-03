import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { DiagnosticInfo, FileWrite, WritablePort } from './editorPort';

const execFileAsync = promisify(execFile);

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.tox',
  'dist',
  'build',
  'out',
]);

const TRANSIENT_LOCK = /EBUSY|EPERM|EACCES|resource busy|being used by another process/i;
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1500];

/** Windows: a virus scanner, indexer or git can hold a file for a moment. That should not fail a write. */
export async function retryWhileLocked<T>(operation: () => PromiseLike<T>, delays: readonly number[] = LOCK_RETRY_DELAYS_MS): Promise<T> {
  for (const delay of delays) {
    try {
      return await operation();
    } catch (error) {
      if (!TRANSIENT_LOCK.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return operation();
}

/** Rejects paths that resolve outside the workspace, including `..` segments and absolute paths. */
export function resolveInsideWorkspace(workspaceRoot: string, relativePath: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativePath);
  const fromRoot = path.relative(root, resolved);
  if (fromRoot === '' || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    throw new Error(`Path is outside the workspace: ${relativePath}`);
  }
  return resolved;
}

/** Lists files with git so .gitignore is honoured, or walks the tree when this is not a git repo. */
export async function listWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: workspaceRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split('\0').filter((file) => file.length > 0);
  } catch {
    return walk(workspaceRoot, '');
  }
}

async function walk(root: string, relativeDir: string): Promise<string[]> {
  const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...(await walk(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

async function readIfPresent(absolute: string): Promise<Uint8Array | undefined> {
  try {
    return await retryWhileLocked(() => readFile(absolute));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function replaceFile(absolute: string, bytes: Uint8Array | undefined): Promise<void> {
  if (bytes === undefined) {
    await retryWhileLocked(() => rm(absolute, { force: true }));
    return;
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomBytes(4).toString('hex')}.forgelens-tmp`;
  await writeFile(temporary, bytes);
  try {
    await retryWhileLocked(() => rename(temporary, absolute));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Headless port, used by rehearsal scripts and tests. */
export class NodeEditorPort implements WritablePort {
  constructor(readonly workspaceRoot: string) {}

  readTextFile(relativePath: string): Promise<string> {
    return readFile(resolveInsideWorkspace(this.workspaceRoot, relativePath), 'utf8');
  }

  listFiles(): Promise<string[]> {
    return listWorkspaceFiles(this.workspaceRoot);
  }

  /** There is no language server outside the editor. */
  getDiagnostics(): Promise<DiagnosticInfo[]> {
    return Promise.resolve([]);
  }

  readDiskBytes(relativePath: string): Promise<Uint8Array | undefined> {
    return readIfPresent(resolveInsideWorkspace(this.workspaceRoot, relativePath));
  }

  /** No editor, so nothing can be unsaved. */
  hasUnsavedChanges(): boolean {
    return false;
  }

  async writeFiles(writes: readonly FileWrite[]): Promise<void> {
    const targets = writes.map((write) => ({
      absolute: resolveInsideWorkspace(this.workspaceRoot, write.path),
      bytes: write.bytes,
    }));
    const before = await Promise.all(targets.map((target) => readIfPresent(target.absolute)));
    const done: number[] = [];
    try {
      for (const [index, target] of targets.entries()) {
        await replaceFile(target.absolute, target.bytes);
        done.push(index);
      }
    } catch (error) {
      for (const index of done.reverse()) {
        const target = targets[index];
        if (target) await replaceFile(target.absolute, before[index]);
      }
      throw error;
    }
  }
}
