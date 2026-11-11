import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { scriptedSessions as scriptedRehearsalSessions, type ScriptStep } from '../../scripts/rehearse/scripted';
import type { RunView, ToolItem, ViewItem } from '../../src/core/trueforge/runView';
import type { SessionsApi } from '../../src/core/trueforge/turnRunner';
import type { PanelState } from '../../src/vscode/protocol';

const exec = promisify(execFile);
const root = process.env['FORGELENS_E2E_ROOT'] ?? '.';
const workspace = process.env['FORGELENS_E2E_WORKSPACE'] ?? '.';
const scenarios = (process.env['FORGELENS_E2E_SCENARIOS'] ?? '').split(',');
const shots = path.join(root, 'docs/screenshots');
const results: Record<string, unknown> = {};
const GAP_MS = Number(process.env['FORGELENS_E2E_GAP_S'] ?? 65) * 1000;
const SCENARIO_LIMIT_MS = Number(process.env['FORGELENS_E2E_SCENARIO_LIMIT_S'] ?? 420) * 1000;
const TASK_A_LIMIT_MS = 1_500_000;

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
interface ScriptOptions {
  waitBeforeCallMs?: number;
  onCancel?: () => void;
  onTurnStarted?: () => void;
  /** Sees the prompt the agent would get. */
  onPrompt?: (prompt: string) => void;
  /** Runs before the apply_changes call, as an agent's stage_edit calls would. */
  beforeCall?: () => Promise<void>;
  /** The agent answers with this text and calls no tools. */
  textAnswer?: string;
}

function scriptedSessions(options: ScriptOptions = {}): unknown {
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
      options.onPrompt?.((decision as { content?: string } | undefined)?.content ?? '');
      const wait = new Promise<'cancel' | 'go'>((resolve) => {
        cancelled = () => resolve('cancel');
        setTimeout(() => resolve('go'), options.waitBeforeCallMs ?? 0);
      });
      if ((await wait) === 'cancel') {
        yield emit(done({ status: 'cancelled', reason: 'client-cancelled' }));
        return;
      }
      if (options.textAnswer !== undefined) {
        const answer = message(id('answer'), options.textAnswer);
        yield emit(answer);
        yield emit(done({ status: 'done', output: answer, requiredActions: [] }));
        return;
      }
      await options.beforeCall?.();
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
async function lensDecision(file: string, hunkId: string, accept: boolean, emptySide = false): Promise<string[]> {
  const uri = vscode.Uri.from({ scheme: PROPOSED, path: '/' + file, ...(emptySide ? { query: 'empty' } : {}) });
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
  const titles = lenses.map((lens) => lens.command?.title ?? '');
  const lens = lenses.find((candidate) => candidate.command?.arguments?.[0] === hunkId && candidate.command.command === (accept ? 'forgelens.review.acceptHunk' : 'forgelens.review.rejectHunk'));
  if (!lens?.command) throw new Error('No CodeLens for ' + hunkId + ': ' + titles.join(' | '));
  await vscode.commands.executeCommand(lens.command.command, ...(lens.command.arguments ?? []));
  return titles;
}

async function scenarioReview(): Promise<void> {
  check(vscode.workspace.getConfiguration('diffEditor').get('codeLens') === true, 'the extension turned on CodeLens in diff editors');
  check(path.resolve(workspace) !== path.resolve(process.env['FORGELENS_FLASK'] ?? path.join(root, '../flask')), 'this runs on a copy, not the real flask folder');

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
  await sleep(400);
  await shot('p7-2-stop-discards-staged');
  const { view } = await state();
  check(/Waiting for the model… [2-9] s/.test(waiting), 'the wait count ticks: ' + waiting);
  check(view.status === 'cancelled', 'cancelled: ' + view.status);
  check(view.statusText === 'Cancelled, workspace unchanged', 'the panel says so: ' + view.statusText);
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

/** New and deleted files, through the real review and the VS Code port. */
async function scenarioCreateDelete(): Promise<void> {
  const created = 'src/flask/forgelens_new.py';
  const deleted = 'docs/license.rst';
  const deletedText = onDisk(deleted);
  check(existsSync(path.join(workspace, deleted)), 'the file to delete exists');

  // Accept both.
  await useScripted();
  await callMcpTool('stage_create_file', { path: created, content: 'NEW = 1\n' });
  await callMcpTool('stage_delete_file', { path: deleted });
  check(!existsSync(path.join(workspace, created)) && existsSync(path.join(workspace, deleted)), 'staging touches neither file');
  let running = vscode.commands.executeCommand('forgelens.ask', 'Add and remove.');
  await waitForReview();
  const both = await hunks();
  check(both.length === 2, 'one hunk each: ' + String(both.length));
  const deleteHunk = both.find((hunk) => hunk.path === deleted);
  const createHunk = both.find((hunk) => hunk.path === created);
  if (!deleteHunk || !createHunk) throw new Error('missing hunks');
  await sleep(1200);
  await shot('p3-7-create-and-delete-review');
  const deleteLenses = await lensDecision(deleted, deleteHunk.id, true, true);
  check(deleteLenses.length === 2, 'a deletion gets Accept and Reject lenses: ' + deleteLenses.join(' | '));
  await lensDecision(created, createHunk.id, true);
  await click('.review.waiting .review-apply');
  await running;
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  check(onDisk(created) === 'NEW = 1\n', 'the new file is on disk');
  check(!existsSync(path.join(workspace, deleted)), 'the deleted file is gone');
  const statusAfterApply = await gitStatus();

  const undone = await vscode.commands.executeCommand<{ ok: boolean; message: string }>('forgelens.undo');
  check(undone.ok, 'undo: ' + undone.message);
  check(!existsSync(path.join(workspace, created)), 'undo removes the new file');
  check(onDisk(deleted) === deletedText, 'undo restores the deleted file exactly');
  check((await gitStatus()) === '', 'git is clean after undo: ' + (await gitStatus()));

  // Reject both: nothing changes.
  await useScripted();
  await callMcpTool('stage_create_file', { path: created, content: 'NEW = 2\n' });
  await callMcpTool('stage_delete_file', { path: deleted });
  running = vscode.commands.executeCommand('forgelens.ask', 'Add and remove.');
  await waitForReview();
  await vscode.commands.executeCommand('forgelens.review.rejectAll');
  await vscode.commands.executeCommand('forgelens.review.apply');
  await running;
  check(!existsSync(path.join(workspace, created)) && onDisk(deleted) === deletedText, 'rejected: neither file changed');
  check((await gitStatus()) === '', 'git is clean after rejecting');
  results['createDelete'] = { statusAfterApply, undo: undone.message, lenses: deleteLenses };
}

/** What Ctrl+Z does after a multi-file apply. The undo command is what the key runs in an editor. */
async function scenarioCtrlZ(): Promise<void> {
  const before = { helpers: onDisk(HELPERS), globals: onDisk(GLOBALS) };
  const applyAll = async (): Promise<void> => {
    await useScripted();
    await stageThreeHunks();
    const running = vscode.commands.executeCommand('forgelens.ask', 'Add comments.');
    await waitForReview();
    await vscode.commands.executeCommand('forgelens.review.acceptAll');
    await click('.review.waiting .review-apply');
    await running;
    await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
    check(onDisk(HELPERS).includes('Comment one') && onDisk(GLOBALS).includes('Comment three'), 'the apply reached both files');
  };
  const isOpenAndDirty = (file: string): boolean =>
    vscode.workspace.textDocuments.some((document) => document.uri.fsPath.toLowerCase() === path.join(workspace, file).toLowerCase() && document.isDirty);
  const report: Record<string, unknown> = {};

  // In an editor showing one of the edited files.
  await applyAll();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const undoInEditor = async (): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(path.join(workspace, HELPERS));
    await vscode.window.showTextDocument(document);
    await sleep(300);
    await vscode.commands.executeCommand('undo');
    await waitFor('the revert to reach disk', () => onDisk(HELPERS) === before.helpers && onDisk(GLOBALS) === before.globals, 6_000);
  };
  await undoInEditor();
  await sleep(500);
  await shot('p3-8-ctrl-z-in-editor');
  check(!isOpenAndDirty(HELPERS) && !isOpenAndDirty(GLOBALS), 'no file is left unsaved');
  check((await gitStatus()) === '', 'Ctrl+Z in an editor reverts every file on disk: ' + (await gitStatus()));
  const card = reviewCard((await state()).view);
  check(card?.phase === 'undone', 'the card shows the revert: ' + String(card?.text));
  report['inEditor'] = { result: 'every file in the apply reverted and saved', card: card?.text };

  // Right after Apply, where focus is in the panel and no editor is open.
  await applyAll();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('undo');
  await sleep(400);
  const unfocused = await gitStatus();
  report['noEditorNoPanelFocus'] = { result: unfocused === '' ? 'reverted' : 'nothing happens, as for any Ctrl+Z with no editor', gitStatus: unfocused };
  await vscode.commands.executeCommand('forgelens.internal.pressCtrlZ');
  await waitFor('the revert from the panel', async () => (await gitStatus()) === '', 6_000, 100);
  report['inPanel'] = { result: 'every file in the apply reverted, the same as the Undo button' };

  // Typing in the panel keeps its own Ctrl+Z: nothing is undone with nothing to undo.
  await vscode.commands.executeCommand('forgelens.internal.pressCtrlZ');
  await sleep(300);
  check((await gitStatus()) === '', 'a second Ctrl+Z has nothing to do');
  results['ctrlZ'] = report;
}

async function scenarioKeybindings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
  await waitFor('the defaults to open', () => vscode.window.activeTextEditor?.document.uri.scheme === 'vscode', 10_000);
  const text = vscode.window.activeTextEditor?.document.getText() ?? '';
  const lines = text.split('\n');
  // The extension's own binding appears in this file too, so only others count.
  const clashes = lines.flatMap((line, i) => (/"key":\s*"ctrl\+alt\+[ke]"/.test(line) && !line.includes('forgelens.') ? [line.trim() + ' ' + (lines[i + 1] ?? '').trim()] : []));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  const all = await vscode.commands.getCommands(true);
  results['keybindings'] = { defaultLinesChecked: lines.length, ctrlAltKDefaults: clashes, commandRegistered: all.includes('forgelens.editSelection') };
  check(lines.length > 500, 'the default keybindings were read');
  check(clashes.length === 0, 'Ctrl+Alt+K and Ctrl+Alt+E are free of VS Code defaults: ' + clashes.join('; '));
}

