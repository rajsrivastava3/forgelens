/**
 * Model bake-off: gives each model the same small multi-file task on a throwaway copy of the target
 * repo, then checks the outcome by running it. Never touches the real checkout.
 *
 * Usage: npx tsx scripts/bakeoff.ts --repo ../flask --python ../flask/.venv/Scripts/python.exe
 *          --tmp <dir> --out results.json --models a/b,c/d
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { isEventDelta, mergeEventDelta, TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { z } from 'zod';
import { MCP_TOKEN_HEADER, startEditorMcpServer } from '../src/core/mcp/server';
import { listWorkspaceFiles, NodeEditorPort, resolveInsideWorkspace } from '../src/core/tools/nodeEditorPort';

const exec = promisify(execFile);

const BAKEOFF_SERVER = 'forgelens-bakeoff';
const MODEL_TIME_LIMIT_MS = 180_000;
const TOTAL_TIME_LIMIT_MS = 15 * 60_000;
const TOTAL_REQUEST_LIMIT = 150;
const MAX_QUOTA_RETRIES = 2;
const MAX_HINTED_WAIT_S = 90;

const TASK = `Add a new public function env_flag(name: str, default: bool = False) -> bool to Flask. It reads the environment variable called name. If it is unset, return default. Return False if the value is one of 0, false, no, off or n, case-insensitively, and True for anything else. Put it with the package's other helper functions, export it so that "from flask import env_flag" works, and add a test for it to the existing test file for those helpers. Find the right files yourself with your tools, then make the edits. Finish with a one-line summary.`;

const INSTRUCTIONS =
  'You are a coding agent working in a repository. Use your tools to find the code. Make precise edits with edit_file. Follow the conventions of the surrounding code. Do not ask the user questions.';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repo = path.resolve(arg('--repo') ?? '../flask');
const python = path.resolve(arg('--python') ?? '../flask/.venv/Scripts/python.exe');
const tmpRoot = path.resolve(arg('--tmp') ?? os.tmpdir());
const models = (arg('--models') ?? '').split(',').filter(Boolean);
const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });

const startedAll = Date.now();
let totalRequests = 0;

interface EditStats {
  ok: number;
  failed: number;
}

interface TurnOutcome {
  status: string;
  error?: string;
  metrics?: TrueForgeApi.TurnMetrics;
}

async function copyRepo(): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  const dir = await mkdtemp(path.join(tmpRoot, 'bakeoff-'));
  const archive = path.join(dir, 'repo.tar');
  await exec('git', ['-C', repo, 'archive', '--format=tar', '-o', archive, 'HEAD']);
  // A relative name: GNU tar reads the drive colon in a Windows path as a remote host.
  await exec('tar', ['-xf', 'repo.tar'], { cwd: dir });
  await rm(archive, { force: true });
  return dir;
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = await listWorkspaceFiles(dir);
  const contents = new Map<string, string>();
  for (const file of files) {
    contents.set(file, await readFile(path.join(dir, file), 'latin1'));
  }
  return contents;
}

async function verify(dir: string): Promise<Record<string, unknown>> {
  const env = { ...process.env, PYTHONPATH: path.join(dir, 'src'), PYTHONDONTWRITEBYTECODE: '1' };
  const probe = `
import os, flask
from flask import env_flag
assert os.path.realpath(flask.__file__).startswith(os.path.realpath(${JSON.stringify(dir)})), flask.__file__
os.environ.pop("BK", None)
assert env_flag("BK") is False and env_flag("BK", True) is True
for v in ("0", "false", "NO", "Off", "n"):
    os.environ["BK"] = v
    assert env_flag("BK", True) is False, v
for v in ("1", "yes", "on"):
    os.environ["BK"] = v
    assert env_flag("BK") is True, v
print("behaviour ok")
`;
  const behaviour = await exec(python, ['-c', probe], { cwd: dir, env })
    .then(() => ({ ok: true, detail: '' }))
    .catch((e: { stderr?: string }) => ({ ok: false, detail: (e.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '' }));
  // test_async_view fails on the untouched repo too: it needs the optional flask[async] extra.
  const tests = await exec(
    python,
    ['-m', 'pytest', 'tests/test_helpers.py', '-q', '-p', 'no:cacheprovider', '-k', 'not test_async_view'],
    { cwd: dir, env },
  )
    .then((r) => ({ ok: true, detail: r.stdout.trim().split('\n').slice(-1)[0] ?? '' }))
    .catch((e: { stdout?: string }) => ({ ok: false, detail: (e.stdout ?? '').trim().split('\n').slice(-1)[0] ?? '' }));
  const testFile = await readFile(path.join(dir, 'tests/test_helpers.py'), 'utf8');
  return { behaviour, tests, testMentionsEnvFlag: testFile.includes('env_flag') };
}

async function runModel(model: string): Promise<Record<string, unknown>> {
  console.log(`\n=== ${model} ===`);
  const dir = await copyRepo();
  const before = await snapshot(dir);
  const edits: EditStats = { ok: 0, failed: 0 };
  const toolOrder: string[] = [];
  const token = randomBytes(32).toString('hex');

  const mcp = await startEditorMcpServer({
    port: new NodeEditorPort(dir),
    token,
    onToolCall: (record) => toolOrder.push(record.tool),
    configure: (server) => {
      server.registerTool(
        'edit_file',
        {
          description:
            'Replace exact text in a file. old_text must match once. To create a file, or to add to an empty one, use write_file.',
          inputSchema: { path: z.string(), old_text: z.string(), new_text: z.string() },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async (args) => {
          toolOrder.push('edit_file');
          try {
            const target = resolveInsideWorkspace(dir, args.path);
            const text = await readFile(target, 'utf8');
            const count = args.old_text ? text.split(args.old_text).length - 1 : 0;
            if (count !== 1) {
              edits.failed += 1;
              return { content: [{ type: 'text', text: `Error: old_text matched ${count} times, expected 1.` }], isError: true };
            }
            await writeFile(target, text.replace(args.old_text, () => args.new_text));
            edits.ok += 1;
            return { content: [{ type: 'text', text: `Edited ${args.path}` }] };
          } catch (error) {
            edits.failed += 1;
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
          }
        },
      );
      server.registerTool(
        'write_file',
        {
          description: 'Create or overwrite a file with the given content.',
          inputSchema: { path: z.string(), content: z.string() },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        async (args) => {
          toolOrder.push('write_file');
          const target = resolveInsideWorkspace(dir, args.path);
          await writeFile(target, args.content);
          edits.ok += 1;
          return { content: [{ type: 'text', text: `Wrote ${args.path}` }] };
        },
      );
    },
  });

  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      type: 'remote',
      name: BAKEOFF_SERVER,
      url: mcp.url,
      description: 'Bake-off tools working on a temporary copy of the repository.',
      auth: { type: 'header', headers: { [MCP_TOKEN_HEADER]: token } },
    },
  });

  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: model },
        instructions: INSTRUCTIONS,
        mcpServers: [
          {
            name: BAKEOFF_SERVER,
            preloadTools: ['retrieve_context', 'search_code', 'read_file', 'list_dir', 'edit_file', 'write_file'],
            requireApprovalForTools: [],
          },
        ],
        config: {
          iterationLimit: 25,
          generativeUi: { enabled: false },
          askUserQuestions: { enabled: false },
        },
      },
    },
  });
  const url = `${baseUrl}/sessions/${session.id}`;
  console.log(url);

  const started = Date.now();
  let requests = 0;
  let quotaHits = 0;
  let resumes = 0;
  let timedOut = false;
  const quotaMessages: string[] = [];
  const metricsPerTurn: TrueForgeApi.TurnMetrics[] = [];
  let outcome: TurnOutcome = { status: 'unknown' };
  const deadline = setTimeout(() => {
    timedOut = true;
    void client.sessions.cancel(session.id);
  }, MODEL_TIME_LIMIT_MS);

  const runTurn = async (content: string): Promise<TurnOutcome> => {
    const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: 'user.message', content }],
    });
    let result: TurnOutcome = { status: 'unknown' };
    for await (const { data: event } of stream.withMetadata()) {
      if (isEventDelta(event)) {
        const base = events.get(event.id);
        if (base) mergeEventDelta(base, event);
        continue;
      }
      events.set(event.id, event);
      if (event.type === 'model.message') {
        requests += 1;
        totalRequests += 1;
        if (totalRequests >= TOTAL_REQUEST_LIMIT) void client.sessions.cancel(session.id);
      }
      if (event.type === 'turn.done') {
        const state = event.state;
        result = { status: state.status };
        if (state.status === 'error') result.error = state.message;
        if (state.status === 'cancelled') result.error = `cancelled: ${state.reason}`;
        if (state.metrics) {
          result.metrics = state.metrics;
          metricsPerTurn.push(state.metrics);
        }
      }
    }
    return result;
  };

  try {
    outcome = await runTurn(TASK);
    while (outcome.error && /\(429\)/.test(outcome.error) && !timedOut) {
      quotaHits += 1;
      quotaMessages.push(/description: [^.]*/.exec(outcome.error)?.[0] ?? outcome.error.slice(0, 120));
      const hintedSeconds = /retry in ([\d.]+)s/i.exec(outcome.error)?.[1];
      const waitS = hintedSeconds ? Number(hintedSeconds) + 2 : 30;
      if (resumes >= MAX_QUOTA_RETRIES || waitS > MAX_HINTED_WAIT_S) break;
      resumes += 1;
      console.log(`429, waiting ${Math.round(waitS)}s, then resuming the same session`);
      await new Promise((resolve) => setTimeout(resolve, waitS * 1000));
      // A new turn chains on the failed one, so finished work is not redone.
      outcome = await runTurn('Continue the task from where you stopped.');
    }
  } catch (error) {
    outcome = { status: 'exception', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(deadline);
  }
  const seconds = Math.round((Date.now() - started) / 1000);

  const after = await snapshot(dir);
  const changed = [...after.keys()].filter((f) => before.get(f) !== after.get(f));
  const removed = [...before.keys()].filter((f) => !after.has(f));
  const verification = await verify(dir);
  await mcp.close();
  await rm(dir, { recursive: true, force: true });

  const sum = (key: keyof TrueForgeApi.TurnMetrics): number =>
    metricsPerTurn.reduce((total, metrics) => total + (metrics[key] ?? 0), 0);
  const expected = ['src/flask/helpers.py', 'src/flask/__init__.py', 'tests/test_helpers.py'];

  return {
    model,
    url,
    status: outcome.status,
    error: outcome.error?.slice(0, 300),
    quotaBlocked: quotaHits > MAX_QUOTA_RETRIES || (quotaHits > 0 && /\(429\)/.test(outcome.error ?? '')),
    quotaHits,
    quotaMessages,
    timedOut,
    seconds,
    requests,
    changed,
    removed,
    foundExpectedFiles: expected.filter((f) => changed.includes(f)),
    edits,
    tools: toolOrder,
    verification,
    inputTokens: sum('totalInputTokens'),
    outputTokens: sum('totalOutputTokens'),
    reasoningTokens: sum('totalReasoningTokens'),
    costUsd: sum('totalCostInUsd'),
  };
}

async function main(): Promise<void> {
  const results: Record<string, unknown>[] = [];
  const out = arg('--out');
  try {
    for (const model of models) {
      if (Date.now() - startedAll > TOTAL_TIME_LIMIT_MS || totalRequests >= TOTAL_REQUEST_LIMIT) {
        results.push({ model, skipped: 'over the time or request budget' });
        continue;
      }
      const result = await runModel(model);
      results.push(result);
      console.log(JSON.stringify(result, null, 2));
      if (out) await writeFile(out, JSON.stringify(results, null, 2));
    }
  } finally {
    await client.settings.mcpServers.delete(BAKEOFF_SERVER).catch(() => undefined);
    console.log(`\nregistration ${BAKEOFF_SERVER} removed; totals: ${totalRequests} requests, ${Math.round((Date.now() - startedAll) / 1000)}s`);
  }
  if (out) await writeFile(out, JSON.stringify(results, null, 2));
}

main().catch((error: unknown) => {
  console.error('bakeoff failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
