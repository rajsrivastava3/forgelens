/**
 * Runs the exact tasks with no VS Code window: the same controller, MCP server, review flow and context engine as
 * the extension, on the Node editor port. The only stand-in is the person, who accepts every hunk.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { APPLY_TOOL, ReviewFlow } from '../../src/core/changeset/reviewFlow';
import { ContextEngine } from '../../src/core/context/engine';
import { startEditorMcpServer, type RunningEditorMcpServer, MCP_TOKEN_HEADER } from '../../src/core/mcp/server';
import { NodeEditorPort } from '../../src/core/tools/nodeEditorPort';
import { CommandRunner, DEFAULT_SAFE_COMMANDS, isSafeCommand, RUN_COMMAND_TOOL } from '../../src/core/tools/runCommand';
import { AgentController } from '../../src/core/trueforge/agentController';
import type { ViewItem } from '../../src/core/trueforge/runView';
import { createSessionForModel, setUpTrueForge, type AgentDefinition } from '../../src/core/trueforge/setup';
import type { SessionsApi } from '../../src/core/trueforge/turnRunner';

export const exec = promisify(execFile);
export const ROOT = path.resolve(__dirname, '../..');
export const FLASK = path.resolve(ROOT, '../flask');
export const VENV_SCRIPTS = path.join(FLASK, '.venv/Scripts');
export const PYTHON = path.join(VENV_SCRIPTS, 'python.exe');
export const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
export const BASE_URL = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const MCP_PORT = Number(process.env['FORGELENS_MCP_PORT'] ?? 8799);
const MIN_FREE_RAM_MB = 1000;

/**
 * USD per million tokens, from Google's published paid-tier prices (checked 6 Nov 2026, valid to 31 Dec 2026).
 * TrueForge reports no cost for these models, so cost is worked out here. Reasoning tokens are added to output
 * as well, which may count them twice: an estimate that can only run high. Unlisted models count as free.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'google-gemini/gemini-3-8-flash': { input: 0.75, output: 3.75 },
  'google-gemini/gemini-3-6-flash': { input: 0.75, output: 3.75 },
};
/** A high exchange rate, so the rupee cap is reached early rather than late. */
export const INR_PER_USD = 90;
const SPEND_FILE = path.join(path.resolve(__dirname, '../..'), 'out', 'spend.json');
const SPEND_CAP_INR = Number(process.env['FORGELENS_SPEND_CAP_INR'] ?? 150);

export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number, reasoning: number): number {
  const price = PRICES[model];
  return price ? (tokensIn * price.input + (tokensOut + reasoning) * price.output) / 1_000_000 : 0;
}

export function spentInr(): number {
  try {
    return (JSON.parse(readFileSync(SPEND_FILE, 'utf8')) as { inr: number }).inr;
  } catch {
    return 0;
  }
}

export function addSpend(usd: number, label: string): number {
  const total = spentInr() + usd * INR_PER_USD;
  let log: { inr: number; entries: { label: string; inr: number; at: string }[] } = { inr: 0, entries: [] };
  try {
    log = JSON.parse(readFileSync(SPEND_FILE, 'utf8')) as typeof log;
  } catch {
    // First entry.
  }
  log.inr = total;
  log.entries.push({ label, inr: usd * INR_PER_USD, at: new Date().toISOString() });
  mkdirSync(path.dirname(SPEND_FILE), { recursive: true });
  writeFileSync(SPEND_FILE, JSON.stringify(log, null, 2));
  return total;
}

/** Stops before a run that would start over the cap. A run on models with no price spends nothing, so it may go ahead. */
export function checkSpend(models: readonly string[] = Object.keys(PRICES)): void {
  const spent = spentInr();
  if (spent >= SPEND_CAP_INR && models.some((model) => PRICES[model] !== undefined)) {
    console.error(`Stopped: Rs ${spent.toFixed(2)} spent in this run, at or over the Rs ${SPEND_CAP_INR} cap.`);
    process.exit(5);
  }
}
const MIN_FREE_DISK_GB = 2;

