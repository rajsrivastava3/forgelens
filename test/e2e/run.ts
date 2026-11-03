import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const SCENARIO_LIMIT_MS = 420_000;

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

const HELPERS = 'src/flask/helpers.py';
const GLOBALS = 'src/flask/globals.py';
const PROPOSED = 'forgelens-proposed';

interface HunkInfo {
  id: string;
  path: string;
  newStart: number;
  lines: string[];
  decision: string;
}

const hunks = (): Thenable<HunkInfo[]> => vscode.commands.executeCommand('forgelens.internal.hunks');
const onDisk = (file: string): string => readFileSync(path.join(workspace, file), 'utf8');
const applyToolArgs = { tool_name: 'apply_changes', mcp_server: 'forgelens-editor', input: { summary: 'Add two comments' } };

function diffTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === PROPOSED);
}

/** What TrueForge does when it calls a tool: a real HTTP request to the extension's MCP server. */
async function callMcpTool(name: string, args: unknown): Promise<string> {
  const mcp = await vscode.commands.executeCommand<{ url: string; token: string }>('forgelens.internal.mcp');
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forgelens-token': mcp.token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await response.json()) as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };
  const text = body.result?.content[0]?.text ?? JSON.stringify(body);
  if (body.result?.isError || body.error) throw new Error(name + ' failed: ' + text);
  return text;
}

async function stageThreeHunks(): Promise<void> {
  await callMcpTool('stage_edit', {
    path: HELPERS,
    edits: [
      { old_text: 'def get_debug_flag() -> bool:', new_text: '# Comment one, on the debug flag.\ndef get_debug_flag() -> bool:' },
      { old_text: 'def get_load_dotenv(default: bool = True) -> bool:', new_text: '# Comment two, on dotenv.\ndef get_load_dotenv(default: bool = True) -> bool:' },
    ],
  });
  await callMcpTool('stage_edit', {
    path: GLOBALS,
    edits: [{ old_text: '_no_app_msg = """\\', new_text: '# Comment three, in another file.\n_no_app_msg = """\\' }],
  });
}

let scriptedCounter = 0;
const stamp = (): string => new Date().toISOString();

/** Plays TrueForge's side with no model: the shape of each event comes from the recorded P0 sessions. */
function scriptedSessions(options: { waitBeforeCallMs?: number; onCancel?: () => void; onTurnStarted?: () => void } = {}): unknown {
  let cancelled: (() => void) | undefined;
  const events = async function* (input: { type: string; approval?: { status: string; reason?: string }; toolCallId?: string }[]): AsyncGenerator<{ data: unknown; id: string }> {
    scriptedCounter += 1;
    const id = (name: string): string => name + '-' + String(scriptedCounter);
    let seq = 0;
    const emit = (data: unknown): { data: unknown; id: string } => {
      seq += 1;
      return { data, id: String(seq) };
    };
    const done = (state: unknown): unknown => ({ type: 'turn.done', id: id('done'), createdAt: stamp(), state });
    const message = (mid: string, content: string, toolCalls: unknown[] = []): unknown => ({
      type: 'model.message',
      id: mid,
      threadId: 'main',
      createdAt: stamp(),
      content,
      toolCalls,
    });

    const decision = input[0];
    if (decision?.type !== 'user.tool_approval') {
      const wait = new Promise<'cancel' | 'go'>((resolve) => {
        cancelled = () => resolve('cancel');
        setTimeout(() => resolve('go'), options.waitBeforeCallMs ?? 0);
      });
      if ((await wait) === 'cancel') {
        yield emit(done({ status: 'cancelled', reason: 'client-cancelled' }));
        return;
      }
      const sourceId = id('call-message');
      const callId = id('call');
      yield emit(
        message(sourceId, '', [
          { id: callId, type: 'function', toolInfo: { type: 'truefoundry-system', name: 'call_tool' }, function: { name: 'call_tool', arguments: JSON.stringify(applyToolArgs) } },
        ]),
      );
      yield emit({ type: 'tool.approval_required', id: id('approval'), threadId: 'main', createdAt: stamp(), toolCalls: [{ id: callId, sourceEventId: sourceId }] });
      yield emit(done({ status: 'done', output: null, requiredActions: [] }));
      return;
    }

    const callId = decision.toolCallId ?? '';
    const allowed = decision.approval?.status === 'allow';
    const content = allowed ? await callMcpTool('apply_changes', applyToolArgs.input) : JSON.stringify({ error: 'User denied tool call: ' + String(decision.approval?.reason) });
    results['lastToolResult'] = content;
    yield emit({ type: 'tool.response', id: id('response'), threadId: 'main', createdAt: stamp(), toolCallId: callId, content });
    const final = message(id('final'), allowed ? 'The review finished; the result lists which hunks landed.' : 'You rejected the change, so nothing was written.');
    yield emit(final);
    yield emit(done({ status: 'done', output: final, requiredActions: [] }));
  };
  return {
    api: {
      createTurnStream: (_session: string, request: { input: never[] }) => {
        options.onTurnStarted?.();
        return Promise.resolve({ withMetadata: () => events(request.input) });
      },
      cancel: () => {
        options.onCancel?.();
        cancelled?.();
        return Promise.resolve();
      },
    },
    sessionId: 'scripted-session',
  };
}

