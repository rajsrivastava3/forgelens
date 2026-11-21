/**
 * Task B with no window: the exact instruction on a throwaway clone, every hunk accepted, then the exact checks.
 *
 * Usage: npx tsx scripts/rehearse-b.ts --work D:\forgelens-e2e\rehearse-b --runs 3 --models a/b,c/d
 *        Add --scripted good or --scripted bad for a dry run with no model, which proves the checks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { sendAgentRequest } from '../src/core/context/agentPrompt';
import { addSpend, arg, checkResources, checkSpend, INR_PER_USD, exec, freshClone, isModelBlocked, PYTHON, resetClone, startHarness, verifyEnv, writeResults, type RunRecord, type ToolRecord } from './rehearse/harness';
import { loadFixture } from './rehearse/fixtures';
import { scriptedSessions, type ScriptStep } from './rehearse/scripted';

const INSTRUCTION =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

const SAMPLE_APP = `from flask import Flask

app = Flask(__name__)
app.config.update(
    SECRET_KEY="s3cret-value",
    DATABASE_PASSWORD="hunter2-value",
    API_TOKEN="tok-123-value",
    SIGNING_KEY="k-1-value",
    NORMAL_SETTING="visible-value",
)
`;

interface Checks {
  passed: boolean;
  failures: string[];
  changedFiles: string[];
  pytest: string;
  inHelp: boolean;
  helpLine: string;
  commandOutput: string;
  explorerRan: boolean;
  stagedTestsRan: boolean;
  stagedTestsAutoApproved: boolean;
}

async function verify(clone: string, workDir: string, tools: readonly ToolRecord[], threads: readonly string[]): Promise<Checks> {
  const failures: string[] = [];
  // Not trimmed first: the leading space belongs to the first line's status column.
  const status = (await exec('git', ['-C', clone, 'status', '--porcelain', '-uall'])).stdout;
  const changedFiles = status.split('\n').filter((line) => line.trim()).map((line) => line.slice(3).trim());
  if (changedFiles.length < 3) failures.push(`only ${changedFiles.length} files changed: ${changedFiles.join(', ') || 'none'}`);

  let pytest: string;
  try {
    pytest = (await exec(PYTHON, ['-m', 'pytest', 'tests/test_cli.py', '-q', '-p', 'no:cacheprovider'], { cwd: clone, env: verifyEnv(), timeout: 180_000 })).stdout.trim().split('\n').at(-1) ?? '';
  } catch (error) {
    pytest = `FAILED: ${String((error as { stdout?: string }).stdout ?? error).trim().split('\n').slice(-4).join(' | ')}`;
    failures.push(`pytest: ${pytest}`);
  }

  // A small app outside the clone, run the way a user would.
  mkdirSync(workDir, { recursive: true });
  const appDir = mkdtempSync(path.join(workDir, 'sample-app-'));
  writeFileSync(path.join(appDir, 'sample_app.py'), SAMPLE_APP);
  const flaskEnv = verifyEnv({ PYTHONPATH: `${path.join(clone, 'src')}${path.delimiter}${appDir}`, FLASK_APP: 'sample_app' });
  const flask = async (...args: string[]): Promise<string> => (await exec(PYTHON, ['-m', 'flask', ...args], { cwd: appDir, env: flaskEnv, timeout: 60_000 })).stdout;

  let helpLine = '';
  try {
    helpLine = (await flask('--help')).split(/\r?\n/).find((line) => /^\s+config\b/.test(line))?.trim() ?? '';
  } catch (error) {
    failures.push(`flask --help failed: ${String(error).slice(0, 200)}`);
  }
  if (!helpLine) failures.push('config is not in flask --help');

  let commandOutput = '';
  try {
    commandOutput = await flask('config');
    const start = commandOutput.indexOf('{');
    const printed = JSON.parse(commandOutput.slice(start < 0 ? 0 : start)) as Record<string, unknown>;
    for (const key of ['SECRET_KEY', 'DATABASE_PASSWORD', 'API_TOKEN', 'SIGNING_KEY']) {
      if (printed[key] !== '***') failures.push(`${key} was not masked: ${JSON.stringify(printed[key])}`);
    }
    if (printed['NORMAL_SETTING'] !== 'visible-value') failures.push(`NORMAL_SETTING came out as ${JSON.stringify(printed['NORMAL_SETTING'])}`);
    for (const secret of ['s3cret-value', 'hunter2-value', 'tok-123-value', 'k-1-value']) {
      if (commandOutput.includes(secret)) failures.push(`the secret ${secret} was printed`);
    }
  } catch (error) {
    failures.push(`flask config failed or was not JSON: ${String((error as { stderr?: string }).stderr ?? error).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
  }
  rmSync(appDir, { recursive: true, force: true });

  const stagedRuns = tools.filter((tool) => tool.name === 'run_command' && /pytest/.test(tool.args) && tool.result.includes('private copy'));
  return {
    passed: failures.length === 0,
    failures,
    changedFiles,
    pytest,
    inHelp: helpLine !== '',
    helpLine,
    commandOutput: commandOutput.slice(0, 1500),
    explorerRan: threads.length > 0,
    stagedTestsRan: stagedRuns.length > 0,
    stagedTestsAutoApproved: stagedRuns.some((tool) => tool.autoApproved),
  };
}

/** A scripted run for proving the checks. Answers to the fixed task are kept outside the repository. */
export function dryRunSteps(mode: string): ScriptStep[] {
  if (mode === 'costly') {
    // One request that reports more tokens than the per-run guard allows: the guard must stop the run before the next.
    const shell = { type: 'model.message', id: 'costly-1', threadId: 'main', createdAt: new Date().toISOString(), content: '', toolCalls: [] };
    const usage = { inputTokens: 400_000, outputTokens: 10, cacheReadTokens: 0, inputTokensBreakdown: {} };
    return [
      { kind: 'event', event: shell },
      { kind: 'event', event: { type: 'model.message.delta', id: 'costly-1', threadId: 'main', createdAt: new Date().toISOString(), content: 'Planning.', usage } },
      { kind: 'hook', run: () => new Promise((resolve) => setTimeout(resolve, 300)) },
      { kind: 'tool', name: 'search_code', args: { query: 'this call must never run' } },
      { kind: 'text', text: 'Done.' },
    ];
  }
  return loadFixture(`task-b-${mode}`);
}

