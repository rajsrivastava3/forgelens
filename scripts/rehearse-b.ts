/**
 * Task B with no window: the exact instruction on a throwaway clone, every hunk accepted, then the exact checks.
 *
 * Usage: npx tsx scripts/rehearse-b.ts --work D:\forgelens-e2e\rehearse-b --runs 3 --models a/b,c/d
 *        Add --scripted good or --scripted bad for a dry run with no model, which proves the checks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { sendAgentRequest } from '../src/core/context/agentPrompt';
import { arg, checkResources, exec, freshClone, isModelBlocked, PYTHON, resetClone, startHarness, verifyEnv, writeResults, type RunRecord, type ToolRecord } from './rehearse/harness';
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

/** A known answer, only for proving these checks. A real run never sees it. */
function dryRunSteps(mode: string): ScriptStep[] {
  // The scripted answer for this dry run is kept outside the repository.
  void mode;
  return [];
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
      resetClone(clone);
      const model = models[modelIndex] as string;
      const harness = await startHarness(clone, model, scripted ? (call) => scriptedSessions(dryRunSteps(scripted), call) : undefined);
      const started = Date.now();
      await sendAgentRequest(harness.controller, harness.engine, INSTRUCTION, () => ({}), harness.log);
      const record = harness.record((Date.now() - started) / 1000);
      await harness.close();

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
      console.log(`  Explorer thread: ${checks.explorerRan ? record.threads.join(', ') : 'no'}. Staged pytest: ${checks.stagedTestsRan ? 'yes' : 'no'}, auto-approved: ${checks.stagedTestsAutoApproved ? 'yes' : 'no'}.`);
      console.log(`  Changed: ${checks.changedFiles.join(', ') || 'none'}. Hunks: ${record.hunks}. ${record.reviewCard ?? 'No review.'}`);
      console.log(`  pytest: ${checks.pytest}. In --help: ${checks.helpLine || 'no'}`);
      if (!passed) console.log(`  ${[record.error, ...checks.failures].filter(Boolean).join('\n  ')}`);
      console.log(`  Tools: ${record.tools.map((tool) => `${tool.thread === 'main' ? '' : 'sub:'}${tool.name}`).join(' ')}`);
      console.log(`  Session: ${record.sessionUrl ?? 'none'}`);
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

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