const TASK_A_INSTRUCTION = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const FLASK_SOURCE = process.env['FORGELENS_FLASK'] ?? path.join(root, '../flask');
const VENV_SCRIPTS = path.join(FLASK_SOURCE, '.venv/Scripts');
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const VERIFY_PY = 'from flask.helpers import get_debug_flag; print(get_debug_flag())';

function verifyEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: VENV_SCRIPTS + path.delimiter + (process.env['PATH'] ?? ''), PYTHONPATH: 'src', PYTHONDONTWRITEBYTECODE: '1', ...extra };
}

/** The toy edit, on disk: nope and nah are false, 1 is still true, and the helpers tests pass. */
async function verifyToyEdit(): Promise<{ passed: boolean; failures: string[]; values: Record<string, string>; pytest: string }> {
  const failures: string[] = [];
  const python = path.join(VENV_SCRIPTS, 'python.exe');
  const values: Record<string, string> = {};
  for (const [value, want] of Object.entries({ nope: 'False', NAH: 'False', '1': 'True' })) {
    values[value] = (await exec(python, ['-c', VERIFY_PY], { cwd: workspace, env: verifyEnv({ FLASK_DEBUG: value }), timeout: 120_000 })).stdout.trim();
    if (values[value] !== want) failures.push('FLASK_DEBUG=' + value + ' gave ' + values[value] + ', wanted ' + want);
  }
  let pytest: string;
  try {
    pytest = (await exec(python, ['-m', 'pytest', 'tests/test_helpers.py', '-q', '-p', 'no:cacheprovider'], { cwd: workspace, env: verifyEnv(), timeout: 180_000 })).stdout.trim().split('\n').at(-1) ?? '';
  } catch (error) {
    pytest = 'FAILED: ' + String((error as { stdout?: string }).stdout ?? error).trim().split('\n').slice(-3).join(' ');
    failures.push(pytest);
  }
  return { passed: failures.length === 0, failures, values, pytest };
}