async function useScripted(options: Parameters<typeof scriptedSessions>[0] = {}): Promise<void> {
  await vscode.commands.executeCommand('forgelens.internal.useSessions', scriptedSessions(options));
  await newChat();
  await waitFor('earlier diff tabs to close', () => diffTabs().length === 0, 10_000);
}

/** Waits for one diff tab per staged file, since tabs open one after another. */
const waitForReview = (): Promise<void> =>
  waitFor(
    'the review to open',
    async () => {
      const staged = new Set((await hunks()).map((hunk) => hunk.path));
      return staged.size > 0 && diffTabs().length === staged.size && (await state()).view.status === 'awaiting-approval';
    },
    30_000,
    50,
  );

function reviewCard(view: RunView): Extract<ViewItem, { kind: 'review' }> | undefined {
  return [...view.items].reverse().find((item): item is Extract<ViewItem, { kind: 'review' }> => item.kind === 'review');
}

/** Clicks the same CodeLens command a person clicks, found through the provider on the real document. */
async function lensDecision(file: string, hunkId: string, accept: boolean): Promise<string[]> {
  const uri = vscode.Uri.from({ scheme: PROPOSED, path: '/' + file });
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
  const titles = lenses.map((lens) => lens.command?.title ?? '');
  const lens = lenses.find((candidate) => candidate.command?.arguments?.[0] === hunkId && candidate.command.command === (accept ? 'forgelens.review.acceptHunk' : 'forgelens.review.rejectHunk'));
  if (!lens?.command) throw new Error('No CodeLens for ' + hunkId + ': ' + titles.join(' | '));
  await vscode.commands.executeCommand(lens.command.command, ...(lens.command.arguments ?? []));
  return titles;
}

