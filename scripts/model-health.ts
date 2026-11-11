/**
 * Tiny requests to each model through TrueForge, timing the first token, so a slow or failing model shows before a
 * recording rather than during it. demo-prep.ps1 runs it with one request per model; for a diagnosis run more.
 * Usage: npx tsx scripts/model-health.ts --models google-gemini/gemini-3-8-flash,google-gemini/gemini-3-6-flash
 *        [--runs 5] [--gap-s 20] [--effort low] [--max-first-token-s 10] [--timeout-s 30]
 * Exit code 1 when the first model (the primary) errors or its first token is slower than the limit in any run.
 */
import { TrueForge, isEventDelta } from '@truefoundry/trueforge-sdk';
import { arg, BASE_URL } from './rehearse/harness';

interface Probe {
  model: string;
  run: number;
  firstTokenS: number | undefined;
  totalS: number;
  status: string;
  error: string | undefined;
  sessionId: string | undefined;
}

async function probe(client: TrueForge, model: string, run: number, effort: string, timeoutS: number): Promise<Probe> {
  const started = Date.now();
  let sessionId: string | undefined;
  let firstTokenS: number | undefined;
  let status = 'no turn.done';
  let error: string | undefined;
  try {
    const params = effort && effort !== 'default' ? { reasoningEffort: effort } : undefined;
    const session = await client.sessions.create({
      agent: { spec: { model: { name: model, ...(params ? { params } : {}) }, instructions: 'Reply with the one word asked for and nothing else.' } },
    });
    sessionId = session.data.id;
    const stream = await client.sessions.createTurnStream(sessionId, { input: [{ type: 'user.message', content: 'Say OK.' }] });
    // A model can hang with no token for minutes. The probe gives up after timeoutS and cancels the turn, so a
    // pre-recording check stays short.
    const id = sessionId;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void client.sessions.cancel(id).catch(() => undefined);
    }, timeoutS * 1000);
    try {
      for await (const { data: event } of stream.withMetadata()) {
        const hasText = (event.type === 'model.message' && typeof event.content === 'string' && event.content.length > 0) || isEventDelta(event);
        if (firstTokenS === undefined && hasText) firstTokenS = (Date.now() - started) / 1000;
        if (event.type === 'turn.done') {
          status = event.state.status;
          if (event.state.status === 'error') error = event.state.message;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      status = 'timed out';
      error = `no first token within ${timeoutS} s; the turn was cancelled`;
    }
  } catch (caught) {
    status = 'request failed';
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { model, run, firstTokenS, totalS: (Date.now() - started) / 1000, status, error, sessionId };
}

async function main(): Promise<void> {
  const models = (arg('--models') ?? 'google-gemini/gemini-3-8-flash,google-gemini/gemini-3-6-flash').split(',').map((name) => name.trim()).filter(Boolean);
  const runs = Number(arg('--runs') ?? 1);
  const gapMs = Number(arg('--gap-s') ?? 20) * 1000;
  const effort = arg('--effort') ?? 'low';
  const maxFirstTokenS = Number(arg('--max-first-token-s') ?? 10);
  const timeoutS = Number(arg('--timeout-s') ?? 30);
  const client = new TrueForge({ baseUrl: BASE_URL, timeoutInSeconds: 120 });
  const results: Probe[] = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const model of models) {
      if (results.length > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      const result = await probe(client, model, run, effort, timeoutS);
      results.push(result);
      const first = result.firstTokenS === undefined ? 'no token' : `${result.firstTokenS.toFixed(1)} s`;
      console.log(`${model} run ${run}: ${result.status}, first token ${first}, total ${result.totalS.toFixed(1)} s${result.error ? `, error: ${result.error.split('\n')[0]}` : ''}`);
    }
  }
  const primary = models[0];
  const bad = results.filter((result) => result.model === primary && (result.status !== 'done' || result.firstTokenS === undefined || result.firstTokenS > maxFirstTokenS));
  for (const model of models) {
    const own = results.filter((result) => result.model === model);
    const times = own.map((result) => result.firstTokenS).filter((value): value is number => value !== undefined);
    const errors = own.filter((result) => result.status !== 'done').length;
    const summary = times.length > 0 ? `first token ${Math.min(...times).toFixed(1)} to ${Math.max(...times).toFixed(1)} s` : 'no first token';
    console.log(`${model}: ${own.length - errors} of ${own.length} ok, ${summary}.`);
  }
  console.log(JSON.stringify({ effort, maxFirstTokenS, results }));
  if (bad.length > 0) {
    const reason = bad[0]?.error ? bad[0].error.split('\n')[0] : `first token took ${bad[0]?.firstTokenS?.toFixed(1) ?? 'too long'} s, over ${maxFirstTokenS} s`;
    console.log(`PRIMARY NOT HEALTHY: ${primary}: ${reason}`);
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