export function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Stops before starting, rather than being stopped halfway by the machine. */
export function checkResources(): void {
  const freeMb = Math.round(os.freemem() / 1024 ** 2);
  if (freeMb < MIN_FREE_RAM_MB) {
    console.error(`Stopped: ${freeMb} MB of RAM free, and a headless run needs ${MIN_FREE_RAM_MB} MB.`);
    process.exit(3);
  }
  const { bavail, bsize } = statfsSync(`${process.env['SystemDrive'] ?? 'C:'}\\`);
  const freeGb = (Number(bavail) * Number(bsize)) / 1024 ** 3;
  if (freeGb < MIN_FREE_DISK_GB) {
    console.error(`Stopped: ${freeGb.toFixed(1)} GB of disk free, and a run needs ${MIN_FREE_DISK_GB} GB.`);
    process.exit(3);
  }
  console.log(`Resources: ${freeMb} MB RAM free, ${freeGb.toFixed(1)} GB disk free.`);
}

/** A fresh throwaway clone. The real flask folder is only ever the source of the clone. */
export function freshClone(workDir: string): string {
  const clone = path.join(workDir, 'flask-clone');
  rmSync(clone, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  execFileSync('git', ['clone', '--quiet', '-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', FLASK, clone]);
  if (path.resolve(clone).toLowerCase().startsWith(path.resolve(FLASK).toLowerCase())) throw new Error('The clone is inside the real flask folder.');
  return clone;
}

export function resetClone(clone: string): void {
  execFileSync('git', ['-C', clone, 'checkout', '--quiet', '--', '.']);
  execFileSync('git', ['-C', clone, 'clean', '-fdq']);
}

export function verifyEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${VENV_SCRIPTS}${path.delimiter}${process.env['PATH'] ?? ''}`, PYTHONPATH: 'src', PYTHONDONTWRITEBYTECODE: '1', ...extra };
}

function loadAgents(): AgentDefinition[] {
  return ['forgelens-agent', 'forgelens-inline'].map((name) => JSON.parse(readFileSync(path.join(ROOT, 'agents', `${name}.json`), 'utf8')) as AgentDefinition);
}

export interface ToolRecord {
  name: string;
  thread: string;
  args: string;
  status: string;
  autoApproved: boolean;
  result: string;
}

export interface RunRecord {
  model: string;
  /** Every model that was asked, in order, and the notices the chain showed. */
  modelsTried: string[];
  notices: string[];
  /** Set when the cost guard stopped the run. */
  stoppedForCost: boolean;
  /** Tokens of each model request, in order, with the thread it came from. */
  perRequest: { thread: string; input: number; output: number; cached: number }[];
  status: string;
  error: string | undefined;
  sessionUrl: string | undefined;
  seconds: number;
  /** From the instruction until the review opened, which is when the diff exists. */
  secondsToDiff: number | undefined;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  threads: string[];
  tools: ToolRecord[];
  files: string[];
  hunks: number;
  reviewCard: string | undefined;
  reviewNote: string | undefined;
  contextFiles: string[];
  contextTokens: string | undefined;
  answer: string;
  log: string[];
}

export interface Harness {
  workspace: string;
  flow: ReviewFlow;
  engine: ContextEngine;
  port: NodeEditorPort;
  controller: AgentController;
  log: (message: string) => void;
  callTool: (name: string, args: unknown) => Promise<string>;
  /** Everything gathered so far. */
  record: (seconds: number) => RunRecord;
  close: () => Promise<void>;
}

function collectTools(items: readonly ViewItem[], thread = 'main'): ToolRecord[] {
  return items.flatMap((item): ToolRecord[] => {
    if (item.kind === 'thread') return collectTools(item.items, item.title);
    if (item.kind !== 'tool') return [];
    return [{ name: item.name, thread, args: item.argsSummary, status: item.status, autoApproved: item.autoApproved === true, result: item.result ?? '' }];
  });
}

/** The most one run may cost before it is stopped mid-turn. The total cap is checked between runs as well. */
const RUN_COST_GUARD_USD = Number(process.env['FORGELENS_RUN_GUARD_INR'] ?? 20) / INR_PER_USD;

/** Makes `sessionsOverride` the server, for a dry run with no model. `models` is the chain, primary first. */
export async function startHarness(
  workspace: string,
  modelOrChain: string | readonly string[],
  sessionsOverride?: (callTool: Harness['callTool']) => SessionsApi,
  hooks: { onFallback?: () => void } = {},
): Promise<Harness> {
  const chain = typeof modelOrChain === 'string' ? [modelOrChain] : [...modelOrChain];
  const model = chain[0] as string;
  const modelsTried: string[] = [];
  let stoppedForCost = false;
  let primary = model;
  let liveCostUsd = 0;
  const perRequest: { thread: string; input: number; output: number; cached: number }[] = [];
  const usageIndex = new Map<string, number>();
  let noticeCount = 0;
  const port = new NodeEditorPort(workspace);
  const logLines: string[] = [];
  const log = (message: string): void => {
    logLines.push(message);
    if (process.env['REHEARSE_VERBOSE']) console.log(`  ${message}`);
  };
  const runner = new CommandRunner();
  const engine = new ContextEngine(port, { log });
  const token = randomBytes(24).toString('hex');
  let started = Date.now();
  let firstReviewMs: number | undefined;
  let hunks = 0;
  let files: string[] = [];
  let requests = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let reasoningTokens = 0;
  const messageIds = new Set<string>();

  const flow: ReviewFlow = new ReviewFlow(port, { onCard: (card) => controller.updateReview(card), onWarning: log });
  // The server is created before the controller exists, as the extension does it.
  const mcp: RunningEditorMcpServer = await startEditorMcpServer({
    port,
    flow,
    context: engine,
    runner,
    token,
    listenPort: MCP_PORT,
    shadowRoot: path.join(path.dirname(workspace), 'shadow'),
    onToolCall: (call) => log(`[tool] ${call.tool} ok=${String(call.ok)}`),
  });
  const callTool: Harness['callTool'] = async (name, args) => {
    const response = await fetch(mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [MCP_TOKEN_HEADER]: token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = (await response.json()) as { result?: { content: { text: string }[]; isError?: boolean } };
    return body.result?.content[0]?.text ?? JSON.stringify(body);
  };

  const client = new TrueForge({ baseUrl: BASE_URL, timeoutInSeconds: 600 });
  const scripted = sessionsOverride?.(callTool);
  const controller: AgentController = new AgentController({
    agentName: 'forgelens-agent',
    baseUrl: () => BASE_URL,
    sessions: () => scripted ?? client.sessions,
    createSession: async (agentName, sessionModel) => {
      modelsTried.push(sessionModel);
      if (scripted) return `scripted-${randomBytes(4).toString('hex')}`;
      // As the extension does: the saved agent for the primary, the same manifest with the model swapped for the rest.
      if (sessionModel === primary) return (await client.sessions.create({ agent: { name: agentName } })).data.id;
      const definition = loadAgents().find((candidate) => candidate.name === agentName);
      if (!definition) throw new Error(`No agent named ${agentName}.`);
      return createSessionForModel(BASE_URL, definition, sessionModel);
    },
    ensureReady: async () => {
      if (scripted) return model;
      const result = await setUpTrueForge({ baseUrl: BASE_URL, mcp: { url: mcp.url, token }, configuredModels: chain, agents: loadAgents() });
      primary = result.model;
      return result.model;
    },
    models: () => chain,
    firstTokenMs: Number(process.env['FORGELENS_FIRST_TOKEN_S'] ?? 45) * 1000,
    onChange: () => {
      const count = controller.view.items.filter((item) => item.kind === 'notice' && item.tone === 'warning').length;
      if (count > noticeCount) {
        noticeCount = count;
        hooks.onFallback?.();
      }
    },
    autoApprove: (approval) => approval.call.name === RUN_COMMAND_TOOL && isSafeCommand(String(approval.call.args['command'] ?? ''), DEFAULT_SAFE_COMMANDS),
    // The person in this script accepts every hunk at once. All else is what the extension does.
    reviewApproval: (approval, signal) => {
      // No one is here to approve anything else, so it is declined with the reason, rather than waiting forever.
      if (approval.call.name === RUN_COMMAND_TOOL) {
        log(`[declined] run_command ${JSON.stringify(approval.call.args)}`);
        return Promise.resolve({ allow: false, reason: 'Not on the safe list, and nobody can approve it in this headless rehearsal. Use run_command only to run tests, with target "staged".' });
      }
      if (approval.call.name !== APPLY_TOOL) return undefined;
      const decision = flow.requestReview(signal);
      noteReview();
      if (flow.isReviewing) {
        flow.setAll('accepted');
        void flow.applyDecisions();
      }
      return decision;
    },
    discardStaged: () => {
      flow.discard();
      runner.cancelAll();
    },
    onEvent: (event) => {
      if (event.type === 'model.message' && !messageIds.has(event.id)) {
        messageIds.add(event.id);
        requests += 1;
      }
      // Each message reports its tokens, so a runaway turn is caught while it runs, not after. The stream sends the
      // message as an empty shell and the usage in a later delta, so both are read, keyed by message id.
      if ((event.type === 'model.message' || event.type === 'model.message.delta') && event.usage) {
        const request = { thread: event.threadId === 'main' ? 'main' : 'sub', input: event.usage.inputTokens ?? 0, output: event.usage.outputTokens ?? 0, cached: event.usage.cacheReadTokens ?? 0 };
        const index = usageIndex.get(event.id);
        if (index === undefined) {
          usageIndex.set(event.id, perRequest.length);
          perRequest.push(request);
        } else {
          perRequest[index] = request;
        }
        liveCostUsd = perRequest.reduce((sum, item) => sum + estimateCostUsd(controller.activeModel ?? model, item.input, item.output, 0), 0);
        if (liveCostUsd > RUN_COST_GUARD_USD && !stoppedForCost) {
          stoppedForCost = true;
          log(`[cost guard] about Rs ${(liveCostUsd * INR_PER_USD).toFixed(2)} spent in this run, over the guard. Stopping.`);
          void controller.stop();
        }
      }
      if (event.type === 'turn.done') {
        const metrics = 'metrics' in event.state ? event.state.metrics : undefined;
        tokensIn += metrics?.totalInputTokens ?? 0;
        tokensOut += metrics?.totalOutputTokens ?? 0;
        reasoningTokens += metrics?.totalReasoningTokens ?? 0;
        costUsd += metrics?.totalCostInUsd ?? 0;
      }
    },
  });
  const noteReview = (): void => {
    firstReviewMs ??= Date.now() - started;
    if (flow.changeset.files.length > 0) {
      files = flow.changeset.files.map((file) => file.path);
      hunks = flow.changeset.hunks.length;
    }
  };

  return {
    workspace,
    flow,
    engine,
    port,
    controller,
    log,
    callTool,
    record: (seconds) => {
      const { view } = controller;
      const review = [...view.items].reverse().find((item) => item.kind === 'review');
      const context = view.items.find((item) => item.kind === 'context');
      const threads = view.items.flatMap((item) => (item.kind === 'thread' ? [item.title] : []));
      return {
        model: controller.activeModel ?? model,
        modelsTried,
        notices: view.items.flatMap((item) => (item.kind === 'notice' ? [item.text] : [])),
        stoppedForCost,
        perRequest,
        status: view.status,
        error: view.error,
        sessionUrl: view.sessionUrl,
        seconds,
        secondsToDiff: firstReviewMs === undefined ? undefined : firstReviewMs / 1000,
        requests,
        tokensIn,
        tokensOut,
        costUsd: costUsd || estimateCostUsd(controller.activeModel ?? model, tokensIn, tokensOut, reasoningTokens),
        threads,
        tools: collectTools(view.items),
        files,
        hunks,
        reviewCard: review?.kind === 'review' ? review.text : undefined,
        reviewNote: review?.kind === 'review' ? review.warning : undefined,
        contextFiles: context?.kind === 'context' ? context.items.map((item) => `${item.mode}: ${item.path}`) : [],
        contextTokens: context?.kind === 'context' ? `${context.usedTokens} of ${context.budgetTokens}` : undefined,
        answer: view.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('\n'),
        log: logLines,
      };
    },
    close: async () => {
      engine.dispose();
      await mcp.close();
      started = Date.now();
    },
  };
}

/** A quota or billing refusal, as opposed to the task going wrong. */
export function isModelBlocked(error: string | undefined): boolean {
  return /\b(429|402)\b|quota|prepayment|credits are depleted/i.test(error ?? '');
}

export function writeResults(name: string, results: unknown): void {
  const file = path.join(ROOT, 'out', `${name}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`Full results: ${file}`);
}
