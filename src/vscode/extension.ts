import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import agentDefinition from '../../agents/forgelens-agent.json';
import inlineDefinition from '../../agents/forgelens-inline.json';
import { APPLY_TOOL, ReviewFlow, type UndoResult } from '../core/changeset/reviewFlow';
import { sendAgentRequest } from '../core/context/agentPrompt';
import { ContextEngine, type IndexStore } from '../core/context/engine';
import { DEFAULT_BUDGET_TOKENS } from '../core/context/packer';
import { startEditorMcpServer, type RunningEditorMcpServer } from '../core/mcp/server';
import { CommandRunner, DEFAULT_SAFE_COMMANDS, isSafeCommand, RUN_COMMAND_TOOL } from '../core/tools/runCommand';
import { AgentController } from '../core/trueforge/agentController';
import { createSessionForModel, listModels, setUpTrueForge, type AgentDefinition } from '../core/trueforge/setup';
import type { SessionsApi } from '../core/trueforge/turnRunner';
import { AgentPanel } from './agentPanel';
import { InlineEdit } from './inlineEdit';
import { pickMention } from './mentionPicker';
import type { PanelState } from './protocol';
import { ReviewController } from './reviewController';
import { VscodeEditorPort } from './vscodeEditorPort';

const TOKEN_SECRET = 'forgelens.mcpToken';
const AGENT_NAME = 'forgelens-agent';
const AGENTS: AgentDefinition[] = [agentDefinition, inlineDefinition];

/** A scripted server for the end-to-end test, so most of it spends no model requests. */
interface TestSessions {
  api: SessionsApi;
  sessionId: string;
}

const EDITOR_UNDO_SETTLE_MS = 150;
const FILE_LIST_SETTLE_MS = 500;
const NOT_WORKSPACE_FILES = /(^|\/)(\.git|\.venv|venv|node_modules|__pycache__|\.pytest_cache)(\/|$)/;
let stopOnClose: (() => Promise<void>) | undefined;

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('forgelens');
}

function baseUrl(): string {
  return config().get<string>('trueforgeUrl', 'http://localhost:8790').replace(/\/$/, '');
}

