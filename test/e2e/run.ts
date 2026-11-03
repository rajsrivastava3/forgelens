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
const GAP_MS = Number(process.env['FORGELENS_E2E_GAP_S'] ?? 65) * 1000;
const SCENARIO_LIMIT_MS = 150_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// A copy: the command hands back the live view, and these checks compare moments in time.
const state = async (): Promise<PanelState> =>
  structuredClone(await vscode.commands.executeCommand<PanelState>('forgelens.internal.state'));
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

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`Check failed: ${what}`);
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
      await shot('p1-1-first-tool-card');
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
  check(view.status === 'done', `the answer finished (${view.error ?? view.status})`);
  check(toolsOf(view.items).some((tool) => tool.status === 'done' && !tool.system), 'a tool card finished');
  check(lengths.length >= 3, 'the text grew in steps');
  check((await gitStatus()) === '', 'the workspace is clean');
}

/** A long answer, so a screenshot can land while tokens are still arriving. */
async function scenarioStream(): Promise<void> {
  await newChat();
  const running = vscode.commands.executeCommand(
    'forgelens.ask',
    'Without using any tools, write about 400 words on what debug mode in a web framework is for.',
  );
  let done = false;
  void Promise.resolve(running).then(() => {
    done = true;
  });
  let charsAtShot = 0;
  while (!done) {
    const { view } = await state();
    const chars = textOf(view).length;
    if (chars > 0 && !charsAtShot) {
      charsAtShot = chars;
      await shot('p1-1-streaming-text');
      const later = await state();
      results['stream'] = { charsWhenShotStarted: chars, charsAfterShot: textOf(later.view).length, stillStreaming: later.busy };
      break;
    }
    await sleep(10);
  }
  await running;
  const { view } = await state();
  results['stream'] = { ...(results['stream'] as object), finalStatus: view.status, finalChars: textOf(view).length, error: view.error };
  check(view.status === 'done', `the long answer finished (${view.error ?? view.status})`);
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
  // No screenshot here: cancelling finishes before one can be taken. pageStatusText records it instead.
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
  check(before.view.status === 'running', `the agent was running when stopped (${before.view.error ?? before.view.status})`);
  check(probe.clicked, 'the Stop button was visible and clicked');
  check(probe.reactionMs < 100, 'the page reacted within 100 ms');
  check(probe.statusText === 'Stopping…', 'the page said Stopping');
  check(view.status === 'cancelled' && !busy, 'the run ended cancelled');
  check((await gitStatus()) === '', 'the workspace is clean');
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
  check(paused.view.status === 'awaiting-approval', `the run paused for approval (${paused.view.error ?? paused.view.status})`);
  check(ranBeforeDecision === 0, 'the tool did not run before the decision');
  check(probe.clicked, 'the decision button was visible and clicked');
  check(calls.slice(before.length).filter((summary) => summary === marker).length === (decision === 'allow' ? 1 : 0), 'the tool ran only if allowed');
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
  await sleep(GAP_MS);
  const deny = await runApproval('deny', 'p1-8-approval-before-deny');
  await shot('p1-9-approval-denied');
  results['approval'] = { allow, deny, gitStatus: await gitStatus() };
  check((await gitStatus()) === '', 'the workspace is clean');
}

/** Closes the window mid-run. launch.mjs then asks TrueForge whether the turn was stopped. */
async function scenarioClose(): Promise<void> {
  await newChat();
  void vscode.commands.executeCommand(
    'forgelens.ask',
    'Read every Python file under src/flask one at a time, then write a detailed summary of each file.',
  );
  await waitFor('agent activity', async () => {
    const { view } = await state();
    return toolsOf(view.items).length > 0 || view.status === 'error';
  }, 60_000);
  const { view } = await state();
  writeFileSync(path.join(root, 'out/e2e-close.json'), JSON.stringify({ status: view.status, sessionUrl: view.sessionUrl, error: view.error }));
  await vscode.commands.executeCommand('workbench.action.closeWindow');
  await sleep(10_000); // The window is closing, and this host goes with it.
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
  check(view.status === 'error' && (view.error ?? '').includes('TrueForge is not running'), 'the clear message appeared');
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
      stream: scenarioStream,
      stop: scenarioStop,
      approval: scenarioApproval,
      offline: scenarioOffline,
      close: scenarioClose,
    };
    for (const name of scenarios) {
      const scenario = table[name];
      if (!scenario) continue;
      log(`scenario ${name}`);
      try {
        // A slow provider must show up as a failure, not as a test that never ends.
        await Promise.race([
          scenario(),
          sleep(SCENARIO_LIMIT_MS).then(() => {
            throw new Error(`no result after ${SCENARIO_LIMIT_MS / 1000} s`);
          }),
        ]);
      } catch (error) {
        await vscode.commands.executeCommand('forgelens.stop');
        failures.push(`${name}: ${String(error)}`);
        await shot(`failed-${name}`);
      }
      // Free-tier models allow few requests per minute, so live scenarios need room between them.
      if (name !== 'offline' && name !== scenarios.at(-1)) await sleep(GAP_MS);
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
