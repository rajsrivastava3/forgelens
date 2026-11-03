import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { RunView, ToolItem, ViewItem } from '../../src/core/trueforge/runView';
import type { PanelState } from '../../src/vscode/protocol';

const exec = promisify(execFile);
const root = process.env['FORGELENS_E2E_ROOT'] ?? '.';
const workspace = process.env['FORGELENS_E2E_WORKSPACE'] ?? '.';
const scenarios = (process.env['FORGELENS_E2E_SCENARIOS'] ?? '').split(',');
const shots = path.join(root, 'docs/screenshots');
const results: Record<string, unknown> = {};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const state = (): Thenable<PanelState> => vscode.commands.executeCommand<PanelState>('forgelens.internal.state');
const click = (selector: string): Thenable<{ clicked: boolean; reactionMs: number; statusText: string }> =>
  vscode.commands.executeCommand('forgelens.internal.click', selector);

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

function toolsOf(items: readonly ViewItem[]): ToolItem[] {
  return items.flatMap((item) => (item.kind === 'tool' ? [item] : item.kind === 'thread' ? toolsOf(item.items) : []));
}

function textOf(view: RunView): string {
  return view.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('\n');
}

async function shot(name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await sleep(250); // Lets the throttled webview paint the latest state.
  try {
    await exec('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'test/e2e/screenshot.ps1'),
      path.join(shots, `${name}.png`),
    ]);
    log(`screenshot ${name}`);
  } catch (error) {
    log(`screenshot ${name} failed: ${String(error)}`);
    results[`screenshot-${name}`] = String(error);
  }
}