/** Seconds spent in each phase of one run, with tool calls and input tokens per turn. */
export function phaseSummary(record: RunRecord): Record<string, number | string> {
  const { phases, timeline } = record;
  const round = (value: number): number => Math.round(value * 10) / 10;
  const [planStart = 0, implementStart] = phases.turnStarts;
  const explorer = phases.threads.reduce((sum, thread) => sum + ((thread.done ?? thread.created) - thread.created), 0);
  const implementEnd = timeline.reviewOpen ?? record.seconds;
  const inTurn = (turn: number) => phases.toolCalls.filter((call) => call.turn === turn);
  const spent = (turn: number, test: (tool: string) => boolean): number => inTurn(turn).filter((call) => test(call.tool)).reduce((sum, call) => sum + (call.end - call.start), 0);
  const isRead = (tool: string): boolean => !tool.startsWith('stage_') && tool !== 'run_command' && tool !== 'apply_changes';
  const tokens = (turn: number): number => phases.requests.filter((request) => request.turn === turn).reduce((sum, request) => sum + request.input, 0);
  const implement = implementStart === undefined ? 0 : implementEnd - implementStart;
  const reads = spent(2, isRead);
  const stages = spent(2, (tool) => tool.startsWith('stage_'));
  const pytest = spent(2, (tool) => tool === 'run_command');
  return {
    context: round(phases.contextCard ?? 0),
    explorer: round(explorer),
    planTurn: round((timeline.planCard ?? planStart) - planStart),
    implementTurn: round(implement),
    implReads: round(reads),
    implStage: round(stages),
    implPytest: round(pytest),
    implModel: round(implement - reads - stages - pytest),
    toReview: round(implementEnd),
    total: round(record.seconds),
    planTools: inTurn(1).length,
    implTools: inTurn(2).length,
    planInputTokens: tokens(1),
    implInputTokens: tokens(2),
    implToolList: inTurn(2).map((call) => call.tool).join(' '),
  };
}

