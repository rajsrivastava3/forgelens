/**
 * Task A with no window: the exact instruction on a throwaway clone, then the exact checks.
 *
 * Usage: npx tsx scripts/rehearse-a.ts --work D:\forgelens-e2e\rehearse-a --runs 3 --models a/b,c/d
 *        Add --scripted good or --scripted bad for a dry run with no model, which proves the checks.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { readSelection, sendInlineEdit, type InlineTarget } from '../src/core/inline/inlineEdit';
import { addSpend, arg, checkResources, checkSpend, INR_PER_USD, exec, freshClone, isModelBlocked, resetClone, startHarness, writeResults, type RunRecord } from './rehearse/harness';
import { scriptedSessions, type ScriptStep } from './rehearse/scripted';
import { selectGetDebugFlag as selectFunction, TASK_A_FILE, TASK_A_INSTRUCTION, verifyTaskA as verify, type TaskAChecks as Checks } from './rehearse/taskA';

const INSTRUCTION = TASK_A_INSTRUCTION;
const FILE = TASK_A_FILE;

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
      checkSpend(models.slice(modelIndex));
      resetClone(clone);
      const model = models[modelIndex] as string;
      const harness = await startHarness(clone, models.slice(modelIndex), scripted ? (call) => scriptedSessions(dryRunSteps(scripted), call) : undefined);
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