/** The exact Task A checks, against the throwaway clone. */
async function verifyTaskA(): Promise<{ passed: boolean; failures: string[]; values: Record<string, string>; pytest: string; docstring: string; flaskFrom: string; exact: string }> {
  const failures: string[] = [];
  const python = path.join(VENV_SCRIPTS, 'python.exe');
  const run = async (args: string[], env: Record<string, string> = {}): Promise<string> =>
    (await exec(python, args, { cwd: workspace, env: verifyEnv(env), timeout: 120_000 })).stdout.trim();

  const flaskFrom = await run(['-c', 'import flask; print(flask.__file__)']);
  if (!path.resolve(flaskFrom).toLowerCase().startsWith(path.resolve(workspace).toLowerCase())) failures.push('flask was not imported from the clone: ' + flaskFrom);

  // Exactly as the task says, in Git Bash.
  const exact = (await exec(GIT_BASH, ['-c', 'FLASK_DEBUG=off python -c "' + VERIFY_PY + '"'], { cwd: workspace, env: verifyEnv(), timeout: 120_000 })).stdout.trim();
  if (exact !== 'False') failures.push('the exact command printed ' + exact);

  const values: Record<string, string> = {};
  const expected: Record<string, string> = { off: 'False', OFF: 'False', Off: 'False', n: 'False', N: 'False', '0': 'False', false: 'False', FALSE: 'False', no: 'False', NO: 'False', '1': 'True', true: 'True', yes: 'True' };
  for (const [value, want] of Object.entries(expected)) {
    const got = await run(['-c', VERIFY_PY], { FLASK_DEBUG: value });
    values[value] = got;
    if (got !== want) failures.push('FLASK_DEBUG=' + value + ' gave ' + got + ', wanted ' + want);
  }

  const docstring = await run(['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag.__doc__)']);
  for (const word of ['0', 'false', 'no', 'off', 'n']) {
    if (!new RegExp('(^|[^a-z0-9])' + word + '($|[^a-z0-9])', 'i').test(docstring)) failures.push('the docstring does not list ' + word);
  }

  let pytest: string;
  try {
    pytest = (await exec(python, ['-m', 'pytest', 'tests/test_helpers.py', '-q', '-p', 'no:cacheprovider'], { cwd: workspace, env: verifyEnv(), timeout: 180_000 })).stdout.trim().split('\n').at(-1) ?? '';
  } catch (error) {
    pytest = 'FAILED: ' + String((error as { stdout?: string }).stdout ?? error).trim().split('\n').slice(-3).join(' ');
    failures.push(pytest);
  }
  return { passed: failures.length === 0, failures, values, pytest, docstring, flaskFrom, exact };
}

/** The same command on screen, for the screenshot. */
async function showVerification(name: string): Promise<void> {
  const terminal = vscode.window.createTerminal({ name: 'Task A check', shellPath: GIT_BASH, cwd: workspace, env: { PATH: VENV_SCRIPTS + path.delimiter + (process.env['PATH'] ?? ''), PYTHONPATH: 'src', PYTHONDONTWRITEBYTECODE: '1' } });
  terminal.show();
  await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
  await sleep(4000);
  terminal.sendText('for v in OFF n N 0 false no 1 true yes; do echo "$v: $(FLASK_DEBUG=$v python -c "' + VERIFY_PY + '")"; done');
  await sleep(9000);
  terminal.sendText('python -m pytest tests/test_helpers.py -q -p no:cacheprovider 2>&1 | tail -1');
  await sleep(5000);
  // Last, so the exact command from the task is the line on screen.
  terminal.sendText('FLASK_DEBUG=off python -c "' + VERIFY_PY + '"');
  await sleep(3000);
  await shot(name);
  terminal.dispose();
  await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
  await vscode.commands.executeCommand('workbench.action.closePanel');
}

/** Opens helpers.py with get_debug_flag selected, exactly as Task A starts. */
async function selectGetDebugFlag(): Promise<{ startLine: number; endLine: number }> {
  const document = await vscode.workspace.openTextDocument(path.join(workspace, HELPERS));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const lines = document.getText().split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('def get_debug_flag'));
  let end = start;
  for (let i = start + 1; i < lines.length && (lines[i]?.startsWith(' ') || lines[i]?.trim() === ''); i += 1) {
    if (lines[i]?.trim()) end = i;
  }
  editor.selection = new vscode.Selection(start, 0, end, (lines[end] ?? '').length);
  editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);
  return { startLine: start + 1, endLine: end + 1 };
}

const inputBoxWait = 500;

/** Returns the run inside an object: an async function returning a thenable would wait for it to finish. */
async function startInline(instruction: string, shotName?: string): Promise<{ running: Thenable<unknown> }> {
  const running = vscode.commands.executeCommand('forgelens.editSelection');
  await sleep(inputBoxWait);
  if (shotName) await shot(shotName);
  await vscode.commands.executeCommand('forgelens.internal.answerInput', instruction);
  return { running };
}

/** A toy change on Task A's function, so the scripted run proves the pipeline without holding the task's answer. */
const toyEdits = {
  path: HELPERS,
  edits: [
    {
      old_text: 'return bool(val and val.lower() not in {"0", "false", "no"})',
      new_text: 'return bool(val and val.lower() not in {"0", "false", "no", "nope", "nah"})',
    },
    {
      old_text: 'The default is \x60\x60False\x60\x60.',
      new_text: 'The default is \x60\x60False\x60\x60.\n    The values \x60nope\x60 and \x60nah\x60 count as false too.',
    },
  ],
};

async function acceptAndApply(): Promise<void> {
  await vscode.commands.executeCommand('forgelens.review.acceptAll');
  const applied = await click('.review.waiting .review-apply');
  check(applied.clicked, 'Apply was visible and clicked');
}

async function undoToClean(): Promise<void> {
  const undone = await vscode.commands.executeCommand<{ ok: boolean; message: string }>('forgelens.undo');
  check(undone.ok, 'undo: ' + undone.message);
  check((await gitStatus()) === '', 'git is clean after undo: ' + (await gitStatus()));
}

