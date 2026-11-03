import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { bytesEqual, decodeText } from '../core/changeset/encoding';
import type { DiagnosticInfo, FileWrite, WritablePort } from '../core/tools/editorPort';
import { listWorkspaceFiles, resolveInsideWorkspace, retryWhileLocked } from '../core/tools/nodeEditorPort';

const SEVERITY: Record<vscode.DiagnosticSeverity, DiagnosticInfo['severity']> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

const SAVE_ATTEMPTS = 3;
const EDIT_ATTEMPTS = 5;
const EDIT_RETRY_DELAY_MS = 150;

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The smallest single replacement, so the editor keeps its cursor and folds where nothing changed. */
function minimalEdit(document: vscode.TextDocument, text: string): vscode.TextEdit | undefined {
  const current = document.getText();
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const next = text.replace(/\r?\n/g, eol);
  if (current === next) return undefined;
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < current.length - start &&
    end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1;
  }
  const range = new vscode.Range(document.positionAt(start), document.positionAt(current.length - end));
  return vscode.TextEdit.replace(range, next.slice(start, next.length - end));
}

export class VscodeEditorPort implements WritablePort {
  get workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('No folder is open in VS Code. Open a folder first.');
    return folder.uri.fsPath;
  }

  /** Prefers the open document, so the agent sees unsaved edits exactly as the user does. */
  async readTextFile(relativePath: string): Promise<string> {
    const absolute = resolveInsideWorkspace(this.workspaceRoot, relativePath);
    const open = this.openDocument(absolute);
    return open ? open.getText() : readFile(absolute, 'utf8');
  }

  listFiles(): Promise<string[]> {
    return listWorkspaceFiles(this.workspaceRoot);
  }

  getDiagnostics(relativePath?: string): Promise<DiagnosticInfo[]> {
    const root = this.workspaceRoot;
    const convert = (uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): DiagnosticInfo[] =>
      diagnostics.map((diagnostic) => ({
        path: path.relative(root, uri.fsPath).replace(/\\/g, '/'),
        line: diagnostic.range.start.line + 1,
        severity: SEVERITY[diagnostic.severity],
        message: diagnostic.message,
        source: diagnostic.source,
      }));

    if (relativePath) {
      const uri = vscode.Uri.file(resolveInsideWorkspace(root, relativePath));
      return Promise.resolve(convert(uri, vscode.languages.getDiagnostics(uri)));
    }
    const insideWorkspace = vscode.languages
      .getDiagnostics()
      .filter(([uri]) => uri.scheme === 'file' && !path.relative(root, uri.fsPath).startsWith('..'));
    return Promise.resolve(insideWorkspace.flatMap(([uri, diagnostics]) => convert(uri, diagnostics)));
  }

  async readDiskBytes(relativePath: string): Promise<Uint8Array | undefined> {
    return this.readUri(this.uriOf(relativePath));
  }

  hasUnsavedChanges(relativePath: string): boolean {
    const absolute = resolveInsideWorkspace(this.workspaceRoot, relativePath);
    return this.openDocument(absolute)?.isDirty ?? false;
  }

  /**
   * One WorkspaceEdit across every file, then save, so the change is atomic and Ctrl+Z works. Saving can
   * still change bytes (format on save, a file's own encoding, mixed line endings the editor normalised),
   * so the result is compared with what was approved and corrected if it differs.
   */
  async writeFiles(writes: readonly FileWrite[]): Promise<void> {
    const targets = writes.map((write) => ({ ...write, uri: this.uriOf(write.path) }));
    const before = await Promise.all(targets.map((target) => this.readUri(target.uri)));

    const edited: vscode.Uri[] = [];
    try {
      // VS Code refuses an edit built against a document it is reloading, so build it afresh and try again.
      for (let attempt = 1; ; attempt += 1) {
        edited.length = 0;
        const edit = new vscode.WorkspaceEdit();
        for (const [index, target] of targets.entries()) {
          if (target.bytes === undefined) {
            edit.deleteFile(target.uri, { ignoreIfNotExists: true });
          } else if (before[index] === undefined) {
            edit.createFile(target.uri, { contents: target.bytes, overwrite: false });
          } else {
            const document = await vscode.workspace.openTextDocument(target.uri);
            const change = minimalEdit(document, decodeForEditor(target.bytes));
            if (change) {
              edit.replace(target.uri, change.range, change.newText);
              edited.push(target.uri);
            }
          }
        }
        if (await vscode.workspace.applyEdit(edit)) break;
        if (attempt >= EDIT_ATTEMPTS) throw new Error('VS Code refused the edit.');
        await new Promise((resolve) => setTimeout(resolve, EDIT_RETRY_DELAY_MS));
      }
      await Promise.all(edited.map((uri) => saveDocument(uri)));
      for (const target of targets) {
        if (target.bytes !== undefined && !bytesEqual(await this.readUri(target.uri), target.bytes)) {
          const { uri, bytes } = target;
          await retryWhileLocked(() => vscode.workspace.fs.writeFile(uri, bytes));
        }
      }
    } catch (error) {
      await this.restore(targets, before);
      throw error;
    }
  }

  private async restore(targets: readonly (FileWrite & { uri: vscode.Uri })[], before: readonly (Uint8Array | undefined)[]): Promise<void> {
    for (const [index, target] of targets.entries()) {
      const bytes = before[index];
      const current = await this.readUri(target.uri);
      if (bytesEqual(current, bytes)) continue;
      await retryWhileLocked(() =>
        bytes === undefined ? vscode.workspace.fs.delete(target.uri, { useTrash: false }) : vscode.workspace.fs.writeFile(target.uri, bytes),
      );
    }
  }

  private uriOf(relativePath: string): vscode.Uri {
    return vscode.Uri.file(resolveInsideWorkspace(this.workspaceRoot, relativePath));
  }

  private async readUri(uri: vscode.Uri): Promise<Uint8Array | undefined> {
    try {
      return await retryWhileLocked(() => vscode.workspace.fs.readFile(uri));
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return undefined;
      throw error;
    }
  }

  private openDocument(absolute: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (document) => document.uri.scheme === 'file' && samePath(document.uri.fsPath, absolute),
    );
  }
}

/**
 * Saves by uri, not by a held document: closing the last tab showing a file releases its document object,
 * and save() on that throws "Document has been closed" even though the edit is still pending.
 */
async function saveDocument(uri: vscode.Uri): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const document = await vscode.workspace.openTextDocument(uri);
    try {
      await document.save();
      return;
    } catch (error) {
      if (attempt >= SAVE_ATTEMPTS || !document.isClosed) throw error;
    }
  }
}

/** The editor only needs text for its model and Ctrl+Z; the exact bytes are checked after saving. */
function decodeForEditor(bytes: Uint8Array): string {
  const decoded = decodeText(bytes);
  return decoded?.text ?? Buffer.from(bytes).toString('utf8');
}
