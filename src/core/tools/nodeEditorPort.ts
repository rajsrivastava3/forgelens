import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { DiagnosticInfo, EditorPort } from './editorPort';

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

/** Headless EditorPort, used by rehearsal scripts and tests. */
export class NodeEditorPort implements EditorPort {
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
}
