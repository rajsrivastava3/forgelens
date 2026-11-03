import type { ReviewItem, RunStatus, ThreadItem, ToolItem, ViewItem } from '../../core/trueforge/runView';
import type { PanelState, ToExtension, ToWebview } from '../protocol';
import { renderMarkdown } from './markdown';

declare function acquireVsCodeApi(): { postMessage(message: ToExtension): void };

const vscode = acquireVsCodeApi();
const post = (message: ToExtension): void => vscode.postMessage(message);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function required<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Panel markup is missing #${id}`);
  return node as T;
}

const transcript = required<HTMLDivElement>('transcript');
const statusLine = required<HTMLDivElement>('status');
const banner = required<HTMLDivElement>('banner');
const errorBox = required<HTMLDivElement>('error');
const modelBadge = required<HTMLSpanElement>('model');
const sessionLink = required<HTMLButtonElement>('session');
const input = required<HTMLTextAreaElement>('input');
const sendButton = required<HTMLButtonElement>('send');
const stopButton = required<HTMLButtonElement>('stop');
const newChatButton = required<HTMLButtonElement>('new-chat');

let state: PanelState | undefined;
/** Set the moment Stop is pressed, so the page reacts without waiting for the extension. */
let stopPressed = false;

/** Items keep their DOM between updates: open cards stay open and only what changed is re-rendered. */
interface Rendered {
  node: HTMLElement;
  signature: string;
  update?: (item: ViewItem) => void;
  children?: HTMLElement;
}

const rendered = new Map<string, Rendered>();

const STATUS_ICON: Record<ToolItem['status'], string> = {
  running: '⏳',
  'awaiting-approval': '✋',
  done: '✓',
  error: '✗',
  denied: '⛔',
  cancelled: '■',
};

const STATUS_LABEL: Record<ToolItem['status'], string> = {
  running: 'running',
  'awaiting-approval': 'needs your approval',
  done: 'done',
  error: 'failed',
  denied: 'declined',
  cancelled: 'stopped',
};

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function renderUser(text: string): Rendered {
  const node = element('div', 'message user');
  node.textContent = text;
  return { node, signature: text };
}

function renderText(): Rendered {
  const node = element('div', 'message assistant');
  return {
    node,
    signature: '',
    update: (item) => {
      if (item.kind === 'text') node.innerHTML = renderMarkdown(item.text);
    },
  };
}

function renderTool(): Rendered {
  const node = element('div', 'tool');
  const details = element('details', 'tool-details');
  const summary = element('summary', 'tool-summary');
  const icon = element('span', 'tool-icon');
  const name = element('span', 'tool-name');
  const args = element('span', 'tool-args');
  const via = element('span', 'tool-via');
  via.textContent = 'via call_tool';
  via.title = 'The model reached this tool through the call_tool meta tool (deferred tool loading).';
  const status = element('span', 'tool-status');
  const duration = element('span', 'tool-duration');
  summary.append(icon, name, args, via, status, duration);
  const approval = element('div', 'approval');
  const approvalText = element('div', 'approval-text');
  const allow = element('button', 'primary');
  allow.textContent = 'Allow';
  const deny = element('button', 'secondary');
  deny.textContent = 'Deny';
  const approvalButtons = element('div', 'approval-buttons');
  approvalButtons.append(allow, deny);
  approval.append(approvalText, approvalButtons);
  const body = element('pre', 'tool-result');
  details.append(summary, body);
  // Outside the collapsible part: a decision the user cannot see would leave the run stuck.
  node.append(details, approval);

  let toolId = '';
  allow.addEventListener('click', () => post({ type: 'decide', toolCallId: toolId, allow: true }));
  deny.addEventListener('click', () => post({ type: 'decide', toolCallId: toolId, allow: false }));

  return {
    node,
    signature: '',
    update: (item) => {
      if (item.kind !== 'tool') return;
      toolId = item.id;
      node.className = `tool status-${item.status}${item.system ? ' system' : ''}`;
      icon.textContent = STATUS_ICON[item.status];
      name.textContent = item.name;
      args.textContent = item.argsSummary;
      args.title = item.argsSummary;
      via.hidden = !item.viaCallTool;
      status.textContent = STATUS_LABEL[item.status];
      duration.textContent = formatDuration(item.durationMs);
      // apply_changes is answered in the hunk review, not with a plain Allow or Deny.
      const waiting = item.status === 'awaiting-approval' && item.name !== 'apply_changes';
      if (item.status === 'awaiting-approval' && !waiting) status.textContent = 'waiting for your review';
      approval.hidden = !waiting;
      approvalText.textContent = waiting
        ? `Allow ${item.name}${item.server ? ` on ${item.server}` : ''}?\n${JSON.stringify(item.args, null, 2)}`
        : '';
      body.hidden = item.result === undefined;
      body.textContent = item.result ?? '';
    },
  };
}

const REVIEW_PHASE_CLASS: Record<ReviewItem['phase'], string> = {
  reviewing: 'waiting',
  applying: 'waiting',
  applied: 'good',
  rejected: 'muted',
  discarded: 'muted',
  undone: 'muted',
  failed: 'bad',
};