async function scenarioReview(): Promise<void> {
  check(vscode.workspace.getConfiguration('diffEditor').get('codeLens') === true, 'the extension turned on CodeLens in diff editors');
  check(path.resolve(workspace) !== path.resolve(root, '../flask'), 'this runs on a copy, not the real flask folder');

  // 1. Partial accept across two files, through the real MCP server and the real review UI.
  await useScripted();
  const before = { helpers: onDisk(HELPERS), globals: onDisk(GLOBALS) };
  await stageThreeHunks();
  check(onDisk(HELPERS) === before.helpers, 'staging writes nothing');
  const read = await callMcpTool('read_file', { path: HELPERS, start_line: 28, end_line: 28 });
  check(read.includes('Comment one'), 'read_file shows staged content');
  const running = vscode.commands.executeCommand('forgelens.ask', 'Add comments.');
  await waitForReview();

  const stagedSummary = await callMcpTool('get_staged_changes', {});
  const initial = await hunks();
  check(initial.length === 3, 'three hunks are up for review, got ' + String(initial.length));
  check(new Set(initial.map((hunk) => hunk.path)).size === 2, 'the hunks span two files');
  check(diffTabs().length === 2, 'one diff tab per file');
  const paused = await state();
  const card = reviewCard(paused.view);
  check(card?.text === '2 files, 3 hunks, waiting for your review', 'the Review card says what is waiting: ' + String(card?.text));
  await sleep(1500); // CodeLens and the tree paint after the tab opens.
  await shot('p2-1-review-diff-codelens-tree');

  const [one, two, three] = initial;
  if (!one || !two || !three) throw new Error('missing hunks');
  const titles = await lensDecision(one.path, one.id, true);
  check(titles.filter((title) => title === 'Accept hunk').length === 2 && titles.filter((title) => title === 'Reject hunk').length === 2, 'each hunk has its own lens: ' + titles.join(' | '));
  await lensDecision(two.path, two.id, false);
  await lensDecision(three.path, three.id, true);
  await sleep(1200);
  await shot('p2-2-decisions-made');
  const decided = await hunks();
  check(decided.map((hunk) => hunk.decision).join() === 'accepted,rejected,accepted', 'decisions recorded: ' + decided.map((hunk) => hunk.decision).join());
  check(onDisk(HELPERS) === before.helpers, 'deciding writes nothing');

  const applied = await click('.review.waiting .review-apply');
  check(applied.clicked, 'the Apply button was visible and clicked');
  await running;
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  const afterApply = await state();
  await sleep(600);
  await shot('p2-3-applied-with-undo');

  const helpersAfter = onDisk(HELPERS);
  check(helpersAfter.includes('Comment one'), 'the accepted hunk landed in helpers.py');
  check(!helpersAfter.includes('Comment two'), 'the rejected hunk did not land');
  check(onDisk(GLOBALS).includes('Comment three'), 'the accepted hunk landed in globals.py');
  const appliedCard = reviewCard(afterApply.view);
  check(appliedCard?.phase === 'applied' && appliedCard.text === 'Applied 2/3 hunks in 2 files' && appliedCard.canUndo, 'the card says what landed: ' + String(appliedCard?.text));
  const toolResult = String(results['lastToolResult']);
  check(toolResult.includes(one.id) && toolResult.includes(two.id) && toolResult.includes(three.id), 'the result names every hunk id');
  const statusAfterApply = (await gitStatus()).split('\n').sort().join(' | ');

  // 2. Undo through the card's real button.
  const undone = await click('.review-undo');
  check(undone.clicked, 'the Undo button was visible and clicked');
  await waitFor('the undo', () => onDisk(HELPERS) === before.helpers && onDisk(GLOBALS) === before.globals, 10_000);
  await sleep(700);
  await shot('p2-4-undone');
  const statusAfterUndo = await gitStatus();
  check(statusAfterUndo === '', 'git is clean after undo: ' + statusAfterUndo);
  const undoCard = reviewCard((await state()).view);
  check(undoCard?.phase === 'undone' && !undoCard.canUndo, 'the card shows the revert');

  results['review'] = {
    hunksReviewed: initial.map((hunk) => ({ id: hunk.id, path: hunk.path, newStart: hunk.newStart })),
    stagedSummary,
    lensTitles: titles,
    reviewCard: card?.text,
    appliedCard: appliedCard?.text,
    toolResult,
    gitStatusAfterApply: statusAfterApply,
    undoCard: undoCard?.text,
    gitStatusAfterUndo: statusAfterUndo,
  };
}

async function scenarioReject(): Promise<void> {
  await useScripted();
  await stageThreeHunks();
  const ids = (await hunks()).map((hunk) => hunk.id);
  const running = vscode.commands.executeCommand('forgelens.ask', 'Add comments.');
  await waitForReview();
  await vscode.commands.executeCommand('forgelens.review.rejectAll');
  await vscode.commands.executeCommand('forgelens.review.apply');
  await running;
  const reason = String(results['lastToolResult']);
  check(ids.every((id) => reason.includes(id)), 'the denial lists every hunk id: ' + reason);
  check((await gitStatus()) === '', 'reject all leaves git clean');
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  results['rejectAll'] = { reason, gitStatus: await gitStatus(), card: reviewCard((await state()).view)?.text };
}

