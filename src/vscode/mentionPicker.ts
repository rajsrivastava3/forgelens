import * as vscode from 'vscode';
import { mentionCandidates } from '../core/inline/mentions';
import type { EditorPort } from '../core/tools/editorPort';

interface MentionPick extends vscode.QuickPickItem {
  mention: string;
}

/** The picker behind typing @, in the panel and in inline edit. Returns text such as @file:src/a.py. */
export async function pickMention(port: EditorPort): Promise<string | undefined> {
  const candidates = await mentionCandidates(port);
  const items = candidates.map(
    (candidate): MentionPick => ({
      label: `${candidate.kind === 'file' ? '$(file)' : '$(symbol-method)'} ${candidate.name}`,
      description: candidate.detail,
      mention: `@${candidate.kind}:${candidate.name}`,
    }),
  );
  const pick = await vscode.window.showQuickPick(items, { title: 'Add a file or symbol to the context', matchOnDescription: true });
  return pick?.mention;
}
