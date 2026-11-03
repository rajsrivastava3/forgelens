import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../core/changeset/changeset';
import type { Hunk } from '../core/changeset/hunks';
import type { HunkDecision, ReviewFlow } from '../core/changeset/reviewFlow';

export const PROPOSED_SCHEME = 'forgelens-proposed';
const EMPTY_QUERY = 'empty';

const DECISION_ICON: Record<HunkDecision, vscode.ThemeIcon> = {
  accepted: new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed')),
  rejected: new vscode.ThemeIcon('close', new vscode.ThemeColor('testing.iconFailed')),
  pending: new vscode.ThemeIcon('circle-outline'),
};

type TreeNode = { kind: 'file'; change: FileChange } | { kind: 'hunk'; change: FileChange; hunk: Hunk };

function proposedUri(relativePath: string, empty = false): vscode.Uri {
  return vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${relativePath}`, ...(empty ? { query: EMPTY_QUERY } : {}) });
}

function firstChange(hunk: Hunk): string {
  const line = hunk.lines.find((text) => text.startsWith('+') || text.startsWith('-')) ?? '';
  return line.slice(0, 1) + ' ' + line.slice(1).trim();
}

/** The review's editor UI: diff tabs, a CodeLens per hunk, the Changes tree. All decisions live in ReviewFlow. */
export class ReviewController
  implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly documentChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  private readonly treeChanged = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tree: vscode.TreeView<TreeNode>;
  private wasReviewing = false;
  private tabsOpen = false;
  /** Paths with a diff tab, so a re-diff can refresh them and closing the review can find them. */
  private shownPaths = new Set<string>();
  /** Opening and closing tabs take time. In a queue, a fast Stop cannot leave a tab that opened after the close. */
  private tabWork: Promise<unknown> = Promise.resolve();

  readonly onDidChange = this.documentChanged.event;
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  readonly onDidChangeTreeData = this.treeChanged.event;

  constructor(
    private readonly flow: ReviewFlow,
    private readonly workspaceRoot: () => string,
  ) {
    this.tree = vscode.window.createTreeView('forgelens.changes', { treeDataProvider: this, showCollapseAll: false });
    this.disposables.push(
      this.tree,
      this.documentChanged,
      this.lensesChanged,
      this.treeChanged,
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, this),
      vscode.commands.registerCommand('forgelens.review.acceptHunk', (target: string | TreeNode) => this.decide(target, 'accepted')),
      vscode.commands.registerCommand('forgelens.review.rejectHunk', (target: string | TreeNode) => this.decide(target, 'rejected')),
      vscode.commands.registerCommand('forgelens.review.acceptAll', () => this.flow.setAll('accepted')),
      vscode.commands.registerCommand('forgelens.review.rejectAll', () => this.flow.setAll('rejected')),
      vscode.commands.registerCommand('forgelens.review.apply', () => this.apply()),
      vscode.commands.registerCommand('forgelens.review.open', () => this.queueTabs(() => this.openAll())),
      vscode.commands.registerCommand('forgelens.review.reveal', (change: FileChange, hunk?: Hunk) => this.reveal(change, hunk)),
    );
  }

  /** ReviewFlow changed. Keeps the tree, the lenses and the diff tabs in step with it. */
  refresh(): void {
    const reviewing = this.flow.isReviewing;
    void vscode.commands.executeCommand('setContext', 'forgelens.reviewing', reviewing);
    this.treeChanged.fire(undefined);
    this.lensesChanged.fire();
    this.updateTreeSummary();
    // Only during a review: afterwards there is no proposal, and the tab would flash an empty file before closing.
    if (reviewing) for (const shown of this.shownPaths) this.documentChanged.fire(proposedUri(shown));

    // An approved change is still being written. Closing its diff now would release the document mid-save.
    const tabsNeeded = reviewing || this.flow.isApprovedChangeWaiting;
    if (reviewing && !this.wasReviewing && !this.tabsOpen) this.queueTabs(() => this.openAll());
    if (!tabsNeeded && this.tabsOpen) this.queueTabs(() => this.closeTabs());
    this.tabsOpen = tabsNeeded;
    this.wasReviewing = reviewing;
  }

  private queueTabs(work: () => Promise<void>): void {
    this.tabWork = this.tabWork.then(work).catch(() => undefined);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  // Virtual documents: the right side of each diff.
  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.query === EMPTY_QUERY) return '';
    return this.flow.changeset.get(uri.path.slice(1))?.staged ?? '';
  }

  // One lens row above every hunk, on the proposed side.
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const change = this.flow.changeset.get(document.uri.path.slice(1));
    if (!change || !this.flow.isReviewing || document.uri.query === EMPTY_QUERY) return [];
    return change.hunks.flatMap((hunk) => {
      const firstChanged = hunk.lines.findIndex((line) => line.startsWith('+') || line.startsWith('-'));
      const contextBefore = hunk.lines.slice(0, Math.max(0, firstChanged)).length;
      const line = Math.min(Math.max(0, hunk.newStart - 1 + contextBefore), Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const decision = this.flow.decisionOf(hunk.id);
      const accept = decision === 'accepted' ? '$(check) Accepted' : 'Accept hunk';
      const reject = decision === 'rejected' ? '$(close) Rejected' : 'Reject hunk';
      return [
        new vscode.CodeLens(range, { title: accept, command: 'forgelens.review.acceptHunk', arguments: [hunk.id], tooltip: `Accept ${hunk.id}` }),
        new vscode.CodeLens(range, { title: reject, command: 'forgelens.review.rejectHunk', arguments: [hunk.id], tooltip: `Reject ${hunk.id}` }),
      ];
    });
  }

  // The Changes tree: each file with its hunks under it.
  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.flow.isReviewing ? this.flow.changeset.files.map((change) => ({ kind: 'file', change })) : [];
    if (node.kind === 'file') return node.change.hunks.map((hunk) => ({ kind: 'hunk', change: node.change, hunk }));
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(node.change.path, vscode.TreeItemCollapsibleState.Expanded);
      const decisions = node.change.hunks.map((hunk) => this.flow.decisionOf(hunk.id));
      const count = (decision: HunkDecision): number => decisions.filter((value) => value === decision).length;
      item.description = `${node.change.kind === 'edit' ? '' : `${node.change.kind}, `}✓${count('accepted')} ✗${count('rejected')} ?${count('pending')}`;
      item.iconPath = vscode.ThemeIcon.File;
      item.resourceUri = vscode.Uri.file(path.join(this.workspaceRoot(), node.change.path));
      item.contextValue = 'file';
      item.command = { title: 'Open diff', command: 'forgelens.review.reveal', arguments: [node.change] };
      return item;
    }
    const { hunk } = node;
    const item = new vscode.TreeItem(`Line ${hunk.newStart}: ${firstChange(hunk)}`, vscode.TreeItemCollapsibleState.None);
    item.id = hunk.id;
    item.description = `+${hunk.added} -${hunk.removed}`;
    item.tooltip = new vscode.MarkdownString(`\`${hunk.id}\`\n\n\`\`\`diff\n${hunk.lines.join('\n')}\n\`\`\``);
    item.iconPath = DECISION_ICON[this.flow.decisionOf(hunk.id)];
    item.contextValue = 'hunk';
    item.command = { title: 'Show hunk', command: 'forgelens.review.reveal', arguments: [node.change, hunk] };
    return item;
  }

  private updateTreeSummary(): void {
    const hunks = this.flow.changeset.hunks;
    if (!this.flow.isReviewing) {
      this.tree.badge = undefined;
      this.tree.message = undefined;
      return;
    }
    const undecided = hunks.filter((hunk) => this.flow.decisionOf(hunk.id) === 'pending').length;
    const accepted = hunks.filter((hunk) => this.flow.decisionOf(hunk.id) === 'accepted').length;
    this.tree.badge = undecided > 0 ? { value: undecided, tooltip: `${undecided} hunks to decide` } : undefined;
    this.tree.message = `${accepted}/${hunks.length} accepted, ${undecided} undecided. Undecided hunks are rejected on Apply.`;
  }

  private decide(target: string | TreeNode, decision: HunkDecision): void {
    const id = typeof target === 'string' ? target : target.kind === 'hunk' ? target.hunk.id : undefined;
    if (id) this.flow.setDecision(id, decision);
  }

  private async apply(): Promise<void> {
    const result = await this.flow.applyDecisions();
    if (result === 'no-review') void vscode.window.showInformationMessage('ForgeLens: no review is open.');
  }

  private diffUris(change: FileChange): { left: vscode.Uri; right: vscode.Uri } {
    const disk = vscode.Uri.file(path.join(this.workspaceRoot(), change.path));
    if (change.kind === 'create') return { left: proposedUri(change.path, true), right: proposedUri(change.path) };
    if (change.kind === 'delete') return { left: disk, right: proposedUri(change.path, true) };
    return { left: disk, right: proposedUri(change.path) };
  }

  private async showDiff(change: FileChange, options: vscode.TextDocumentShowOptions): Promise<void> {
    const { left, right } = this.diffUris(change);
    this.shownPaths.add(change.path);
    const label = change.kind === 'edit' ? 'proposed' : change.kind === 'create' ? 'new file' : 'deleted';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(change.path)} (${label})`, options);
  }

  private async openAll(): Promise<void> {
    // The first file opens last, so it is the one showing.
    const files = this.flow.changeset.files;
    for (const change of [...files.slice(1), ...files.slice(0, 1)]) {
      if (!this.flow.isReviewing) return;
      await this.showDiff(change, { preview: false, preserveFocus: true });
    }
    await vscode.commands.executeCommand('forgelens.changes.focus');
  }

  private async reveal(change: FileChange, hunk?: Hunk): Promise<void> {
    const line = Math.max(0, (hunk?.newStart ?? 1) - 1);
    await this.showDiff(change, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
  }

  private async closeTabs(): Promise<void> {
    this.shownPaths = new Set();
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && (tab.input.modified.scheme === PROPOSED_SCHEME || tab.input.original.scheme === PROPOSED_SCHEME));
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
  }
}