async function scenarioStopReview(): Promise<void> {
  await useScripted();
  await stageThreeHunks();
  const running = vscode.commands.executeCommand('forgelens.ask', 'Add comments.');
  await waitForReview();
  await vscode.commands.executeCommand('forgelens.review.acceptAll');
  const probe = await click('#stop');
  await running;
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  const { view } = await state();
  await sleep(500);
  await shot('p2-5-stopped-during-review');
  check(probe.clicked && probe.reactionMs < 100, 'Stop reacted within 100 ms: ' + String(probe.reactionMs));
  check(view.status === 'cancelled' && view.statusText === 'Cancelled, workspace unchanged', 'status: ' + view.statusText);
  check((await hunks()).length === 0, 'the changeset was discarded');
  check((await gitStatus()) === '', 'git is clean after Stop during review');
  results['stopDuringReview'] = { reactionMs: probe.reactionMs, statusText: view.statusText, card: reviewCard(view)?.text, gitStatus: await gitStatus() };
}

async function scenarioStopStaging(): Promise<void> {
  await useScripted({ waitBeforeCallMs: 60_000 });
  await stageThreeHunks();
  const running = vscode.commands.executeCommand('forgelens.ask', 'Add comments.');
  // The heartbeat is this scenario's second job: the scripted server stays silent, like a slow model.
  await waitFor('the wait count', async () => /Waiting for the model… \d+ s/.test((await state()).view.statusText), 8_000, 100);
  await sleep(2100);
  const waiting = (await state()).view.statusText;
  await shot('p2-6-model-wait-heartbeat');
  await click('#stop');
  await running;
  const { view } = await state();
  check(/Waiting for the model… [2-9] s/.test(waiting), 'the wait count ticks: ' + waiting);
  check(view.status === 'cancelled', 'cancelled: ' + view.status);
  check((await hunks()).length === 0, 'staged edits were discarded');
  check(!(await callMcpTool('read_file', { path: HELPERS, start_line: 28, end_line: 28 })).includes('Comment one'), 'reads no longer see the discarded edit');
  check((await gitStatus()) === '', 'git is clean after Stop during staging');
  results['stopDuringStaging'] = { heartbeat: waiting, statusText: view.statusText, gitStatus: await gitStatus() };
}

async function scenarioDiskDrift(): Promise<void> {
  await useScripted();
  const original = onDisk(HELPERS);
  await stageThreeHunks();
  const running = vscode.commands.executeCommand('forgelens.ask', 'Add comments.');
  await waitForReview();
  await vscode.commands.executeCommand('forgelens.review.acceptAll');
  const userVersion = original.replace('import typing as t', 'import typing as t  # the user edited this');
  writeFileSync(path.join(workspace, HELPERS), userVersion);
  await vscode.commands.executeCommand('forgelens.review.apply');
  await sleep(800);
  const warned = await state();
  await shot('p2-7-file-changed-during-review');
  check(onDisk(HELPERS) === userVersion, 'the user edit was not clobbered');
  check((reviewCard(warned.view)?.warning ?? '').includes(HELPERS), 'the card warns: ' + String(reviewCard(warned.view)?.warning));
  check(warned.view.status === 'awaiting-approval', 'the review stays open');

  await vscode.commands.executeCommand('forgelens.review.apply');
  await running;
  const final = onDisk(HELPERS);
  check(final.includes('the user edited this') && final.includes('Comment one'), 'the second Apply keeps the user edit and adds the hunks');
  await vscode.commands.executeCommand('forgelens.undo');
  await sleep(500);
  check(onDisk(HELPERS) === userVersion, 'undo returns to the user version, not the older one');
  writeFileSync(path.join(workspace, HELPERS), original);
  await waitFor('a clean tree', async () => (await gitStatus()) === '', 5_000, 100);
  results['diskDrift'] = { warning: reviewCard(warned.view)?.warning, keptUserEdit: true };
}