async function loadToken(secrets: vscode.SecretStorage): Promise<string> {
  const stored = await secrets.get(TOKEN_SECRET);
  if (stored) return stored;
  const token = randomBytes(32).toString('hex');
  await secrets.store(TOKEN_SECRET, token);
  return token;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('ForgeLens');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'forgelens.pickModel';
  statusBar.show();
  context.subscriptions.push(output, statusBar);

  const port = new VscodeEditorPort();
  const flow = new ReviewFlow(port, {
    onChange: () => review.refresh(),
    onCard: (card) => controller.updateReview(card),
    onWarning: (message) => void vscode.window.showWarningMessage(message),
  });
  const review = new ReviewController(flow, () => port.workspaceRoot, context.globalState);
  const workspaceId = (): string => createHash('sha1').update(port.workspaceRoot.toLowerCase()).digest('hex').slice(0, 16);
  const storageDir = context.globalStorageUri.fsPath;
  // The index and the staged copy live here, never in the workspace, which must stay clean.
  const indexStore: IndexStore = {
    read: () => readFile(path.join(storageDir, `index-${workspaceId()}.json`), 'utf8').catch(() => undefined),
    write: async (text) => {
      await mkdir(storageDir, { recursive: true });
      await writeFile(path.join(storageDir, `index-${workspaceId()}.json`), text);
    },
  };
  const engine = new ContextEngine(port, { store: indexStore, log: (message) => output.appendLine(message) });
  const runner = new CommandRunner();
  const relativeOf = (uri: vscode.Uri): string | undefined =>
    uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/') : undefined;
  let mcp: RunningEditorMcpServer | undefined;
  let mcpToken: string | undefined;
  let banner: string | undefined;
  let activeModel: string | undefined;
  let modelChain: string[] = [];
  let client: TrueForge | undefined;
  let clientUrl: string | undefined;
  let testSessions: TestSessions | undefined;
  let wasBusy = false;
  let editorUndoTimer: ReturnType<typeof setTimeout> | undefined;
  let fileListTimer: ReturnType<typeof setTimeout> | undefined;

  const sdk = (): TrueForge => {
    if (!client || clientUrl !== baseUrl()) {
      clientUrl = baseUrl();
      client = new TrueForge({ baseUrl: clientUrl, timeoutInSeconds: 600 });
    }
    return client;
  };

  const showStatus = (): void => {
    if (banner) {
      statusBar.text = '$(warning) ForgeLens: not connected';
      statusBar.tooltip = `${banner}\n\nClick to run "ForgeLens: Set up TrueForge".`;
      statusBar.command = 'forgelens.setup';
      return;
    }
    statusBar.command = 'forgelens.pickModel';
    const running = controller.activeModel;
    const onFallback = running !== undefined && activeModel !== undefined && running !== activeModel;
    statusBar.text = onFallback ? `$(warning) ${running} (fallback)` : `$(telescope) ${activeModel ?? 'ForgeLens'}`;
    statusBar.tooltip = [
      onFallback ? `Using the fallback ${running}: ${activeModel} failed.` : `ForgeLens model: ${activeModel ?? 'none'}`,
      modelChain.length > 1 ? `Fallbacks, in order: ${modelChain.slice(1).join(', ')}` : 'No fallback configured.',
      'Click to choose a model.',
    ].join('\n');
  };

  const startMcp = async (): Promise<void> => {
    await mcp?.close();
    mcp = undefined;
    mcpToken ??= await loadToken(context.secrets);
    const listenPort = config().get<number>('mcpPort', 8799);
    try {
      mcp = await startEditorMcpServer({
        port,
        flow,
        context: engine,
        runner,
        ...(vscode.workspace.workspaceFolders?.[0] ? { shadowRoot: path.join(storageDir, 'shadow', workspaceId()) } : {}),
        token: mcpToken,
        listenPort,
        onToolCall: (record) => output.appendLine(`[tool] ${record.tool} ok=${String(record.ok)} ${JSON.stringify(record.args)}`),
      });
      output.appendLine(`MCP server listening on ${mcp.url}`);
    } catch (error) {
      const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      throw new Error(
        inUse
          ? `Port ${listenPort} is already in use, perhaps by another ForgeLens window. Close it, or change the forgelens.mcpPort setting.`
          : `The ForgeLens MCP server could not start: ${String(error)}`,
        { cause: error },
      );
    }
  };

  const runSetup = async (): Promise<string> => {
    try {
      if (!mcp) await startMcp();
      if (!mcp || !mcpToken) throw new Error('The ForgeLens MCP server is not running.');
      const result = await setUpTrueForge({
        baseUrl: baseUrl(),
        mcp: { url: mcp.url, token: mcpToken },
        configuredModels: config().get<string[]>('models', []),
        agents: AGENTS,
        reasoningEffort: config().get<string>('reasoningEffort', 'low'),
      });
      activeModel = result.model;
      modelChain = result.chain;
      banner = undefined;
      output.appendLine(`Set up TrueForge: model ${result.model}, agents ${JSON.stringify(result.agents)}`);
      if (result.note) {
        output.appendLine(result.note);
        void vscode.window.showWarningMessage(`ForgeLens: ${result.note}`);
      }
      controller.setModel(activeModel);
      return result.model;
    } catch (error) {
      banner = error instanceof Error ? error.message : String(error);
      output.appendLine(`Setup failed: ${banner}`);
      throw error;
    } finally {
      showStatus();
      panel.refresh();
    }
  };

  const controller = new AgentController({
    agentName: AGENT_NAME,
    onTurnStart: (readLimit) => mcp?.newTask(readLimit),
    baseUrl,
    sessions: () => testSessions?.api ?? sdk().sessions,
    createSession: async (agentName, model) => {
      if (testSessions) return testSessions.sessionId;
      // The saved agent carries the primary model. Any other model gets the same manifest with the model swapped.
      if (model === activeModel) return (await sdk().sessions.create({ agent: { name: agentName } })).data.id;
      const definition = AGENTS.find((candidate) => candidate.name === agentName);
      if (!definition) throw new Error(`No agent definition named ${agentName}.`);
      return createSessionForModel(baseUrl(), definition, model, fetch, { reasoningEffort: config().get<string>('reasoningEffort', 'low') });
    },
    models: () => modelChain,
    firstTokenMs: config().get<number>('firstTokenTimeoutSeconds', 20) * 1000,
    // Checked on every request: TrueForge may have stopped or a setting changed since activation.
    ensureReady: runSetup,
    onChange: () => {
      panel.refresh();
      inline.refresh();
      showStatus();
      if (controller.isBusy !== wasBusy) {
        wasBusy = controller.isBusy;
        void vscode.commands.executeCommand('setContext', 'forgelens.running', wasBusy);
      }
    },
    // By the resolved target, not the raw name: the model may reach it through call_tool.
    reviewApproval: (approval, signal) => (approval.call.name === APPLY_TOOL ? flow.requestReview(signal) : undefined),
    autoApprove: (approval) =>
      approval.call.name === RUN_COMMAND_TOOL &&
      isSafeCommand(String(approval.call.args['command'] ?? ''), config().get<string[]>('commands.autoApprove', [...DEFAULT_SAFE_COMMANDS])),
    // Stop also ends any test run still going: TrueForge waits for running tools before it can cancel.
    discardStaged: () => {
      flow.discard();
      runner.cancelAll();
    },
    onEvent: (event) => {
      if (event.type !== 'model.message.delta') {
        output.appendLine(`[event] ${event.type}${'threadId' in event && event.threadId ? ` thread=${event.threadId}` : ''}`);
      }
    },
  });

  const inline = new InlineEdit({ controller, flow, port, log: (message) => output.appendLine(message) });

  const sendToAgent = (text: string): Promise<void> =>
    sendAgentRequest(
      controller,
      engine,
      text,
      () => {
        const active = vscode.window.activeTextEditor;
        return {
          budgetTokens: config().get<number>('context.budgetTokens', DEFAULT_BUDGET_TOKENS),
          activeFile: active ? relativeOf(active.document.uri) : undefined,
          openFiles: vscode.window.visibleTextEditors.flatMap((editor) => relativeOf(editor.document.uri) ?? []),
        };
      },
      (message) => output.appendLine(message),
    );

  const undo = async (): Promise<UndoResult> => {
    const result = await flow.undoLast();
    if (result.ok) void vscode.window.showInformationMessage(result.message);
    else void vscode.window.showWarningMessage(`ForgeLens: ${result.message}`);
    return result;
  };

  const getState = (): PanelState => ({
    view: controller.view,
    busy: controller.isBusy,
    largeText: config().get<boolean>('panel.largeText', false),
    banner,
  });

  /** The TrueForge session page, beside the editor by default, so one window shows both. */
  const openSession = async (url: string): Promise<void> => {
    const uri = vscode.Uri.parse(url);
    if (config().get<string>('openSessionIn', 'simpleBrowser') === 'external') {
      await vscode.env.openExternal(uri);
      return;
    }
    try {
      await vscode.commands.executeCommand('simpleBrowser.api.open', uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    } catch {
      // The Simple Browser extension can be disabled; the system browser always works.
      await vscode.env.openExternal(uri);
    }
  };

  const panel = new AgentPanel(context.extensionUri, {
    getState,
    onSend: (text) => void sendToAgent(text),
    onStop: () => void controller.stop(),
    onDecide: (toolCallId, allow) => controller.decide(toolCallId, allow),
    onNewChat: () => controller.newChat(),
    onOpenSession: () => {
      const url = controller.view.sessionUrl;
      if (url) void openSession(url);
    },
    onSetup: () => void vscode.commands.executeCommand('forgelens.setup'),
    onReviewOpen: () => void vscode.commands.executeCommand('forgelens.review.open'),
    onReviewApply: () => void vscode.commands.executeCommand('forgelens.review.apply'),
    onUndo: () => void undo(),
    onSwitchModel: () => void vscode.commands.executeCommand('forgelens.pickModel'),
    onPickMention: () => {
      void pickMention(port).then((mention) => {
        if (mention) panel.insertMention(mention);
      });
    },
  });

  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const fileListChanged = (uri: vscode.Uri): void => {
    const relative = relativeOf(uri);
    if (!relative || NOT_WORKSPACE_FILES.test(relative)) return;
    clearTimeout(fileListTimer);
    fileListTimer = setTimeout(() => void engine.syncFileList().catch(() => undefined), FILE_LIST_SETTLE_MS);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    panel,
    review,
    inline,
    fileWatcher,
    fileWatcher.onDidCreate(fileListChanged),
    fileWatcher.onDidDelete(fileListChanged),
    // Changed outside the editor, for example by git.
    fileWatcher.onDidChange((uri) => {
      const relative = relativeOf(uri);
      if (relative && engine.index.files.has(relative)) void engine.noteFileChanged(relative).catch(() => undefined);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const relative = relativeOf(document.uri);
      if (relative && !NOT_WORKSPACE_FILES.test(relative)) void engine.noteFileChanged(relative).catch(() => undefined);
    }),
    new vscode.Disposable(() => engine.dispose()),
    vscode.commands.registerCommand('forgelens.editSelection', () => inline.run()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.reason !== vscode.TextDocumentChangeReason.Undo || event.document.uri.scheme !== 'file') return;
      if (!flow.lastAppliedTouches(vscode.workspace.asRelativePath(event.document.uri, false).replace(/\\/g, '/'))) return;
      // One Ctrl+Z changes several documents in a burst, so wait for it to end.
      clearTimeout(editorUndoTimer);
      editorUndoTimer = setTimeout(() => {
        void flow.syncAfterEditorUndo().then((result) => {
          if (result?.ok) void vscode.window.showInformationMessage(result.message);
        });
      }, EDITOR_UNDO_SETTLE_MS);
    }),
    vscode.commands.registerCommand('forgelens.undo', undo),
    vscode.commands.registerCommand('forgelens.pickModel', async () => {
      let available: string[];
      try {
        available = await listModels(baseUrl());
      } catch (error) {
        void vscode.window.showErrorMessage(`ForgeLens: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const configured = config().get<string[]>('models', []);
      const items = available.map((name) => ({
        label: name,
        description: name === activeModel ? 'primary now' : configured.includes(name) ? `fallback ${configured.indexOf(name)}` : '',
      }));
      const pick = await vscode.window.showQuickPick(items, { title: 'Choose the primary model. The others in forgelens.models stay as fallbacks.' });
      if (!pick) return;
      // The picked model goes first; the existing order of the rest is kept as the fallback chain.
      await config().update('models', [pick.label, ...configured.filter((name) => name !== pick.label)], vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('forgelens.setup', async () => {
      try {
        const model = await runSetup();
        void vscode.window.showInformationMessage(`ForgeLens is set up with ${model}.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`ForgeLens: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('forgelens.stop', () => void controller.stop()),
    vscode.commands.registerCommand('forgelens.newChat', () => controller.newChat()),
    // Used by the end-to-end test, and by anything else that wants to drive the panel.
    vscode.commands.registerCommand('forgelens.ask', (text: string) => sendToAgent(text)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('forgelens.panel')) panel.refresh();
      if (event.affectsConfiguration('forgelens.firstTokenTimeoutSeconds')) {
        void vscode.window.showInformationMessage('ForgeLens: the new timeout applies after a window reload.');
      }
      if (event.affectsConfiguration('forgelens.models') || event.affectsConfiguration('forgelens.trueforgeUrl')) {
        void runSetup().catch(() => undefined);
      }
      if (event.affectsConfiguration('forgelens.mcpPort')) {
        void startMcp()
          .then(runSetup)
          .catch((error: unknown) => {
            banner = error instanceof Error ? error.message : String(error);
            showStatus();
            panel.refresh();
          });
      }
    }),
    new vscode.Disposable(() => void mcp?.close()),
  );

  // Test hooks, only in the end-to-end test's window: they hand out the MCP token and replace the server.
  if (process.env['FORGELENS_E2E'] === '1') {
    context.subscriptions.push(
      vscode.commands.registerCommand('forgelens.internal.state', getState),
      vscode.commands.registerCommand('forgelens.internal.answerInput', (value: string) => inline.answerInputForTest(value)),
      vscode.commands.registerCommand('forgelens.internal.click', (selector: string) => panel.clickForTest(selector)),
      vscode.commands.registerCommand('forgelens.internal.pressCtrlZ', () => panel.pressCtrlZForTest()),
      vscode.commands.registerCommand('forgelens.internal.read', (selector: string) => panel.readForTest(selector)),
      vscode.commands.registerCommand('forgelens.internal.inView', (selector: string) => panel.inViewForTest(selector)),
      vscode.commands.registerCommand('forgelens.internal.type', (text: string) => panel.typeForTest(text)),
      vscode.commands.registerCommand('forgelens.internal.mcp', () => ({ url: mcp?.url, token: mcpToken })),
      vscode.commands.registerCommand('forgelens.internal.openSession', (url: string) => openSession(url)),
      vscode.commands.registerCommand('forgelens.internal.hunks', () =>
        flow.changeset.hunks.map((hunk) => ({ id: hunk.id, path: hunk.path, newStart: hunk.newStart, lines: hunk.lines, decision: flow.decisionOf(hunk.id) })),
      ),
      vscode.commands.registerCommand('forgelens.internal.useSessions', (next: TestSessions | undefined) => {
        testSessions = next;
      }),
    );
  }

  stopOnClose = () => controller.stop();

  // In the background and in slices, so the editor stays free. The first request waits for it if it must.
  void engine.ensureBuilt().catch((error: unknown) => output.appendLine(`Indexing did not run: ${String(error)}`));

  showStatus();
  // Failure here is normal when TrueForge is not started yet: the banner says what to do.
  void runSetup().catch(() => undefined);
}

/**
 * A turn keeps running on the server after the editor closes, spending quota, unless told to stop. VS Code
 * waits briefly for this promise, which a fire-and-forget request during dispose would not get.
 */
export function deactivate(): Promise<void> | undefined {
  return stopOnClose?.();
}
