import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { PanelState, ToExtension, ToWebview } from './protocol';

/** Roughly 30 frames per second: smooth streaming without flooding the webview. */
const STATE_INTERVAL_MS = 33;

export interface AgentPanelHandlers {
  getState(): PanelState;
  onSend(text: string): void;
  onStop(): void;
  onDecide(toolCallId: string, allow: boolean): void;
  onNewChat(): void;
  onOpenSession(): void;
  onSetup(): void;
  onReviewOpen(): void;
  onReviewApply(): void;
  onUndo(): void;
}

export interface ProbeResult {
  clicked: boolean;
  reactionMs: number;
  statusText: string;
}

export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'forgelens.panel';

  private view: vscode.WebviewView | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastPostedAt = 0;
  private probeWaiter: ((result: ProbeResult) => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: AgentPanelHandlers,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: ToExtension) => this.onMessage(message));
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Coalesces updates. Stop must never wait on this: the webview reacts locally first. */
  refresh(): void {
    if (this.timer) return;
    const wait = Math.max(0, STATE_INTERVAL_MS - (Date.now() - this.lastPostedAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.lastPostedAt = Date.now();
      this.post({ type: 'state', state: this.handlers.getState() });
    }, wait);
  }

  /** Test hook: presses a real button in the page. */
  clickForTest(selector: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      if (!this.view) {
        reject(new Error('The panel is not open.'));
        return;
      }
      this.probeWaiter = resolve;
      this.post({ type: 'probe-click', selector });
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private onMessage(message: ToExtension): void {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'state', state: this.handlers.getState() });
        break;
      case 'send':
        this.handlers.onSend(message.text);
        break;
      case 'stop':
        this.handlers.onStop();
        break;
      case 'decide':
        this.handlers.onDecide(message.toolCallId, message.allow);
        break;
      case 'new-chat':
        this.handlers.onNewChat();
        break;
      case 'open-session':
        this.handlers.onOpenSession();
        break;
      case 'setup':
        this.handlers.onSetup();
        break;
      case 'review-open':
        this.handlers.onReviewOpen();
        break;
      case 'review-apply':
        this.handlers.onReviewApply();
        break;
      case 'undo':
        this.handlers.onUndo();
        break;
      case 'probe-result':
        this.probeWaiter?.(message);
        this.probeWaiter = undefined;
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const asset = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', file));
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('webview.css').toString()}">
<title>ForgeLens</title>
</head>
<body>
  <div class="topbar">
    <span class="badge" id="model"></span>
    <span class="spacer"></span>
    <button class="link" id="session" hidden>Open session in TrueForge</button>
    <button class="link" id="new-chat">New chat</button>
  </div>
  <div id="banner" hidden></div>
  <div id="transcript" role="log" aria-live="polite"></div>
  <div id="status" role="status" hidden></div>
  <div id="error" role="alert" hidden></div>
  <div class="composer">
    <textarea id="input" rows="2" placeholder="Ask ForgeLens about this repository…" aria-label="Message"></textarea>
    <button class="primary" id="send" disabled>Send</button>
    <button class="primary" id="stop" hidden>Stop</button>
  </div>
  <script nonce="${nonce}" src="${asset('webview.js').toString()}"></script>
</body>
</html>`;
  }
}
