import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiagnosticInfo, EditorPort } from '../core/tools/editorPort';
import { listWorkspaceFiles, resolveInsideWorkspace } from '../core/tools/nodeEditorPort';

const SEVERITY: Record<vscode.DiagnosticSeverity, DiagnosticInfo['severity']> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class VscodeEditorPort implements EditorPort {
  get workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('No folder is open in VS Code. Open a folder first.');
    return folder.uri.fsPath;
  }

  /** Prefers the open document, so the agent sees unsaved edits exactly as the user does. */
  async readTextFile(relativePath: string): Promise<string> {
    const absolute = resolveInsideWorkspace(this.workspaceRoot, relativePath);
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.scheme === 'file' && samePath(document.uri.fsPath, absolute),
    );
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
}