async function waitFor(what: string, test: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function gitStatus(): Promise<string> {
  return (await exec('git', ['-C', workspace, 'status', '--porcelain'])).stdout.trim();
}

async function newChat(): Promise<void> {
  await vscode.commands.executeCommand('forgelens.newChat');
  await sleep(100);
}

async function scenarioAsk(): Promise<void> {
  const question = 'where is get_debug_flag defined and what values does it treat as false?';
  const asked = Date.now();
  const running = vscode.commands.executeCommand('forgelens.ask', question);

  // Samples what the panel holds, to show the text really grows token by token.
  const lengths: { atMs: number; chars: number }[] = [];
  let firstTool = 0;
  let midShot = false;
  let done = false;
  void Promise.resolve(running).then(() => {
    done = true;
  });
  while (!done) {
    const { view } = await state();
    const chars = textOf(view).length;
    if (chars !== lengths.at(-1)?.chars) lengths.push({ atMs: Date.now() - asked, chars });
    if (!firstTool && toolsOf(view.items).length > 0) firstTool = Date.now() - asked;
    if (!midShot && (chars > 0 || toolsOf(view.items).some((tool) => tool.status === 'done'))) {
      midShot = true;
      await shot('p1-1-streaming');
    }
    await sleep(15);
  }
  await running;
  const { view } = await state();
  await shot('p1-2-answer-with-tool-cards');
  results['ask'] = {
    status: view.status,
    error: view.error,
    sessionUrl: view.sessionUrl,
    model: view.model,
    tools: toolsOf(view.items).map((tool) => ({
      name: tool.name,
      args: tool.argsSummary,
      status: tool.status,
      ms: tool.durationMs,
      viaCallTool: tool.viaCallTool,
    })),
    answer: textOf(view),
    distinctTextLengthsSeen: lengths.length,
    textGrowth: lengths.slice(0, 12),
    firstToolMs: firstTool,
    totalMs: Date.now() - asked,
    gitStatus: await gitStatus(),
  };
}

async function scenarioStop(): Promise<void> {
  await newChat();
  const running = vscode.commands.executeCommand(
    'forgelens.ask',
    'Read every Python file under src/flask one at a time, then write a detailed summary of each file.',
  );
  // Waits for real activity, so this interrupts a generation instead of racing the session start.
  const activeAt = Date.now();
  await waitFor(
    'agent activity',
    async () => {
      const { view } = await state();
      return toolsOf(view.items).length > 0 || textOf(view).length > 0 || view.status === 'error';
    },
    60_000,
  );
  const before = await state();
  await shot('p1-3-running-before-stop');

  const pressed = Date.now();
  const probe = await click('#stop');
  const roundTripMs = Date.now() - pressed;
  await shot('p1-4-stopping');
  let cancelledAfterMs: number | undefined;
  await Promise.race([
    Promise.resolve(running).then(() => {
      cancelledAfterMs = Date.now() - pressed;
    }),
    sleep(30_000),
  ]);
  const { view, busy } = await state();
  await shot('p1-5-stopped');
  results['stop'] = {
    statusBefore: before.view.status,
    errorBefore: before.view.error,
    toolsBefore: toolsOf(before.view.items).length,
    activityAfterMs: pressed - activeAt,
    clicked: probe.clicked,
    pageReactionMs: probe.reactionMs,
    pageStatusTextRightAfterClick: probe.statusText,
    clickRoundTripMs: roundTripMs,
    cancelledAfterMs,
    finalStatus: view.status,
    finalStatusText: view.statusText,
    stillBusy: busy,
    openToolCards: toolsOf(view.items).filter((tool) => tool.status === 'running').length,
    sessionUrl: view.sessionUrl,
    gitStatus: await gitStatus(),
  };
}

async function runApproval(decision: 'allow' | 'deny', shotName: string): Promise<Record<string, unknown>> {
  await newChat();
  const marker = `e2e-${decision}-${Date.now()}`;
  const before = await vscode.commands.executeCommand<string[]>('forgelens.internal.gatedToolCalls');
  const running = vscode.commands.executeCommand(
    'forgelens.ask',
    `Call the apply_changes tool on the forgelens-editor server exactly once, with summary "${marker}". If it is declined, do not retry; say so and stop.`,
  );
  await waitFor(
    'the approval card',
    async () => {
      const { view } = await state();
      return view.status === 'awaiting-approval' || view.status === 'error' || view.status === 'done';
    },
    90_000,
  );
  const paused = await state();
  const card = toolsOf(paused.view.items).find((tool) => tool.status === 'awaiting-approval');
  const ranBeforeDecision = (await vscode.commands.executeCommand<string[]>('forgelens.internal.gatedToolCalls')).filter(
    (summary) => summary === marker,
  ).length;
  await shot(shotName);
  const button = decision === 'allow' ? 'primary' : 'secondary';
  const probe = await click(`.status-awaiting-approval .approval button.${button}`);
  await Promise.race([running, sleep(60_000)]);
  const after = await state();
  const calls = await vscode.commands.executeCommand<string[]>('forgelens.internal.gatedToolCalls');
  return {
    pausedStatus: paused.view.status,
    error: paused.view.error ?? after.view.error,
    cardName: card?.name,
    cardArgs: card?.argsSummary,
    viaCallTool: card?.viaCallTool,
    ranBeforeDecision,
    clicked: probe.clicked,
    ranAfterDecision: calls.slice(before.length).filter((summary) => summary === marker).length,
    finalStatus: after.view.status,
    finalCardStatus: toolsOf(after.view.items).find((tool) => tool.name === 'apply_changes')?.status,
    sessionUrl: after.view.sessionUrl,
  };
}

async function scenarioApproval(): Promise<void> {
  const allow = await runApproval('allow', 'p1-6-approval-card');
  await shot('p1-7-approval-allowed');
  const deny = await runApproval('deny', 'p1-8-approval-before-deny');
  await shot('p1-9-approval-denied');
  results['approval'] = { allow, deny, gitStatus: await gitStatus() };
}

async function scenarioOffline(): Promise<void> {
  await newChat();
  const settings = vscode.workspace.getConfiguration('forgelens');
  await settings.update('trueforgeUrl', 'http://localhost:1', vscode.ConfigurationTarget.Global);
  await waitFor('the offline banner', async () => (await state()).banner !== undefined, 15_000);
  const asked = Date.now();
  await vscode.commands.executeCommand('forgelens.ask', 'hello');
  const { view, banner } = await state();
  await shot('p1-10-trueforge-not-running');
  results['offline'] = { banner, error: view.error, status: view.status, answeredInMs: Date.now() - asked, gitStatus: await gitStatus() };
  await settings.update('trueforgeUrl', undefined, vscode.ConfigurationTarget.Global);
  await waitFor('reconnecting', async () => (await state()).banner === undefined, 15_000);
  results['offlineRecovered'] = true;
}

export async function run(): Promise<void> {
  const started = Date.now();
  const failures: string[] = [];
  try {
    await vscode.commands.executeCommand('workbench.view.extension.forgelens');
    await vscode.commands.executeCommand('forgelens.panel.focus');
    const helpers = await vscode.workspace.openTextDocument(path.join(workspace, 'src/flask/helpers.py'));
    await vscode.window.showTextDocument(helpers, { preview: false, preserveFocus: true });
    await waitFor('setup to finish', async () => (await state()).view.model !== undefined, 30_000, 100);
    await sleep(1000);
    await shot('p1-0-panel-ready');

    const table: Record<string, () => Promise<void>> = {
      ask: scenarioAsk,
      stop: scenarioStop,
      approval: scenarioApproval,
      offline: scenarioOffline,
    };
    for (const name of scenarios) {
      const scenario = table[name];
      if (!scenario) continue;
      log(`scenario ${name}`);
      try {
        await scenario();
      } catch (error) {
        failures.push(`${name}: ${String(error)}`);
        await shot(`failed-${name}`);
      }
    }
  } finally {
    results['failures'] = failures;
    results['totalSeconds'] = Math.round((Date.now() - started) / 1000);
    const out = path.join(root, 'out/e2e-results.json');
    writeFileSync(out, JSON.stringify(results, null, 2));
    log(`results in ${out}`);
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}