/** Task A end to end with a scripted agent: every step except the model is real. */
async function scenarioInline(): Promise<void> {
  const original = onDisk(HELPERS);
  let prompt = '';
  await useScripted({ onPrompt: (text) => (prompt = text), beforeCall: async () => void (await callMcpTool('stage_edit', toyEdits)) });
  const lines = await selectGetDebugFlag();
  const { running } = await startInline(TASK_A_INSTRUCTION, 'p3-1-input-at-selection');
  await waitForReview();
  await sleep(1200);
  await shot('p3-2-task-a-review');

  check(prompt.includes('File: ' + HELPERS), 'the prompt names the file');
  check(prompt.includes('Selected lines: ' + String(lines.startLine) + '-' + String(lines.endLine)), 'the prompt gives the lines: ' + prompt.slice(0, 120));
  check(prompt.includes(TASK_A_INSTRUCTION), 'the prompt has the instruction word for word');
  check(prompt.includes('def get_debug_flag() -> bool:'), 'the prompt has the selected code');
  check(prompt.includes('def get_load_dotenv'), 'the prompt has the code after it');
  const shown = (await state()).view.items.find((item) => item.kind === 'user');
  check(shown?.kind === 'user' && !shown.text.includes('Selected code'), 'the panel shows the short text');

  await acceptAndApply();
  await running;
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  const verification = await verifyToyEdit();
  check(verification.passed, 'the toy edit works on disk: ' + verification.failures.join('; '));
  check((await gitStatus()).includes('helpers.py'), 'only helpers.py changed: ' + (await gitStatus()));
  await undoToClean();
  check(onDisk(HELPERS) === original, 'undo restored the file');
  results['inline'] = { lines, verification };
}

async function scenarioInlineFallback(): Promise<void> {
  const original = onDisk(HELPERS);
  const code = 'def get_debug_flag() -> bool:\n    """Get the debug flag. False for 0, false, no, nope and nah."""\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no", "nope", "nah"})';
  await useScripted({ textAnswer: 'Here is the updated function:\n\n\x60\x60\x60python\n' + code + '\n\x60\x60\x60\n\nThis treats nope and nah as false.' });
  await selectGetDebugFlag();
  const { running } = await startInline(TASK_A_INSTRUCTION);
  await waitForReview();
  await sleep(1200);
  await shot('p3-3-fallback-review');
  const card = reviewCard((await state()).view);
  check((card?.warning ?? '').includes('plain text'), 'the card says the fallback was used: ' + String(card?.warning));
  check(onDisk(HELPERS) === original, 'nothing is on disk yet');
  await acceptAndApply();
  await running;
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  const after = onDisk(HELPERS);
  const finalStatus = (await state()).view.status;
  check(after.includes('"nope", "nah"') && after.includes('def get_load_dotenv'), 'the selection was replaced and the rest kept');
  check(finalStatus === 'done', 'the run finished: ' + finalStatus);
  await undoToClean();

  // A text answer with nothing usable says so and changes nothing.
  await useScripted({ textAnswer: 'I cannot help with that.' });
  await selectGetDebugFlag();
  await (await startInline(TASK_A_INSTRUCTION)).running;
  const refused = await state();
  check(refused.view.status === 'error' && (refused.view.error ?? '').includes('did not propose a change'), 'a clear message: ' + String(refused.view.error));
  check((await gitStatus()) === '', 'git stays clean');
  results['inlineFallback'] = { note: card?.warning, refused: refused.view.error };
}

async function scenarioInlineCancel(): Promise<void> {
  // Esc while waiting on the model. The stop command is what the Esc binding runs.
  await useScripted({ waitBeforeCallMs: 60_000 });
  await selectGetDebugFlag();
  let { running } = await startInline(TASK_A_INSTRUCTION);
  await waitFor('the wait count', async () => /Waiting for the model… \d+ s/.test((await state()).view.statusText), 8_000, 100);
  await shot('p3-5-progress-at-selection');
  await vscode.commands.executeCommand('forgelens.stop');
  await running;
  let { view } = await state();
  check(view.status === 'cancelled' && view.statusText === 'Cancelled, workspace unchanged', 'stopped while waiting: ' + view.statusText);
  check((await gitStatus()) === '', 'git is clean');

  // The panel's Stop during the review.
  await useScripted({ beforeCall: async () => void (await callMcpTool('stage_edit', toyEdits)) });
  await selectGetDebugFlag();
  ({ running } = await startInline(TASK_A_INSTRUCTION));
  await waitForReview();
  await vscode.commands.executeCommand('forgelens.review.acceptAll');
  const stop = await click('#stop');
  await running;
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  ({ view } = await state());
  check(stop.clicked && stop.reactionMs < 100, 'Stop reacted within 100 ms');
  check(view.status === 'cancelled', 'stopped during review: ' + view.status);
  check((await gitStatus()) === '', 'git is clean after Stop during review');

  // Esc in the input box runs nothing.
  const canceled = vscode.commands.executeCommand('forgelens.editSelection');
  await sleep(inputBoxWait);
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await canceled;
  check(!(await state()).busy, 'cancelling the input starts nothing');
  results['inlineCancel'] = { reactionMs: stop.reactionMs, gitStatus: await gitStatus() };
}

async function scenarioInlineMentions(): Promise<void> {
  let prompt = '';
  await useScripted({ onPrompt: (text) => (prompt = text), textAnswer: 'No change.' });
  await selectGetDebugFlag();
  await (await startInline('Follow the style of @file:src/flask/globals.py and @symbol:get_load_dotenv and @file:nope.py please')).running;
  check(prompt.includes('Mentioned by you, file src/flask/globals.py'), 'a file mention is included');
  check(prompt.includes('_no_app_msg'), 'with its content');
  check(prompt.includes('Mentioned by you, symbol get_load_dotenv'), 'a symbol mention is included');
  check(prompt.includes('Not found in the workspace: nope.py'), 'a missing mention is reported');
  results['inlineMentions'] = { ok: true };
}

async function totalModelMessages(sessionUrl: string | undefined): Promise<number | undefined> {
  const id = sessionUrl?.split('/').pop();
  if (!id) return undefined;
  const response = await fetch('http://localhost:8790/api/v1/sessions/' + id + '/events?limit=100');
  if (!response.ok) return undefined;
  const { data } = (await response.json()) as { data: { event: { type: string } }[] };
  return data.filter((item) => item.event.type === 'model.message').length;
}

