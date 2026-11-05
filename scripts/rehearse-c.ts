/**
 * Task C with no window: the exact Task A, with a primary model that fails the way Task C asks. The broken model
 * lives in its own provider entry, so the real providers are never touched.
 *
 * Usage: npx tsx scripts/rehearse-c.ts --work D:\forgelens-e2e\rehearse-c --mode key|unreachable --fallback provider/model
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { sendInlineEdit, type InlineTarget } from '../src/core/inline/inlineEdit';
import { addSpend, arg, BASE_URL, checkResources, checkSpend, exec, freshClone, INR_PER_USD, startHarness, writeResults } from './rehearse/harness';

const INSTRUCTION = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const FILE = 'src/flask/helpers.py';

/** A provider that fails on purpose. Its key is a made-up string, never a real one. */
async function ensureBrokenProvider(mode: string): Promise<string> {
  const name = mode === 'unreachable' ? 'broken-unreachable' : 'broken-primary';
  const model = { name: 'gemini-3-8-flash', model_id: 'gemini-3.8-flash', properties: { context_length: 1048576, max_output_tokens: 65536 } };
  // Only custom providers can be named, which is what keeps this apart from the real google-gemini entry.
  const manifest = {
    type: 'custom',
    name,
    base_url: mode === 'unreachable' ? 'http://127.0.0.1:59999/v1' : 'https://generativelanguage.googleapis.com/v1beta/openai/',
    auth: { api_key: 'not-a-real-key-for-task-c' },
    models: [model],
  };
  const response = await fetch(BASE_URL + '/api/v1/settings/model-providers', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  if (!response.ok) throw new Error('Could not create the ' + name + ' provider: ' + String(response.status) + ' ' + (await response.text()).slice(0, 300));
  return name + '/gemini-3-8-flash';
}

function selectFunction(text: string): { startLine: number; endLine: number } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('def get_debug_flag'));
  let end = start;
  for (let i = start + 1; i < lines.length && (lines[i]?.startsWith(' ') || lines[i]?.trim() === ''); i += 1) {
    if (lines[i]?.trim()) end = i;
  }
  return { startLine: start + 1, endLine: end + 1 };
}

async function main(): Promise<void> {
  checkResources();
  const mode = arg('--mode') ?? 'key';
  const fallback = arg('--fallback') ?? 'gemini-free/gemini-flash-lite-latest';
  const workDir = path.resolve(arg('--work') ?? 'D:\\forgelens-e2e\\rehearse-c');
  const broken = await ensureBrokenProvider(mode);
  checkSpend([broken, fallback]);
  const clone = freshClone(workDir);
  const git = async (): Promise<string> => (await exec('git', ['-C', clone, 'status', '--porcelain'])).stdout.trim();

  let statusAtFallback: string | undefined;
  const harness = await startHarness(clone, [broken, fallback], undefined, {
    onFallback: () => {
      // At the moment of the switch, before the fallback has done anything.
      void git().then((status) => {
        statusAtFallback ??= status;
      });
    },
  });
  const started = Date.now();
  let responsiveTicks = 0;
  const ticker = setInterval(() => {
    responsiveTicks += 1;
  }, 100);
  const fileText = readFileSync(path.join(clone, FILE), 'utf8');
  const target: InlineTarget = { path: FILE, ...selectFunction(fileText), language: 'python', instruction: INSTRUCTION };
  await sendInlineEdit({ controller: harness.controller, flow: harness.flow, port: harness.port, log: harness.log }, target, fileText);
  clearInterval(ticker);
  const record = harness.record((Date.now() - started) / 1000);
  await harness.close();
  const spent = addSpend(record.costUsd, 'rehearse-c (' + mode + ') on ' + record.modelsTried.join(' then '));

  const finalStatus = await git();
  const fellBack = record.modelsTried.includes(fallback) && record.notices.some((notice) => notice.startsWith('Primary model failed'));
  const landed = finalStatus === 'M ' + FILE;
  console.log('Mode: ' + mode + '. Models tried: ' + record.modelsTried.join(' then ') + '. ' + record.seconds.toFixed(1) + ' s, ' + String(record.requests) + ' requests.');
  for (const notice of record.notices) console.log('  Notice: ' + notice);
  console.log('  Fell back automatically: ' + (fellBack ? 'yes' : 'no') + '. git status at the switch: "' + (statusAtFallback ?? 'no switch') + '".');
  console.log('  Final: ' + record.status + (record.error ? ' (' + record.error + ')' : '') + '. git status: "' + finalStatus + '". The fallback\'s edit ' + (landed ? 'landed after review.' : 'did not land.'));
  console.log('  The process stayed responsive: ' + String(responsiveTicks) + ' timer ticks in ' + record.seconds.toFixed(1) + ' s.');
  console.log('  Cost: about Rs ' + (record.costUsd * INR_PER_USD).toFixed(2) + '. Spent in this run so far: Rs ' + spent.toFixed(2) + '.');
  console.log('  Session: ' + (record.sessionUrl ?? 'none'));
  writeResults('rehearse-c-' + mode, { mode, broken, fallback, statusAtFallback, finalStatus, fellBack, ...record });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
