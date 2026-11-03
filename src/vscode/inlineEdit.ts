import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewFlow } from '../core/changeset/reviewFlow';
import { buildInlinePrompt, finishInlineEdit, inlineDisplayText, readSelection, type InlineTarget } from '../core/inline/inlineEdit';
import { mentionCandidates, parseMentions, resolveMentions } from '../core/inline/mentions';
import type { EditorPort } from '../core/tools/editorPort';
import type { AgentController } from '../core/trueforge/agentController';

const INLINE_AGENT = 'forgelens-inline';

interface MentionPick extends vscode.QuickPickItem {
  mention: string;
}

export interface InlineEditOptions {
  controller: AgentController;
  flow: ReviewFlow;
  port: EditorPort;
  log: (message: string) => void;
}

/** "ForgeLens: Edit selection": asks what to change, runs the inline agent, and shows progress at the selection. */
export class InlineEdit implements vscode.Disposable {
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly selectionStyle = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
  });
  private readonly progressStyle = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2rem',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      contentText: 'ForgeLens is working on this selection…',
    },
  });
  private running = false;
  private acceptInput: ((value: string) => void) | undefined;

  constructor(private readonly options: InlineEditOptions) {
    this.statusItem.command = 'forgelens.stop';
    this.statusItem.tooltip = 'Click to stop';
  }

  /** Called whenever the run's status changes. */
  refresh(): void {
    if (this.running) this.statusItem.text = `$(sync~spin) ForgeLens: ${this.options.controller.view.statusText}`;
  }

  /** Test hook: answers the open input box, as pressing Enter would. */
  answerInputForTest(value: string): void {
    this.acceptInput?.(value);
  }

  async run(): Promise<void> {
    const { controller, flow, port, log } = this.options;
    const editor = vscode.window.activeTextEditor;
    const problem = this.whyNotReady(editor);
    if (problem || !editor) {
      void vscode.window.showWarningMessage(`ForgeLens: ${problem ?? 'Open a file and select some code first.'}`);
      return;
    }

    const { document, selection } = editor;
    const relative = path.relative(port.workspaceRoot, document.uri.fsPath).replace(/\\/g, '/');
    const startLine = selection.start.line + 1;
    // A selection ending at the start of a line does not really include that line.
    const lastLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;

    const instruction = await this.askForInstruction(`ForgeLens: edit ${relative}, lines ${startLine}-${lastLine}`);
    if (!instruction) return;

    const target: InlineTarget = { path: relative, startLine, endLine: lastLine, language: document.languageId, instruction };
    const mentions = await resolveMentions(port, parseMentions(instruction));
    const prompt = buildInlinePrompt(target, readSelection(document.getText(), target), mentions);
    const reviewsAtStart = flow.reviewsStarted;

    this.showProgress(editor, startLine, lastLine);
    try {
      await vscode.commands.executeCommand('workbench.view.extension.forgelens');
      await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, selection, preserveFocus: false });
      await controller.send(prompt, {
        agentName: INLINE_AGENT,
        display: inlineDisplayText(target),
        freshSession: true,
        afterTurn: (output, signal) => finishInlineEdit({ flow, target, output, reviewsAtStart, signal, log }),
      });
    } finally {
      this.hideProgress(editor);
    }
  }

  dispose(): void {
    this.statusItem.dispose();
    this.selectionStyle.dispose();
    this.progressStyle.dispose();
  }

  private whyNotReady(editor: vscode.TextEditor | undefined): string | undefined {
    if (!editor) return 'Open a file and select some code first.';
    if (this.options.controller.isBusy) return 'ForgeLens is still working. Stop it or wait for it to finish.';
    if (editor.document.uri.scheme !== 'file') return 'Inline edit works on files in the workspace.';
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) return 'This file is outside the open folder.';
    if (editor.document.isDirty) return 'This file has unsaved changes. Save it first, so the review compares against what you see.';
    return undefined;
  }

  /** An input box cannot complete text, so typing @ opens a picker and returns here with the mention added. */
  private askForInstruction(title: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const box = vscode.window.createInputBox();
      box.title = title;
      box.prompt = 'What should change? Type @ to add a file or symbol. Esc cancels.';
      box.placeholder = 'Describe the change';
      box.ignoreFocusOut = true;
      let picking = false;
      let finished = false;
      const finish = (value: string | undefined): void => {
        if (finished) return;
        finished = true;
        this.acceptInput = undefined;
        box.dispose();
        resolve(value?.trim() || undefined);
      };
      this.acceptInput = finish;
      box.onDidAccept(() => finish(box.value));
      box.onDidHide(() => {
        if (!picking) finish(undefined);
      });
      box.onDidChangeValue((value) => {
        if (picking || !/(^|\s)@$/.test(value)) return;
        picking = true;
        void this.pickMention().then((mention) => {
          picking = false;
          box.value = mention ? `${value.slice(0, -1)}${mention} ` : value;
          box.show();
        });
      });
      box.show();
    });
  }

  private async pickMention(): Promise<string | undefined> {
    const candidates = await mentionCandidates(this.options.port);
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

  private showProgress(editor: vscode.TextEditor, startLine: number, lastLine: number): void {
    this.running = true;
    this.refresh();
    this.statusItem.show();
    editor.setDecorations(this.selectionStyle, [new vscode.Range(startLine - 1, 0, lastLine - 1, 0)]);
    editor.setDecorations(this.progressStyle, [new vscode.Range(startLine - 1, Number.MAX_SAFE_INTEGER, startLine - 1, Number.MAX_SAFE_INTEGER)]);
  }

  private hideProgress(editor: vscode.TextEditor): void {
    this.running = false;
    this.statusItem.hide();
    editor.setDecorations(this.selectionStyle, []);
    editor.setDecorations(this.progressStyle, []);
  }
}