/** The exact Task A on a real model, three times, rotating on a quota error. */
async function scenarioTaskALive(): Promise<void> {
  await vscode.commands.executeCommand('forgelens.internal.useSessions', undefined);
  const models = (process.env['FORGELENS_E2E_MODELS'] ?? 'google-gemini/gemini-flash-lite-latest').split(',');
  const budget = Number(process.env['FORGELENS_E2E_REQUEST_BUDGET'] ?? 28);
  const settings = vscode.workspace.getConfiguration('forgelens');
  const runs: Record<string, unknown>[] = [];
  let modelIndex = 0;
  let spent = 0;
  let passes = 0;

  for (let run = 1; run <= 3 && spent < budget - 4; run += 1) {
    if (run > 1) await sleep(GAP_MS);
    let finished = false;
    while (!finished && modelIndex < models.length) {
      const model = models[modelIndex] as string;
      await settings.update('models', [model], vscode.ConfigurationTarget.Global);
      await sleep(1500);
      await newChat();
      await waitFor('earlier diff tabs to close', () => diffTabs().length === 0, 10_000);
      await selectGetDebugFlag();
      const asked = Date.now();
      const running = Promise.resolve((await startInline(TASK_A_INSTRUCTION)).running);
      await waitFor(
        'the review or an end',
        async () => {
          const current = await state();
          return !current.busy || (current.view.status === 'awaiting-approval' && reviewCard(current.view)?.phase === 'reviewing' && diffTabs().length > 0);
        },
        300_000,
        200,
      );
      const paused = await state();
      if (!paused.busy) {
        const requests = await totalModelMessages(paused.view.sessionUrl);
        spent += requests ?? 1;
        const quota = /429|quota/i.test(paused.view.error ?? '');
        runs.push({ run, model, result: quota ? 'quota' : 'failed', error: paused.view.error, seconds: (Date.now() - asked) / 1000, requests, sessionUrl: paused.view.sessionUrl });
        if (quota) {
          modelIndex += 1;
          continue;
        }
        finished = true;
        continue;
      }

      const reviewedHunks = await hunks();
      const note = reviewCard(paused.view)?.warning;
      const touched = [...new Set(reviewedHunks.map((hunk) => hunk.path))];
      await sleep(1200);
      if (run === 1) await shot('p3-6-live-task-a-review');
      await acceptAndApply();
      await Promise.race([running, sleep(180_000)]);
      await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
      const after = await state();
      const seconds = (Date.now() - asked) / 1000;
      const verification = await verifyTaskA();
      if (run === 1) await showVerification('p3-9-live-verification-output');
      const diff = (await exec('git', ['-C', workspace, 'diff', '--', HELPERS])).stdout;
      const requests = await totalModelMessages(after.view.sessionUrl);
      spent += requests ?? 4;
      const onlySelection = touched.length === 1 && touched[0] === HELPERS;
      const passed = verification.passed && onlySelection && after.view.status === 'done';
      if (passed) passes += 1;
      runs.push({
        run,
        model,
        result: passed ? 'pass' : 'fail',
        seconds,
        requests,
        fallbackUsed: Boolean(note),
        note,
        hunks: reviewedHunks.length,
        touched,
        status: after.view.status,
        error: after.view.error,
        card: reviewCard(after.view)?.text,
        answer: textOf(after.view),
        verification,
        diff,
        sessionUrl: after.view.sessionUrl,
      });
      await vscode.commands.executeCommand('forgelens.undo');
      if ((await gitStatus()) !== '') await exec('git', ['-C', workspace, 'checkout', '--', '.']);
      finished = true;
    }
    if (modelIndex >= models.length) break;
  }
  results['taskALive'] = { passes, spent, runs };
  await settings.update('models', undefined, vscode.ConfigurationTarget.Global);
  check(passes > 0, 'at least one live pass: ' + JSON.stringify(runs.map((item) => ({ run: item['run'], result: item['result'], error: item['error'] }))));
}

const TASK_B_INSTRUCTION =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

const read = (selector: string): Thenable<{ clicked: boolean; statusText: string }> => vscode.commands.executeCommand('forgelens.internal.read', selector);

async function useScriptSteps(steps: ScriptStep[], onPrompt?: (prompt: string) => void): Promise<void> {
  // A failed call reaches the scripted model as text, the way TrueForge passes it on: our server's own errors start
  // with "Error:", and a protocol-level refusal comes as {"error": ...}.
  const asModelSees = (name: string, error: unknown): string => {
    const text = (error instanceof Error ? error.message : String(error)).replace(name + ' failed: ', '');
    return text.startsWith('Error:') ? text : JSON.stringify({ error: text });
  };
  const inner = scriptedRehearsalSessions(steps, (name, args) => callMcpTool(name, args).catch((error: unknown) => asModelSees(name, error)));
  const api: SessionsApi = {
    createTurnStream: (id, request, options) => {
      const first = request.input[0];
      if (first?.type === 'user.message') onPrompt?.(first.content as string);
      return inner.createTurnStream(id, request, options);
    },
    cancel: (id) => inner.cancel(id),
  };
  await vscode.commands.executeCommand('forgelens.internal.useSessions', { api, sessionId: 'scripted-session' });
  await newChat();
  await waitFor('earlier diff tabs to close', () => diffTabs().length === 0, 10_000);
}

