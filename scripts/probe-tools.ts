/**
 * One tool-call round trip on one model: the agent must call read_file, get the result, and answer in a second
 * request. That second request is where a provider that drops tool-call state fails.
 * Usage: npx tsx scripts/probe-tools.ts <provider/model> [--work D:\forgelens-e2e\probe]
 */
import * as path from 'node:path';
import { arg, checkResources, freshClone, startHarness } from './rehearse/harness';

async function main(): Promise<void> {
  checkResources();
  const model = process.argv[2];
  if (!model) throw new Error('Name a model.');
  const clone = freshClone(path.resolve(arg('--work') ?? 'D:\\forgelens-e2e\\probe'));
  const harness = await startHarness(clone, [model]);
  const started = Date.now();
  const parallel = process.argv.includes('--parallel');
  await harness.controller.send(
    parallel
      ? 'In one single message, make two read_file calls together on src/flask/helpers.py: lines 1 to 3, and lines 32 to 33. Then tell me in one sentence what line 33 returns. Do not change anything.'
      : 'Call read_file on src/flask/helpers.py with start_line 32 and end_line 33, then tell me in one sentence what line 33 returns. Do not change anything.',
  );
  const record = harness.record((Date.now() - started) / 1000);
  await harness.close();
  const reads = record.tools.filter((tool) => tool.name === 'read_file' && tool.status === 'done');
  console.log(`Model: ${model}. Status: ${record.status}${record.error ? ` (${record.error})` : ''}. ${record.requests} requests, ${record.seconds.toFixed(1)} s, ${record.tokensIn}/${record.tokensOut} tokens.`);
  console.log(`Tool calls per request: ${record.perRequest.length} requests; read_file calls that ran: ${reads.length}. Answer: ${record.answer.trim().slice(0, 240) || '(none)'}`);
  console.log(`Round trip ${reads.length > 0 && record.status === 'done' && record.answer.trim() ? 'WORKS' : 'FAILS'}. Session: ${record.sessionUrl ?? 'none'}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