/** Format-on-save style changes must not reach disk: only the approved bytes do. */
async function scenarioCrlf(): Promise<void> {
  await useScripted();
  const file = 'crlf-sample.py';
  const text = Array.from({ length: 30 }, (_, i) => 'value_' + String(i) + ' = ' + String(i) + '   ').join('\r\n') + '\r\n';
  writeFileSync(path.join(workspace, file), text);
  const settings = vscode.workspace.getConfiguration('files');
  await settings.update('trimTrailingWhitespace', true, vscode.ConfigurationTarget.Global);
  await settings.update('insertFinalNewline', true, vscode.ConfigurationTarget.Global);
  try {
    await callMcpTool('stage_edit', { path: file, edits: [{ old_text: 'value_3 = 3', new_text: 'value_3 = 33' }] });
    const running = vscode.commands.executeCommand('forgelens.ask', 'Edit.');
    await waitForReview();
    await vscode.commands.executeCommand('forgelens.review.acceptAll');
    await vscode.commands.executeCommand('forgelens.review.apply');
    await running;
    const written = onDisk(file);
    check(written === text.replace('value_3 = 3', 'value_3 = 33'), 'only the approved change reached disk, with CRLF and trailing spaces kept');
    const undone = await vscode.commands.executeCommand<{ ok: boolean; message: string }>('forgelens.undo');
    const atOnce = onDisk(file);
    const firstDifference = [...text].findIndex((char, i) => atOnce[i] !== char);
    check(atOnce === text, `undo restores the exact bytes: ${undone.message}; first difference at ${firstDifference}, ${JSON.stringify(atOnce.slice(Math.max(0, firstDifference - 8), firstDifference + 12))}`);
    await sleep(500);
    check(onDisk(file) === text, 'the bytes stay restored');
    results['crlf'] = { keptCrlf: !/(?<!\r)\n/.test(written), keptTrailingSpaces: written.includes(' = 33   \r\n') };
  } finally {
    await settings.update('trimTrailingWhitespace', undefined, vscode.ConfigurationTarget.Global);
    await settings.update('insertFinalNewline', undefined, vscode.ConfigurationTarget.Global);
    rmSync(path.join(workspace, file), { force: true });
  }
}

/** Closes the window during a scripted turn. launch.mjs then checks that cancel was sent. */
async function scenarioCloseScripted(): Promise<void> {
  const marker = path.join(root, 'out/e2e-close-cancel.txt');
  rmSync(marker, { force: true });
  let started = false;
  await useScripted({
    waitBeforeCallMs: 120_000,
    onTurnStarted: () => {
      started = true;
    },
    onCancel: () => writeFileSync(marker, 'cancel sent on close'),
  });
  void vscode.commands.executeCommand('forgelens.ask', 'Add comments.');
  // Setup comes first; closing before the turn exists would leave nothing to cancel.
  await waitFor('the turn to start', () => started, 15_000);
  await vscode.commands.executeCommand('workbench.action.closeWindow');
  await sleep(10_000); // The window is closing, and this host goes with it.
}