/** Task B's whole shape with a scripted agent: pack, explorer thread, staged tests, compaction notice, inline review. */
async function scenarioAgentFlow(): Promise<void> {
  const report: Record<string, unknown> = {};
  let prompt = '';
  const diffConfig = (): boolean | undefined => vscode.workspace.getConfiguration('diffEditor').get<boolean>('renderSideBySide');
  const layoutBefore = diffConfig();
  await useScriptSteps(
    [
      {
        kind: 'hook',
        run: async () => {
          await sleep(500);
          await shot('p4-1-context-pack-card');
          const summary = await read('.context-summary');
          const onScreen = await vscode.commands.executeCommand<boolean>('forgelens.internal.inView', '.context-summary');
          check(summary.clicked && onScreen, 'the card heading is on screen, not scrolled away');
          check(/^Context chosen: \d+ files, [\d.]+k? \/ 6k tokens$/.test(summary.statusText), 'the card summary: ' + summary.statusText);
          const rows = await read('.context-items');
          check(rows.clicked, 'the reasons show without expanding anything');
          check(rows.statusText.includes('src/flask/cli.py') && rows.statusText.includes('tests/test_cli.py') && rows.statusText.includes('docs/cli.rst'), 'the three files are listed');
          report['cardSummary'] = summary.statusText;
        },
      },
      {
        kind: 'thread',
        title: 'Explorer: find every touch point',
        tools: [
          { name: 'search_code', args: { query: 'add_command' } },
          { name: 'read_file', args: { path: 'docs/cli.rst', start_line: 1, end_line: 20 } },
        ],
        answer: 'Touch points: src/flask/cli.py registers commands, tests/test_cli.py tests them, docs/cli.rst documents them.',
      },
      { kind: 'event', event: { type: 'thread.context_compaction_started', id: 'compact-1', threadId: 'main', createdAt: new Date().toISOString() } },
      { kind: 'hook', run: () => sleep(300) },
      { kind: 'event', event: { type: 'thread.context_compaction_finished', id: 'compact-2', threadId: 'main', createdAt: new Date().toISOString() } },
      { kind: 'tool', name: 'stage_edit', args: { path: 'src/flask/cli.py', edits: [{ old_text: 'self.add_command(routes_command)', new_text: 'self.add_command(routes_command)  # scripted edit' }] } },
      { kind: 'tool', name: 'stage_edit', args: { path: 'tests/test_cli.py', edits: [{ old_text: 'def test_cli_empty(app):', new_text: '# Scripted edit.\ndef test_cli_empty(app):' }] } },
      { kind: 'tool', name: 'stage_edit', args: { path: 'docs/cli.rst', edits: [{ old_text: 'Custom Commands\n---------------', new_text: 'Scripted Section\n----------------\n\nScripted text.\n\n\nCustom Commands\n---------------' }] } },
      {
        kind: 'hook',
        run: async () => {
          await sleep(500);
          await shot('p4-2-explorer-subagent-thread');
          const thread = await read('.thread-summary');
          check(thread.clicked && thread.statusText.includes('Explorer'), 'the subagent thread shows: ' + thread.statusText);
          const notice = await read('.notice');
          check(notice.clicked && notice.statusText.includes('Compacted the conversation'), 'the compaction notice shows: ' + notice.statusText);
          report['thread'] = thread.statusText;
          report['compaction'] = notice.statusText;
        },
      },
      { kind: 'gated', name: 'run_command', args: { command: 'python -m pytest tests/test_cli.py -q', target: 'staged' } },
      {
        kind: 'hook',
        run: async () => {
          await sleep(500);
          await shot('p4-3-run-command-auto-approved');
          const badge = await read('.tool-auto:not([hidden])');
          check(badge.clicked && badge.statusText === 'auto-approved (safe list)', 'the card says so: ' + badge.statusText);
          report['badge'] = badge.statusText;
        },
      },
      { kind: 'gated', name: 'apply_changes', args: { summary: 'Add the flask config command.' } },
      { kind: 'text', text: 'Added the command, with a test and docs.' },
    ],
    (text) => (prompt = text),
  );
  const running = vscode.commands.executeCommand('forgelens.ask', TASK_B_INSTRUCTION);
  await waitForReview();
  await sleep(1500);
  const shownAtReview = (await state()).view;
  check(diffConfig() === false, 'the review shows inline diffs');
  const uri = vscode.Uri.from({ scheme: PROPOSED, path: '/src/flask/cli.py' });
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
  check(lenses.some((lens) => lens.command?.title === 'Accept hunk'), 'the lenses are there in inline mode');
  await shot('p3-10-review-inline-diff');
  await shot('p4-4-task-b-review');

  check(prompt.startsWith('## Context Pack:'), 'the pack goes first');
  check(prompt.includes('| File | Why | Tokens | Shown as |'), 'the pack has its table');
  check(prompt.includes('## Request\n' + TASK_B_INSTRUCTION + '\n\n## How to answer'), 'the request follows, word for word, then the plan rule');
  const shown = shownAtReview.items.find((item) => item.kind === 'user');
  check(shown?.kind === 'user' && shown.text === TASK_B_INSTRUCTION, 'the panel shows only what was typed');

  await acceptAndApply();
  await running;
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  await waitFor('the diff layout setting to come back', () => diffConfig() === layoutBefore, 5_000);
  const tools = toolsOf((await state()).view.items);
  const command = tools.find((tool) => tool.name === 'run_command');
  check(Boolean(command?.result?.includes('private copy')), 'the tests ran in the staged copy: ' + String(command?.result).slice(0, 200));
  check(Boolean(command?.result?.includes('passed')), 'pytest ran: ' + String(command?.result).slice(-200));
  report['stagedRun'] = command?.result?.trim().split('\n').at(-1);
  await undoToClean();
  results['agentFlow'] = report;
}

/** Plan, then implement: the explorer thread, then the Plan card, then the second turn in the same session. */
async function scenarioPlanCard(): Promise<void> {
  const report: Record<string, unknown> = {};
  const prompts: string[] = [];
  await useScriptSteps(
    [
      {
        kind: 'thread',
        title: 'explorer',
        tools: [
          { name: 'search_code', args: { query: 'add_command' } },
          { name: 'read_file', args: { path: 'tests/test_cli.py', start_line: 1, end_line: 20 } },
          { name: 'read_file', args: { path: 'docs/cli.rst', start_line: 1, end_line: 20 } },
        ],
        answer: 'Targets: the command registration in the CLI module, its test module, and the CLI docs page.',
      },
      {
        kind: 'text',
        text: [
          'Plan:',
          '- src/flask/cli.py: add the new command next to the other built-in commands and register it. Why: built-in commands are defined and registered here.',
          '- tests/test_cli.py: add a test for the command. Why: the request asks for test coverage.',
          '- docs/cli.rst: add a section beside the other built-in commands. Why: the request asks for docs there.',
        ].join('\n'),
      },
      {
        kind: 'hook',
        run: async () => {
          await sleep(600);
          await shot('p6-1-plan-card');
          const plan = await read('.plan-card .context-summary');
          check(plan.clicked && plan.statusText === 'Plan: 3 files, implementing next', 'the plan card heading: ' + plan.statusText);
          const rows = await read('.plan-card .context-items');
          check(rows.statusText.includes('src/flask/cli.py') && rows.statusText.includes('Why: the request asks for test coverage.'), 'the plan rows show what and why');
          const thread = await read('.thread-summary');
          check(thread.clicked && thread.statusText.includes('explorer'), 'the explorer thread shows: ' + thread.statusText);
          await shot('p6-2-explorer-thread');
          report['plan'] = plan.statusText;
          report['thread'] = thread.statusText;
        },
      },
      { kind: 'text', text: 'Scripted: the implementation would follow here.' },
    ],
    (text) => prompts.push(text),
  );
  await vscode.commands.executeCommand('forgelens.ask', TASK_B_INSTRUCTION);
  await waitFor('the request to end', async () => (await state()).view.status === 'done', 30_000);
  check(prompts.length === 2, 'two turns were sent: ' + String(prompts.length));
  check(prompts[1] === 'Implement your plan now. Stage all edits with as few stage_edit calls as possible, run the tests once with run_command target=staged, fix only what fails, then call apply_changes once.', 'the second turn is the implement step');
  results['planCard'] = report;
}

