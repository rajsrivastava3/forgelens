import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import { z } from 'zod';
import agentDefinition from '../../agents/forgelens-agent.json';
import inlineDefinition from '../../agents/forgelens-inline.json';
import { startEditorMcpServer, type RunningEditorMcpServer } from '../core/mcp/server';
import { AgentController } from '../core/trueforge/agentController';
import { setUpTrueForge, type AgentDefinition } from '../core/trueforge/setup';
import { AgentPanel } from './agentPanel';
import type { PanelState } from './protocol';
import { VscodeEditorPort } from './vscodeEditorPort';

const TOKEN_SECRET = 'forgelens.mcpToken';
const AGENT_NAME = 'forgelens-agent';
const AGENTS: AgentDefinition[] = [agentDefinition, inlineDefinition];
const e2eGatedToolCalls: string[] = [];

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
  statusBar.command = 'forgelens.setup';
  statusBar.show();
  context.subscriptions.push(output, statusBar);

  const port = new VscodeEditorPort();
  let mcp: RunningEditorMcpServer | undefined;
  let mcpToken: string | undefined;
  let banner: string | undefined;
  let activeModel: string | undefined;
  let client: TrueForge | undefined;
  let clientUrl: string | undefined;

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
    } else {
      statusBar.text = `$(telescope) ${activeModel ?? 'ForgeLens'}`;
      statusBar.tooltip = activeModel ? `ForgeLens model: ${activeModel}` : 'ForgeLens';
    }
  };

  const startMcp = async (): Promise<void> => {
    await mcp?.close();
    mcp = undefined;
    mcpToken ??= await loadToken(context.secrets);
    const listenPort = config().get<number>('mcpPort', 8799);
    try {
      mcp = await startEditorMcpServer({
        port,
        token: mcpToken,
        listenPort,
        onToolCall: (record) => output.appendLine(`[tool] ${record.tool} ok=${String(record.ok)} ${JSON.stringify(record.args)}`),
        // Until P2 adds the real tool, the end-to-end test needs something the agent's gate applies to.
        ...(process.env['FORGELENS_E2E_GATED_TOOL'] === '1' ? { configure: registerE2eGatedTool } : {}),
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
      });
      activeModel = result.model;
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
    baseUrl,
    sessions: () => sdk().sessions,
    createSession: async () => (await sdk().sessions.create({ agent: { name: AGENT_NAME } })).data.id,
    // Checked on every request: TrueForge may have stopped or a setting changed since activation.
    ensureReady: runSetup,
    onChange: () => panel.refresh(),
    onEvent: (event) => {
      if (event.type !== 'model.message.delta') {
        output.appendLine(`[event] ${event.type}${'threadId' in event && event.threadId ? ` thread=${event.threadId}` : ''}`);
      }
    },
  });

  const getState = (): PanelState => ({
    view: controller.view,
    busy: controller.isBusy,
    largeText: config().get<boolean>('panel.largeText', false),
    banner,
  });

  const panel = new AgentPanel(context.extensionUri, {
    getState,
    onSend: (text) => void controller.send(text),
    onStop: () => controller.stop(),
    onDecide: (toolCallId, allow) => controller.decide(toolCallId, allow),
    onNewChat: () => controller.newChat(),
    onOpenSession: () => {
      const url = controller.view.sessionUrl;
      if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
    },
    onSetup: () => void vscode.commands.executeCommand('forgelens.setup'),
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    panel,
    vscode.commands.registerCommand('forgelens.setup', async () => {
      try {
        const model = await runSetup();
        void vscode.window.showInformationMessage(`ForgeLens is set up with ${model}.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`ForgeLens: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('forgelens.stop', () => controller.stop()),
    vscode.commands.registerCommand('forgelens.newChat', () => controller.newChat()),
    // Used by the end-to-end test, and by anything else that wants to drive the panel.
    vscode.commands.registerCommand('forgelens.ask', (text: string) => controller.send(text)),
    vscode.commands.registerCommand('forgelens.internal.state', getState),
    vscode.commands.registerCommand('forgelens.internal.gatedToolCalls', () => [...e2eGatedToolCalls]),
    vscode.commands.registerCommand('forgelens.internal.click', (selector: string) => panel.clickForTest(selector)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('forgelens.panel')) panel.refresh();
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

  showStatus();
  // Failure here is normal when TrueForge is not started yet: the banner says what to do.
  void runSetup().catch(() => undefined);
}

function registerE2eGatedTool(server: McpServer): void {
  server.registerTool(
    'apply_changes',
    {
      description: 'Test stand-in: records that it ran and changes nothing.',
      inputSchema: { summary: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => {
      e2eGatedToolCalls.push(args.summary);
      return { content: [{ type: 'text', text: `test tool ran: ${args.summary}` }] };
    },
  );
}

export function deactivate(): void {}