function renderReview(): Rendered {
  const node = element('div', 'review');
  const title = element('div', 'review-title');
  const counts = element('div', 'review-counts');
  const warning = element('div', 'review-warning');
  const buttons = element('div', 'review-buttons');
  const open = element('button', 'secondary review-open');
  open.textContent = 'Open review';
  const apply = element('button', 'primary review-apply');
  apply.textContent = 'Apply decisions';
  const undo = element('button', 'primary review-undo');
  undo.textContent = 'Undo';
  buttons.append(open, apply, undo);
  node.append(title, counts, warning, buttons);
  open.addEventListener('click', () => post({ type: 'review-open' }));
  apply.addEventListener('click', () => post({ type: 'review-apply' }));
  undo.addEventListener('click', () => post({ type: 'undo' }));
  return {
    node,
    signature: '',
    update: (item) => {
      if (item.kind !== 'review') return;
      const reviewing = item.phase === 'reviewing';
      node.className = `review ${REVIEW_PHASE_CLASS[item.phase]}`;
      title.textContent = item.text;
      counts.hidden = !reviewing;
      counts.textContent = `${item.accepted} accepted, ${item.rejected} rejected, ${item.pending} undecided`;
      warning.hidden = !item.warning;
      warning.textContent = item.warning ?? '';
      open.hidden = !reviewing;
      apply.hidden = !reviewing;
      undo.hidden = !item.canUndo;
      buttons.hidden = !reviewing && !item.canUndo;
    },
  };
}

function renderThread(): Rendered {
  const node = element('details', 'thread');
  node.open = true;
  const summary = element('summary', 'thread-summary');
  const children = element('div', 'thread-items');
  node.append(summary, children);
  return {
    node,
    signature: '',
    children,
    update: (item) => {
      if (item.kind === 'thread') summary.textContent = `Subagent: ${item.title}${item.done ? ' (finished)' : ' (working…)'}`;
    },
  };
}

function shallowSignature(item: ViewItem): string {
  // A thread's children are diffed on their own, so its own signature leaves them out.
  if (item.kind === 'thread') {
    const { items: _items, ...rest } = item as ThreadItem;
    void _items;
    return JSON.stringify(rest);
  }
  return JSON.stringify(item);
}

function renderItems(items: readonly ViewItem[], container: HTMLElement): void {
  items.forEach((item, index) => {
    let entry = rendered.get(item.id);
    if (!entry) {
      entry =
        item.kind === 'user'
          ? renderUser(item.text)
          : item.kind === 'text'
            ? renderText()
            : item.kind === 'tool'
              ? renderTool()
              : item.kind === 'review'
                ? renderReview()
                : renderThread();
      rendered.set(item.id, entry);
    }
    const signature = shallowSignature(item);
    if (entry.signature !== signature) {
      entry.update?.(item);
      entry.signature = signature;
    }
    if (container.children[index] !== entry.node) container.insertBefore(entry.node, container.children[index] ?? null);
    if (item.kind === 'thread' && entry.children) renderItems(item.items, entry.children);
  });
  while (container.children.length > items.length) container.lastElementChild?.remove();
}

function applyStopButton(busy: boolean, status: RunStatus | undefined): void {
  const stopping = stopPressed || status === 'stopping';
  stopButton.hidden = !busy;
  stopButton.disabled = stopping;
  stopButton.textContent = stopping ? 'Stopping…' : 'Stop';
}

function render(next: PanelState): void {
  state = next;
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  document.body.classList.toggle('large-text', next.largeText);

  const { view } = next;
  if (view.items.length === 0) rendered.clear();
  renderItems(view.items, transcript);
  if (nearBottom) transcript.scrollTop = transcript.scrollHeight;

  if (!next.busy) stopPressed = false;
  statusLine.textContent = stopPressed ? 'Stopping…' : view.statusText;
  statusLine.dataset['status'] = view.status;
  statusLine.hidden = !statusLine.textContent;
  banner.hidden = !next.banner;
  banner.textContent = next.banner ?? '';
  errorBox.hidden = !view.error;
  errorBox.textContent = view.error ?? '';
  modelBadge.textContent = view.model ?? 'no model';
  modelBadge.title = view.model ? `Model: ${view.model}` : 'TrueForge has not been set up yet';
  sessionLink.hidden = !view.sessionUrl;
  sendButton.hidden = next.busy;
  sendButton.disabled = !input.value.trim();
  newChatButton.disabled = next.busy;
  applyStopButton(next.busy, view.status);
}

function pressStop(): void {
  if (stopPressed || stopButton.hidden) return;
  stopPressed = true;
  // Local first: the button and status react in this same task, before any message round trip.
  statusLine.textContent = 'Stopping…';
  statusLine.hidden = false;
  applyStopButton(true, state?.view.status);
  post({ type: 'stop' });
}

function send(): void {
  const text = input.value.trim();
  if (!text || state?.busy) return;
  input.value = '';
  input.style.height = '';
  post({ type: 'send', text });
  sendButton.disabled = true;
}

sendButton.addEventListener('click', send);
stopButton.addEventListener('click', pressStop);
newChatButton.addEventListener('click', () => post({ type: 'new-chat' }));
sessionLink.addEventListener('click', () => post({ type: 'open-session' }));
banner.addEventListener('click', () => post({ type: 'setup' }));
input.addEventListener('input', () => {
  sendButton.disabled = !input.value.trim();
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state?.busy) pressStop();
});
transcript.addEventListener('click', (event) => {
  // Links open through the editor, not inside the webview.
  if (event.target instanceof HTMLAnchorElement) event.preventDefault();
});

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  if (message.type === 'state') {
    render(message.state);
  } else if (message.type === 'probe-click') {
    const target = document.querySelector<HTMLElement>(message.selector);
    // A script can click what a person cannot see, so insist the target is really on screen.
    const rect = target?.getBoundingClientRect();
    const clicked = target !== null && target.checkVisibility() && (rect?.width ?? 0) > 0 && (rect?.height ?? 0) > 0;
    const started = performance.now();
    if (clicked) target.click();
    post({
      type: 'probe-result',
      clicked,
      reactionMs: performance.now() - started,
      statusText: statusLine.textContent ?? '',
    });
  }
});

post({ type: 'ready' });