/** "Open session in TrueForge" opens the session beside the editor, in the Simple Browser. */
async function scenarioSessionView(): Promise<void> {
  const browserTabs = (): vscode.Tab[] =>
    vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => (tab.input instanceof vscode.TabInputWebview && /simpleBrowser/i.test(tab.input.viewType)) || tab.label === 'TrueForge');
  // A real session, from a passing Task B run, opened the way the panel's link opens it. A scripted run has no
  // session in TrueForge, so the link stays hidden there.
  const url = process.env['FORGELENS_E2E_SESSION_URL'];
  check(Boolean(url), 'FORGELENS_E2E_SESSION_URL names a real session');
  if (url) {
    await vscode.commands.executeCommand('forgelens.internal.openSession', url);
    // The tab reports no input type VS Code knows, so its title is what identifies it, and it takes a moment to appear.
    await sleep(3000);
    await waitFor('the session page in a Simple Browser tab', () => browserTabs().length > 0, 10_000);
    await sleep(9000);
    await shot('p7-1-session-in-simple-browser');
    results['sessionView'] = { url, tabs: browserTabs().map((tab) => tab.label) };
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Inline edit with models that misbehave: each ends in a reviewable diff or a clear message, never a half state. */
async function scenarioInlineRobust(): Promise<void> {
  const report: Record<string, unknown> = {};
  const original = onDisk(HELPERS);
  const outside = { old_text: "What to return if the env var isn't set.", new_text: "What to return if the env var isn't set. Outside the selection." };

  // 1. The model edits outside the selection too. Both hunks show; the user rejects the stray one.
  await useScriptSteps([
    { kind: 'tool', name: 'stage_edit', args: { path: HELPERS, edits: [...toyEdits.edits, outside] } },
    { kind: 'gated', name: 'apply_changes', args: { summary: 'Toy edit, plus one outside the selection.' } },
    { kind: 'text', text: 'Done.' },
  ]);
  const lines = await selectGetDebugFlag();
  let { running } = await startInline(TASK_A_INSTRUCTION);
  await waitForReview();
  const staged = await hunks();
  // The toy edit's two changes are within the hunk context of each other, so they are one hunk.
  check(staged.length === 2 && staged.filter((hunk) => hunk.newStart > lines.endLine).length === 1, 'two hunks, one of them outside the selection: ' + staged.map((hunk) => hunk.newStart).join(','));
  for (const hunk of staged) {
    await vscode.commands.executeCommand(hunk.newStart > lines.endLine ? 'forgelens.review.rejectHunk' : 'forgelens.review.acceptHunk', hunk.id);
  }
  await sleep(300);
  await shot('p7-3-inline-stray-hunk-rejected');
  await vscode.commands.executeCommand('forgelens.review.apply');
  await running;
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  let after = onDisk(HELPERS);
  check(after.includes('"nope", "nah"') && !after.includes('Outside the selection.'), 'only the hunks inside the selection landed');
  report['outside'] = { hunks: staged.length, reviewCard: reviewCard((await state()).view)?.text };
  await undoToClean();
  check(onDisk(HELPERS) === original, 'undo restored the file');

  // 2. The model stages, then stops without apply_changes. ForgeLens opens the review itself.
  await useScriptSteps([
    { kind: 'tool', name: 'stage_edit', args: toyEdits },
    { kind: 'text', text: 'I have made the change.' },
  ]);
  await selectGetDebugFlag();
  ({ running } = await startInline(TASK_A_INSTRUCTION));
  await waitForReview();
  const card = reviewCard((await state()).view);
  check((card?.warning ?? '').includes('stopped before asking for review'), 'the card says why the review opened: ' + String(card?.warning));
  await acceptAndApply();
  await running;
  await waitFor('the diff tabs to close', () => diffTabs().length === 0, 10_000);
  after = onDisk(HELPERS);
  check(after.includes('"nope", "nah"'), 'the staged edit landed after accept');
  report['noApply'] = card?.warning;
  await undoToClean();

  // 3. Malformed tool arguments, then an edit that matches nothing, then giving up: a clear message, nothing changed.
  await useScriptSteps([
    { kind: 'tool', name: 'stage_edit', args: { path: HELPERS, edits: 'oops' } },
    { kind: 'tool', name: 'stage_edit', args: { path: HELPERS, edits: [{ old_text: 'no such text anywhere in this file', new_text: 'x' }] } },
    { kind: 'text', text: 'I could not make the change.' },
  ]);
  await selectGetDebugFlag();
  ({ running } = await startInline(TASK_A_INSTRUCTION));
  await running;
  const failed = await state();
  const toolCards = toolsOf(failed.view.items).filter((tool) => tool.name === 'stage_edit');
  check(toolCards.length === 2 && toolCards.every((tool) => tool.status === 'error'), 'both bad calls show as errors on their cards: ' + toolCards.map((tool) => tool.status).join(','));
  check(failed.view.status === 'error' && (failed.view.error ?? '').includes('did not propose a change'), 'a clear message: ' + String(failed.view.error));
  check(diffTabs().length === 0 && (await hunks()).length === 0, 'no review and nothing staged');
  check((await gitStatus()) === '', 'git stays clean');
  check(onDisk(HELPERS) === original, 'the file is untouched');
  await shot('p7-4-inline-malformed-clear-message');
  report['malformed'] = { error: failed.view.error, tools: toolCards.map((tool) => tool.result?.slice(0, 120)) };
  results['inlineRobust'] = report;
}

/** A command off the safe list still asks. */
async function scenarioCommandAsks(): Promise<void> {
  await useScriptSteps([
    { kind: 'gated', name: 'run_command', args: { command: 'git status; echo chained', target: 'workspace' } },
    { kind: 'text', text: 'Done.' },
  ]);
  const running = vscode.commands.executeCommand('forgelens.ask', 'Check the status.');
  await waitFor('the approval', async () => (await state()).view.status === 'awaiting-approval', 15_000, 50);
  await sleep(300);
  const badge = await read('.tool-auto:not([hidden])');
  check(!badge.clicked, 'not marked auto-approved');
  const deny = await click('.status-awaiting-approval .approval button.secondary');
  check(deny.clicked, 'Deny is on screen');
  await running;
  results['commandAsks'] = { ok: true };
}

async function scenarioPanelMentions(): Promise<void> {
  let prompt = '';
  await useScriptSteps([{ kind: 'text', text: 'Noted.' }], (text) => (prompt = text));
  await vscode.commands.executeCommand('forgelens.panel.focus');
  await vscode.commands.executeCommand('forgelens.internal.type', 'Explain @');
  await sleep(1500); // The picker lists every file and symbol.
  await shot('p4-5-panel-mention-picker');
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await sleep(100);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(500);
  const typed = (await read('#input')).statusText;
  check(/^Explain @(file|symbol):\S+ $/.test(typed), 'the picked mention replaced the @: ' + typed);
  const sent = await click('#send');
  check(sent.clicked, 'Send is on screen');
  await waitFor('the run', async () => !(await state()).busy && (await state()).view.status === 'done', 15_000, 100);
  await sleep(400);
  await shot('p4-6-mention-in-context-card');
  const row = await read('.context-row.mentioned .context-why');
  check(row.clicked && row.statusText.includes('mentioned by you'), 'the card labels it: ' + row.statusText);
  check(prompt.includes('mentioned by you'), 'the pack labels it');
  await newChat();
  results['panelMentions'] = { typed, label: row.statusText };
}

/** The primary refuses (402), the fallback answers. Then every model fails, which offers Switch model. */
async function scenarioFallbackBanner(): Promise<void> {
  const settings = vscode.workspace.getConfiguration('forgelens');
  const before = settings.inspect<string[]>('models')?.globalValue;
  await settings.update('models', ['google-gemini/gemini-3-8-flash', 'gemini-free/gemini-flash-lite-latest'], vscode.ConfigurationTarget.Global);
  await sleep(2500); // Setup runs again for the new list.
  try {
    let turn = 0;
    const plan = (failures: number): unknown => ({
      api: {
        createTurnStream: () => {
          turn += 1;
          const failing = turn <= failures;
          return Promise.resolve({
            withMetadata: () =>
              (async function* () {
                if (failing) {
                  yield { data: { type: 'turn.done', id: 'd' + String(turn), state: { status: 'error', message: '[Model Error] Request failed (402): Your prepayment credits are depleted.' } }, id: '1' };
                  return;
                }
                const text = { type: 'model.message', id: 'm' + String(turn), threadId: 'main', createdAt: new Date().toISOString(), content: 'Answered by the fallback model.', toolCalls: [] };
                yield { data: text, id: '1' };
                yield { data: { type: 'turn.done', id: 'd' + String(turn), state: { status: 'done', output: text } }, id: '2' };
              })(),
          });
        },
        cancel: () => Promise.resolve(),
      },
      sessionId: 'scripted-session',
    });

    await vscode.commands.executeCommand('forgelens.internal.useSessions', plan(1));
    await newChat();
    await vscode.commands.executeCommand('forgelens.ask', 'Where is get_debug_flag defined?');
    await sleep(600);
    const banner = await read('.notice.warning');
    await shot('p5-1-fallback-banner');
    check(banner.clicked, 'the fallback banner is on screen');
    check(banner.statusText === 'Primary model failed: prepaid credits depleted (402). Switched to gemini-flash-lite-latest automatically.', 'the banner text: ' + banner.statusText);
    const { view } = await state();
    check(view.status === 'done' && view.model === 'gemini-free/gemini-flash-lite-latest', 'the fallback finished the request: ' + view.status + ' ' + String(view.model));

    turn = 0;
    await vscode.commands.executeCommand('forgelens.internal.useSessions', plan(99));
    await newChat();
    await vscode.commands.executeCommand('forgelens.ask', 'Where is get_debug_flag defined?');
    await sleep(600);
    const error = await read('#error-text');
    const button = await read('#switch-model');
    await shot('p5-2-every-model-failed');
    check(error.statusText.startsWith('Every configured model failed'), 'one clear message: ' + error.statusText);
    check(button.clicked, 'Switch model is on screen');
    check((await gitStatus()) === '', 'the workspace is unchanged');
    results['fallbackBanner'] = { banner: banner.statusText, finalError: error.statusText };
  } finally {
    await settings.update('models', before, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('forgelens.internal.useSessions', undefined);
  }
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
      'create-delete': scenarioCreateDelete,
      'ctrl-z': scenarioCtrlZ,
      keybindings: scenarioKeybindings,
      inline: scenarioInline,
      'inline-fallback': scenarioInlineFallback,
      'inline-robust': scenarioInlineRobust,
      'inline-cancel': scenarioInlineCancel,
      'inline-mentions': scenarioInlineMentions,
      'agent-flow': scenarioAgentFlow,
      'plan-card': scenarioPlanCard,
      'session-view': scenarioSessionView,
      'command-asks': scenarioCommandAsks,
      'panel-mentions': scenarioPanelMentions,
      'fallback-banner': scenarioFallbackBanner,
      'task-a-live': scenarioTaskALive,
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
          sleep(name === 'task-a-live' ? TASK_A_LIMIT_MS : SCENARIO_LIMIT_MS).then(() => {
            throw new Error(`no result in scenario ${name}`);
          }),
        ]);
      } catch (error) {
        await vscode.commands.executeCommand('forgelens.stop');
        failures.push(`${name}: ${String(error)}`);
        await shot(`failed-${name}`);
        // One failure must not be reported again by every scenario after it.
        await newChat();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await exec('git', ['-C', workspace, 'checkout', '--', '.']);
        await exec('git', ['-C', workspace, 'clean', '-fdq']);
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