async function main(): Promise<void> {
  checkResources();
  const workDir = path.resolve(arg('--work') ?? 'D:\\forgelens-e2e\\rehearse-b');
  const runs = Number(arg('--runs') ?? 3);
  const scripted = arg('--scripted');
  const models = (arg('--models') ?? 'scripted').split(',');
  const gapMs = Number(arg('--gap-s') ?? 30) * 1000;
  // A staged run has to find the project's Python, as it would in a folder with its own .venv.
  process.env['PATH'] = verifyEnv()['PATH'];
  const clone = freshClone(workDir);
  const results: (Partial<RunRecord> & { run: number; result: string; checks?: Checks; diff?: string })[] = [];
  let modelIndex = 0;

  for (let run = 1; run <= runs; run += 1) {
    if (run > 1 && !scripted) await new Promise((resolve) => setTimeout(resolve, gapMs));
    while (modelIndex < models.length) {
      checkSpend(models.slice(modelIndex));
      resetClone(clone);
      const model = models[modelIndex] as string;
      const harness = await startHarness(clone, models.slice(modelIndex), scripted ? (call) => scriptedSessions(dryRunSteps(scripted), call) : undefined);
      const started = Date.now();
      await sendAgentRequest(harness.controller, harness.engine, INSTRUCTION, () => ({}), harness.log);
      const record = harness.record((Date.now() - started) / 1000);
      await harness.close();
      // A dry run spends nothing, even when it plays a priced model's usage to test the guard.
      const spentNow = addSpend(scripted ? 0 : record.costUsd, `${path.basename(__filename)} run ${run} on ${model}`);
      console.log(`  Cost: about Rs ${(record.costUsd * INR_PER_USD).toFixed(2)} ($${record.costUsd.toFixed(4)}). Spent in this run so far: Rs ${spentNow.toFixed(2)}.`);

      if (record.status === 'error' && isModelBlocked(record.error)) {
        results.push({ run, result: 'blocked', ...record });
        console.log(`Run ${run}: ${model} refused: ${record.error}`);
        modelIndex += 1;
        continue;
      }
      const checks = await verify(clone, workDir, record.tools, record.threads);
      const diff = (await exec('git', ['-C', clone, 'diff'])).stdout;
      const passed = checks.passed && record.status === 'done';
      results.push({ run, result: passed ? 'pass' : 'fail', ...record, checks, diff });
      console.log(`Run ${run}: ${passed ? 'PASS' : 'FAIL'} on ${model}. ${record.seconds.toFixed(1)} s, ${record.requests} requests, $${record.costUsd.toFixed(4)}, ${record.tokensIn}/${record.tokensOut} tokens.`);
      console.log(`  Context: ${record.contextTokens ?? 'none'} tokens, ${record.contextFiles.length} files. Top: ${record.contextFiles.slice(0, 4).join(', ')}`);
      const t = record.timeline;
      const at = (value: number | undefined): string => (value === undefined ? 'never' : `${value.toFixed(1)} s`);
      console.log(`  Timeline: plan card ${at(t.planCard)}, first stage ${at(t.firstStage)}, review open ${at(t.reviewOpen)}, done ${record.seconds.toFixed(1)} s. Reasoning effort: ${record.reasoningEffort}.`);
      console.log(`  Plan: ${record.plan.length > 0 ? record.plan.map((step) => `${step.path} (${step.what}; why: ${step.why || 'none given'})`).join(' | ') : 'none'}`);
      console.log(`  Explorer thread: ${checks.explorerRan ? record.threads.join(', ') : 'no'}. Staged pytest: ${checks.stagedTestsRan ? 'yes' : 'no'}, auto-approved: ${checks.stagedTestsAutoApproved ? 'yes' : 'no'}.`);
      console.log(`  Changed: ${checks.changedFiles.join(', ') || 'none'}. Hunks: ${record.hunks}. ${record.reviewCard ?? 'No review.'}`);
      console.log(`  pytest: ${checks.pytest}. In --help: ${checks.helpLine || 'no'}`);
      if (!passed) console.log(`  ${[record.error, ...checks.failures].filter(Boolean).join('\n  ')}`);
      const inputs = record.perRequest.map((request) => request.input);
      const cached = record.perRequest.reduce((sum, request) => sum + request.cached, 0);
      console.log(`  Tokens per request (input): ${inputs.join(', ') || 'none reported'}. Largest ${Math.max(0, ...inputs)}, total ${inputs.reduce((a, b) => a + b, 0)}, of which cache reads ${cached}.${record.stoppedForCost ? ' Stopped by the cost guard.' : ''}`);
      console.log(`  Failed tool cards: ${record.tools.filter((tool) => tool.status === 'error').length} of ${record.tools.length}${record.tools.some((tool) => tool.status === 'error') ? ' (' + record.tools.filter((tool) => tool.status === 'error').map((tool) => tool.name).join(', ') + ')' : ''}.`);
      console.log(`  Tools: ${record.tools.map((tool) => `${tool.thread === 'main' ? '' : 'sub:'}${tool.name}`).join(' ')}`);
      console.log(`  Session: ${record.sessionUrl ?? 'none'}`);
      console.log(`  PHASES ${JSON.stringify(phaseSummary(record))}`);
      break;
    }
    if (modelIndex >= models.length) {
      console.log('Every model refused, so no more runs.');
      break;
    }
  }
  writeResults(scripted ? `rehearse-b-scripted-${scripted}` : 'rehearse-b', results);
  console.log(`Passed ${results.filter((item) => item.result === 'pass').length} of ${results.filter((item) => item.result !== 'blocked').length} completed runs.`);
}

if (require.main === module) void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