/** The one live run: a real model stages real edits. Rotates models on a quota error. */
async function scenarioLive(): Promise<void> {
  await vscode.commands.executeCommand('forgelens.internal.useSessions', undefined);
  const models = (process.env['FORGELENS_E2E_MODELS'] ?? 'google-gemini/gemini-flash-lite-latest').split(',');
  const before = { helpers: onDisk(HELPERS), globals: onDisk(GLOBALS) };
  const prompt =
    'Make exactly these two edits and read nothing else first. ' +
    'Use stage_edit on src/flask/helpers.py with old_text "def get_debug_flag() -> bool:" and new_text "# ForgeLens live test A.\\ndef get_debug_flag() -> bool:". ' +
    'Use stage_edit on src/flask/globals.py with old_text "_no_req_msg = " and new_text "# ForgeLens live test B.\\n_no_req_msg = ". ' +
    'Then call apply_changes once with a short summary. After it returns, reply in one sentence listing which hunks landed.';
  const attempts: Record<string, unknown>[] = [];
  let live = false;
  for (const model of models) {
    await vscode.workspace.getConfiguration('forgelens').update('models', [model], vscode.ConfigurationTarget.Global);
    await sleep(1500);
    await newChat();
    const asked = Date.now();
    const running = Promise.resolve(vscode.commands.executeCommand('forgelens.ask', prompt));
    await waitFor(
      'the live review or an error',
      async () => {
        const { view } = await state();
        return view.status === 'error' || view.status === 'done' || ((await hunks()).length >= 2 && diffTabs().length >= 2 && reviewCard(view)?.phase === 'reviewing');
      },
      300_000,
      200,
    );
    const paused = await state();
    if (paused.view.status === 'error' || paused.view.status === 'done') {
      await running;
      attempts.push({ model, status: paused.view.status, error: paused.view.error, seconds: (Date.now() - asked) / 1000, sessionUrl: paused.view.sessionUrl });
      if (paused.view.status === 'error' && /429|quota/i.test(paused.view.error ?? '')) continue;
      break;
    }

    live = true;
    const reviewed = await hunks();
    const summary = await callMcpTool('get_staged_changes', {});
    await sleep(1500);
    await shot('p2-8-live-review');
    const [first, second] = reviewed;
    if (!first || !second) throw new Error('expected two hunks');
    await lensDecision(first.path, first.id, true);
    await lensDecision(second.path, second.id, false);
    await sleep(800);
    await shot('p2-9-live-decisions');
    const applied = await click('.review.waiting .review-apply');
    check(applied.clicked, 'Apply was visible and clicked');
    await Promise.race([running, sleep(180_000)]);
    const after = await state();
    await sleep(500);
    await shot('p2-10-live-applied');
    const toolCard = toolsOf(after.view.items).find((tool) => tool.name === 'apply_changes');
    const firstFile = onDisk(first.path);
    const secondFile = onDisk(second.path);
    attempts.push({
      model,
      status: after.view.status,
      seconds: (Date.now() - asked) / 1000,
      sessionUrl: after.view.sessionUrl,
      hunks: reviewed.map((hunk) => ({ id: hunk.id, path: hunk.path })),
      stagedSummary: summary,
      toolCardStatus: toolCard?.status,
      viaCallTool: toolCard?.viaCallTool,
      toolResult: toolCard?.result,
      card: reviewCard(after.view)?.text,
      answer: textOf(after.view),
      gitStatusAfterApply: await gitStatus(),
    });
    check(after.view.status === 'done', 'the agent finished: ' + (after.view.error ?? after.view.status));
    check(firstFile.includes('ForgeLens live test'), 'the accepted hunk is on disk');
    check(!secondFile.includes('ForgeLens live test'), 'the rejected hunk is not on disk');
    check((toolCard?.result ?? '').includes(first.id) && (toolCard?.result ?? '').includes(second.id), 'the tool result names both hunks');

    const undone = await click('.review-undo');
    check(undone.clicked, 'Undo was visible and clicked');
    await waitFor('the undo', () => onDisk(HELPERS) === before.helpers && onDisk(GLOBALS) === before.globals, 10_000);
    await sleep(600);
    await shot('p2-11-live-undone');
    const clean = await gitStatus();
    check(clean === '', 'git is clean after undo: ' + clean);
    (attempts.at(-1) as Record<string, unknown>)['gitStatusAfterUndo'] = clean;
    break;
  }
  results['live'] = { live, attempts };
  await vscode.workspace.getConfiguration('forgelens').update('models', undefined, vscode.ConfigurationTarget.Global);
  check(live, 'a model reached the review; attempts: ' + JSON.stringify(attempts));
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
    await waitFor('setup to finish', async () => (await state()).view.model !== undefined, 30_000, 100);
    await sleep(1000);

    const table: Record<string, () => Promise<void>> = {
      ask: scenarioAsk,
      stream: scenarioStream,
      stop: scenarioStop,
      review: scenarioReview,
      reject: scenarioReject,
      'stop-review': scenarioStopReview,
      'stop-staging': scenarioStopStaging,
      drift: scenarioDiskDrift,
      crlf: scenarioCrlf,
      'close-scripted': scenarioCloseScripted,
      live: scenarioLive,
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
      if (['ask', 'stream', 'stop'].includes(name) && name !== scenarios.at(-1)) await sleep(GAP_MS);
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
