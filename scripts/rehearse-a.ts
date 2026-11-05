/**
 * Task A with no window: the exact instruction on a throwaway clone, then the exact checks.
 *
 * Usage: npx tsx scripts/rehearse-a.ts --work D:\forgelens-e2e\rehearse-a --runs 3 --models a/b,c/d
 *        Add --scripted good or --scripted bad for a dry run with no model, which proves the checks.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { readSelection, sendInlineEdit, type InlineTarget } from '../src/core/inline/inlineEdit';
import { addSpend, arg, checkResources, checkSpend, INR_PER_USD, exec, freshClone, GIT_BASH, isModelBlocked, PYTHON, resetClone, startHarness, verifyEnv, writeResults, type RunRecord } from './rehearse/harness';
import { scriptedSessions, type ScriptStep } from './rehearse/scripted';

const INSTRUCTION = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const FILE = 'src/flask/helpers.py';
const VERIFY = 'from flask.helpers import get_debug_flag; print(get_debug_flag())';

function selectFunction(text: string): { startLine: number; endLine: number } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('def get_debug_flag'));
  if (start < 0) throw new Error('get_debug_flag is not in this file.');
  let end = start;
  for (let i = start + 1; i < lines.length && (lines[i]?.startsWith(' ') || lines[i]?.trim() === ''); i += 1) {
    if (lines[i]?.trim()) end = i;
  }
  return { startLine: start + 1, endLine: end + 1 };
}

interface Checks {
  passed: boolean;
  failures: string[];
  exactCommand: string;
  values: Record<string, string>;
  pytest: string;
  docstring: string;
  onlyThisFile: boolean;
}

async function verify(clone: string): Promise<Checks> {
  const failures: string[] = [];
  const python = async (args: string[], env: Record<string, string> = {}): Promise<string> =>
    (await exec(PYTHON, args, { cwd: clone, env: verifyEnv(env), timeout: 120_000 })).stdout.trim();

  const from = await python(['-c', 'import flask; print(flask.__file__)']);
  if (!path.resolve(from).toLowerCase().startsWith(path.resolve(clone).toLowerCase())) failures.push(`flask came from outside the clone: ${from}`);

  const exactCommand = (await exec(GIT_BASH, ['-c', `FLASK_DEBUG=off python -c "${VERIFY}"`], { cwd: clone, env: verifyEnv(), timeout: 120_000 })).stdout.trim();
  if (exactCommand !== 'False') failures.push(`the exact command printed ${exactCommand}`);

  const values: Record<string, string> = {};
  const expected: Record<string, string> = { off: 'False', OFF: 'False', Off: 'False', n: 'False', N: 'False', '0': 'False', false: 'False', FALSE: 'False', no: 'False', NO: 'False', '1': 'True', true: 'True', yes: 'True' };
  for (const [value, want] of Object.entries(expected)) {
    values[value] = await python(['-c', VERIFY], { FLASK_DEBUG: value });
    if (values[value] !== want) failures.push(`FLASK_DEBUG=${value} gave ${values[value]}, wanted ${want}`);
  }

  const docstring = await python(['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag.__doc__)']);
  for (const word of ['0', 'false', 'no', 'off', 'n']) {
    if (!new RegExp(`(^|[^a-z0-9])${word}($|[^a-z0-9])`, 'i').test(docstring)) failures.push(`the docstring does not list ${word}`);
  }

  let pytest: string;
  try {
    pytest = (await python(['-m', 'pytest', 'tests/test_helpers.py', '-q', '-p', 'no:cacheprovider'])).split('\n').at(-1) ?? '';
  } catch (error) {
    pytest = `FAILED: ${String((error as { stdout?: string }).stdout ?? error).trim().split('\n').slice(-2).join(' ')}`;
    failures.push(pytest);
  }

  const status = (await exec('git', ['-C', clone, 'status', '--porcelain'])).stdout.trim();
  const onlyThisFile = status === `M ${FILE}`;
  if (!onlyThisFile) failures.push(`changed files: ${status || 'none'}`);
  return { passed: failures.length === 0, failures, exactCommand, values, pytest, docstring, onlyThisFile };
}

function dryRunSteps(mode: string): ScriptStep[] {
  // The scripted answer for this dry run is kept outside the repository.
  void mode;
  return [];
}

async function main(): Promise<void> {
  checkResources();
  const workDir = path.resolve(arg('--work') ?? 'D:\\forgelens-e2e\\rehearse-a');
  const runs = Number(arg('--runs') ?? 3);
  const scripted = arg('--scripted');
  const models = (arg('--models') ?? 'scripted').split(',');
  const gapMs = Number(arg('--gap-s') ?? 20) * 1000;
  const clone = freshClone(workDir);
  const results: (Partial<RunRecord> & { run: number; result: string; checks?: Checks; diff?: string })[] = [];
  let modelIndex = 0;

  for (let run = 1; run <= runs; run += 1) {
    if (run > 1 && !scripted) await new Promise((resolve) => setTimeout(resolve, gapMs));
    while (modelIndex < models.length) {
      checkSpend();
      resetClone(clone);
      const model = models[modelIndex] as string;
      const harness = await startHarness(clone, model, scripted ? (call) => scriptedSessions(dryRunSteps(scripted), call) : undefined);
      const started = Date.now();
      const fileText = readFileSync(path.join(clone, FILE), 'utf8');
      const lines = selectFunction(fileText);
      const target: InlineTarget = { path: FILE, ...lines, language: 'python', instruction: INSTRUCTION };
      readSelection(fileText, target);
      await sendInlineEdit({ controller: harness.controller, flow: harness.flow, port: harness.port, log: harness.log }, target, fileText);
      const record = harness.record((Date.now() - started) / 1000);
      await harness.close();
      const spentNow = addSpend(record.costUsd, `${path.basename(__filename)} run ${run} on ${model}`);
      console.log(`  Cost: about Rs ${(record.costUsd * INR_PER_USD).toFixed(2)} ($${record.costUsd.toFixed(4)}). Spent in this run so far: Rs ${spentNow.toFixed(2)}.`);

      if (record.status === 'error' && isModelBlocked(record.error)) {
        results.push({ run, result: 'blocked', ...record });
        console.log(`Run ${run}: ${model} refused: ${record.error}`);
        modelIndex += 1;
        continue;
      }
      const checks = await verify(clone);
      const diff = (await exec('git', ['-C', clone, 'diff', '--', FILE])).stdout;
      const passed = checks.passed && record.status === 'done';
      results.push({ run, result: passed ? 'pass' : 'fail', ...record, checks, diff });
      console.log(
        `Run ${run}: ${passed ? 'PASS' : 'FAIL'} on ${model}. ${record.secondsToDiff?.toFixed(1) ?? '-'} s to diff, ${record.seconds.toFixed(1)} s total, ${record.requests} requests, $${record.costUsd.toFixed(4)}, ${record.tokensIn}/${record.tokensOut} tokens, fallback: ${record.reviewNote ? 'yes' : 'no'}. Exact command: ${checks.exactCommand}. pytest: ${checks.pytest}.`,
      );
      if (!passed) console.log(`  ${[record.error, ...checks.failures].filter(Boolean).join('\n  ')}`);
      console.log(`  Session: ${record.sessionUrl ?? 'none'}`);
      break;
    }
    if (modelIndex >= models.length) {
      console.log('Every model refused, so no more runs.');
      break;
    }
  }
  writeResults(scripted ? `rehearse-a-scripted-${scripted}` : 'rehearse-a', results);
  const passes = results.filter((item) => item.result === 'pass').length;
  console.log(`Passed ${passes} of ${results.filter((item) => item.result !== 'blocked').length} completed runs.`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
