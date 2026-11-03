import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { EditorPort } from './editorPort';

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

/** Headless EditorPort, used by rehearsal scripts and tests. */
export class NodeEditorPort implements EditorPort {
  constructor(readonly workspaceRoot: string) {}

  readTextFile(relativePath: string): Promise<string> {
    return readFile(resolveInsideWorkspace(this.workspaceRoot, relativePath), 'utf8');
  }
}
