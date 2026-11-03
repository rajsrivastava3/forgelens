/**
 * P0 spike: proves the architecture end to end, headlessly, against whichever model TrueForge has.
 *
 *   read             the agent calls OUR read_file
 *   subagent         a dynamic subagent calls OUR read_file
 *   probe-preloaded  a by-name approval gate on a preloaded tool, allow and deny
 *   probe-via-call-tool  the same gate on a preloaded tool the model reaches through call_tool
 *   probe-deferred   the same gate on a deferred tool, reached through call_tool
 *   probe-subagent   the same gate when a subagent makes the call
 *
 * Every claim is checked twice: in the TrueForge event stream and in our own server's call log.
 *
 * Usage: npm run spike -- --model provider/model [--tests read,subagent] [--params '{"k":1}'] [--attempts 4] [--gap seconds] [--out results.json]
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { isEventDelta, mergeEventDelta, TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { z } from 'zod';
import { MCP_TOKEN_HEADER, startEditorMcpServer, type ToolCallRecord } from '../src/core/mcp/server';
import { NodeEditorPort } from '../src/core/tools/nodeEditorPort';

const MCP_SERVER_NAME = 'forgelens-editor';
const MCP_PORT = 8799;
const PROBE_TOOL = 'apply_changes_probe';
const TURN_TIMEOUT_MS = 180_000;
const ALL_TESTS = ['read', 'subagent', 'probe-preloaded', 'probe-via-call-tool', 'probe-deferred', 'probe-subagent'];

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Passed to TrueForge as model.params, which forwards unknown keys to the provider. */
const modelParams = z
  .record(z.string(), z.unknown())
  .optional()
  .parse(argValue('--params') === undefined ? undefined : JSON.parse(argValue('--params') ?? '{}'));

const workspace = path.resolve(argValue('--workspace') ?? path.join(process.cwd(), '..', 'flask'));
const client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });
const serverCalls: ToolCallRecord[] = [];
const MAX_ATTEMPTS = Number(argValue('--attempts') ?? 4);
const GAP_SECONDS = Number(argValue('--gap') ?? 0);
const transientErrors: { test: string; at: string; error: string }[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Reruns a whole test on provider overload or rate limits, and records every occurrence. */
async function withTransientRetry(
  label: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = {};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    result = await run();
    const error = result['error'];
    const transient = typeof error === 'string' && /((429|500|502|503|504))/.test(error);
    if (!transient) return { ...result, attempts: attempt };
    transientErrors.push({ test: label, at: new Date().toISOString(), error: error.slice(0, 140) });
    if (attempt === MAX_ATTEMPTS) break;
    const hinted = /retry in ([d.]+)s/i.exec(error)?.[1];
    const waitMs = hinted ? (Number(hinted) + 2) * 1000 : 20_000;
    console.log(`
[retry] ${label} attempt ${attempt} failed (${error.slice(0, 60)}), waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
  return { ...result, attempts: MAX_ATTEMPTS, gaveUp: true };
}

type McpServerSpec = NonNullable<TrueForgeApi.AgentSpec['mcpServers']>[number];
type TurnInput = TrueForgeApi.UserToolApprovalInputEvent | { type: 'user.message'; content: string };

interface ObservedCall {
  threadId: string;
  toolInfoType: string;
  toolInfoName: string;
  functionName: string;
  args: string;
}

interface PendingApproval {
  threadId: string;
  ref: TrueForgeApi.ToolCallRef;
  call: ObservedCall | undefined;
}

interface TurnResult {
  status: string;
  error?: string;
  output: string;
  firstTokenMs: number | null;
  totalMs: number;
  approvals: PendingApproval[];
  threads: string[];
  toolResponses: { toolCallId: string; content: string }[];
}

class Session {
  readonly events = new Map<string, TrueForgeApi.TurnStreamingEvent>();

  private constructor(readonly id: string) {}

  static async open(model: string, instructions: string, server: McpServerSpec): Promise<Session> {
    const { data } = await client.sessions.create({
      agent: {
        spec: {
          model: { name: model, ...(modelParams ? { params: modelParams } : {}) },
          instructions,
          mcpServers: [server],
          config: {
            dynamicSubAgents: { enabled: true },
            generativeUi: { enabled: false },
            askUserQuestions: { enabled: false },
          },
        },
      },
    });
    console.log(`session: ${baseUrl}/sessions/${data.id}`);
    return new Session(data.id);
  }

  get url(): string {
    return `${baseUrl}/sessions/${this.id}`;
  }

  /** Every tool call the model made in this session, oldest first. */
  toolCalls(): ObservedCall[] {
    const calls: ObservedCall[] = [];
    for (const event of this.events.values()) {
      if (event.type !== 'model.message') continue;
      for (const call of event.toolCalls ?? []) calls.push(describeCall(event.threadId, call));
    }
    return calls;
  }

  async turn(input: TurnInput[]): Promise<TurnResult> {
    const started = Date.now();
    const result: TurnResult = {
      status: 'unknown',
      output: '',
      firstTokenMs: null,
      totalMs: 0,
      approvals: [],
      threads: [],
      toolResponses: [],
    };
    const watchdog = setTimeout(() => {
      console.log(`\n[watchdog] no end after ${TURN_TIMEOUT_MS} ms, cancelling`);
      void client.sessions.cancel(this.id);
    }, TURN_TIMEOUT_MS);

    try {
      const stream = await client.sessions.createTurnStream(this.id, { input });
      for await (const { data: event } of stream.withMetadata()) {
        if (isEventDelta(event)) {
          result.firstTokenMs ??= Date.now() - started;
          const base = this.events.get(event.id);
          if (base) mergeEventDelta(base, event);
          if (typeof event.content === 'string') process.stdout.write(event.content);
          continue;
        }
        this.events.set(event.id, event);
        console.log(`\n[event] ${event.type} thread=${'threadId' in event ? event.threadId : '-'}`);
        if (event.type === 'thread.created') {
          result.threads.push(event.title);
          console.log(`        subagent: ${event.title}`);
        }
        if (event.type === 'tool.response') {
          result.toolResponses.push({ toolCallId: event.toolCallId, content: event.content });
          console.log(`        result: ${event.content.slice(0, 160).replace(/\s+/g, ' ')}`);
        }
        if (event.type === 'tool.approval_required') {
          for (const ref of event.toolCalls) {
            result.approvals.push({ threadId: event.threadId, ref, call: this.findCall(ref) });
          }
        }
        if (event.type === 'turn.done') {
          result.status = event.state.status;
          if (event.state.status === 'done') result.output = contentText(event.state.output?.content);
          if (event.state.status === 'error') result.error = event.state.message;
          if (event.state.status === 'cancelled') result.error = `cancelled: ${event.state.reason}`;
        }
      }
    } catch (error) {
      result.status = 'exception';
      result.error = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(watchdog);
    }

    result.totalMs = Date.now() - started;
    console.log(`\nturn: status=${result.status} firstToken=${result.firstTokenMs}ms total=${result.totalMs}ms`);
    if (result.error) console.log(`turn error: ${result.error}`);
    return result;
  }

  private findCall(ref: TrueForgeApi.ToolCallRef): ObservedCall | undefined {
    const message = this.events.get(ref.sourceEventId);
    if (message?.type !== 'model.message') return undefined;
    const call = message.toolCalls?.find((c) => c.id === ref.id);
    return call ? describeCall(message.threadId, call) : undefined;
  }
}

function describeCall(threadId: string, call: TrueForgeApi.ToolCall): ObservedCall {
  return {
    threadId,
    toolInfoType: call.toolInfo.type,
    toolInfoName: call.toolInfo.name,
    functionName: call.function.name,
    args: call.function.arguments,
  };
}

function contentText(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** The MCP tool a call really targets, seeing through the call_tool meta tool. */
function targetTool(call: ObservedCall): string {
  if (call.toolInfoName !== 'call_tool') return call.toolInfoName;
  const parsed = z.object({ tool_name: z.string() }).safeParse(JSON.parse(call.args || '{}'));
  return parsed.success ? parsed.data.tool_name : 'call_tool';
}

const callsSince = (mark: number, tool: string): ToolCallRecord[] =>
  serverCalls.slice(mark).filter((c) => c.tool === tool);

const readServer: McpServerSpec = { name: MCP_SERVER_NAME, preloadTools: ['read_file'] };

async function testRead(model: string): Promise<Record<string, unknown>> {
  console.log('\n=== read: agent calls our read_file ===');
  const source = await readFile(path.join(workspace, 'src/flask/helpers.py'), 'utf8');
  const trueLine = source.split(/\r?\n/).findIndex((l) => l.startsWith('def get_debug_flag')) + 1;

  const mark = serverCalls.length;
  const session = await Session.open(
    model,
    'You answer questions about a code repository. Use your tools to read files; never guess.',
    readServer,
  );
  const turn = await session.turn([
    { type: 'user.message', content: 'Read src/flask/helpers.py and tell me the line where get_debug_flag is defined' },
  ]);
  const stream = session.toolCalls();
  const server = callsSince(mark, 'read_file');
  return {
    url: session.url,
    status: turn.status,
    error: turn.error,
    firstTokenMs: turn.firstTokenMs,
    totalMs: turn.totalMs,
    streamToolCalls: stream,
    serverLog: server,
    answer: turn.output,
    trueLine,
    answerHasTrueLine: new RegExp(`\\b${trueLine}\\b`).test(turn.output),
    pass: server.some((c) => c.ok) && stream.some((c) => targetTool(c) === 'read_file'),
  };
}

async function testSubagent(model: string): Promise<Record<string, unknown>> {
  console.log('\n=== subagent: dynamic subagent calls our read_file ===');
  const mark = serverCalls.length;
  const session = await Session.open(
    model,
    'You coordinate work. You must delegate every file reading task to a subagent with the create_sub_agent tool. Never read files yourself.',
    readServer,
  );
  const turn = await session.turn([
    {
      type: 'user.message',
      content:
        'Spawn one subagent that uses the read_file tool on src/flask/helpers.py and reports the line where get_debug_flag is defined. Then tell me its answer.',
    },
  ]);
  const calls = session.toolCalls();
  const fromSubagents = calls.filter((c) => c.threadId !== 'main' && targetTool(c) === 'read_file');
  const fromMain = calls.filter((c) => c.threadId === 'main' && targetTool(c) === 'read_file');
  const server = callsSince(mark, 'read_file');
  return {
    url: session.url,
    status: turn.status,
    error: turn.error,
    totalMs: turn.totalMs,
    threads: turn.threads,
    mainThreadCalls: calls.filter((c) => c.threadId === 'main').map((c) => c.toolInfoName),
    subagentReadFileCalls: fromSubagents,
    mainReadFileCalls: fromMain,
    serverLog: server,
    answer: turn.output,
    // Clean attribution needs the main thread to have stayed out of it.
    pass: fromSubagents.length > 0 && fromMain.length === 0 && server.some((c) => c.ok),
  };
}

type ProbeMode = 'preloaded' | 'preloaded-via-call-tool' | 'deferred' | 'subagent';

const probeSetups: Record<ProbeMode, { server: McpServerSpec; instructions: string; prompt: (s: string) => string }> = {
  preloaded: {
    server: { name: MCP_SERVER_NAME, preloadTools: ['read_file', PROBE_TOOL], requireApprovalForTools: [PROBE_TOOL] },
    instructions: `You are a test agent. When asked, call ${PROBE_TOOL} directly. Do not explain first.`,
    prompt: (s) => `Call ${PROBE_TOOL} exactly once with summary "${s}". If it is denied, do not retry; say so and stop.`,
  },
  'preloaded-via-call-tool': {
    server: { name: MCP_SERVER_NAME, preloadTools: ['read_file', PROBE_TOOL], requireApprovalForTools: [PROBE_TOOL] },
    instructions: `You are a test agent. Always invoke MCP tools through the call_tool meta tool, even when you could call them directly. ${PROBE_TOOL} is on the MCP server ${MCP_SERVER_NAME}.`,
    prompt: (s) => `Use call_tool to call ${PROBE_TOOL} exactly once with summary "${s}". If it is denied, do not retry; say so and stop.`,
  },
  deferred: {
    server: { name: MCP_SERVER_NAME, preloadTools: ['read_file'], requireApprovalForTools: [PROBE_TOOL] },
    instructions: `You are a test agent. ${PROBE_TOOL} lives on the MCP server ${MCP_SERVER_NAME}. It is not preloaded, so reach it with your MCP meta tools.`,
    prompt: (s) => `Call ${PROBE_TOOL} exactly once with summary "${s}". If it is denied, do not retry; say so and stop.`,
  },
  subagent: {
    server: { name: MCP_SERVER_NAME, preloadTools: ['read_file', PROBE_TOOL], requireApprovalForTools: [PROBE_TOOL] },
    instructions: 'You coordinate work. Delegate every tool call to a subagent with create_sub_agent.',
    prompt: (s) => `Spawn one subagent that calls ${PROBE_TOOL} exactly once with summary "${s}". If it is denied, do not retry.`,
  },
};

async function runProbe(model: string, mode: ProbeMode, decision: 'allow' | 'deny'): Promise<Record<string, unknown>> {
  console.log(`\n--- probe mode=${mode} decision=${decision} ---`);
  const nonce = `probe-${mode}-${decision}-${randomBytes(3).toString('hex')}`;
  const mark = serverCalls.length;
  const setup = probeSetups[mode];
  const session = await Session.open(model, setup.instructions, setup.server);

  const first = await session.turn([{ type: 'user.message', content: setup.prompt(nonce) }]);
  // The gate's whole purpose: nothing may have reached our server yet.
  const executedBeforeDecision = callsSince(mark, PROBE_TOOL).length;

  const pendingRefs = first.approvals.map((a) => ({ ...a }));
  let turn = first;
  let rounds = 0;
  const resumeResponses: TurnResult['toolResponses'] = [];
  while (turn.approvals.length > 0 && rounds < 3) {
    rounds += 1;
    turn = await session.turn(
      turn.approvals.map((a) => ({
        type: 'user.tool_approval' as const,
        threadId: a.threadId,
        toolCallId: a.ref.id,
        approval: decision === 'allow' ? { status: 'allow' as const } : { status: 'deny' as const, reason: 'denied by spike' },
      })),
    );
    resumeResponses.push(...turn.toolResponses);
  }

  const executed = callsSince(mark, PROBE_TOOL);
  const firstCall = pendingRefs[0]?.call;
  return {
    url: session.url,
    mode,
    decision,
    nonce,
    firstTurnStatus: first.status,
    error: first.error ?? turn.error,
    finalStatus: turn.status,
    approvalFired: pendingRefs.length > 0,
    pendingRefRaw: pendingRefs[0]?.ref,
    pendingCallResolved: firstCall,
    routedThroughCallTool: firstCall?.toolInfoName === 'call_tool',
    realToolNameRecoverable: firstCall ? targetTool(firstCall) === PROBE_TOOL : false,
    realToolNameInToolInfo: firstCall?.toolInfoName === PROBE_TOOL,
    realToolNameInFunction: firstCall?.functionName === PROBE_TOOL,
    summaryVisibleInArgs: firstCall?.args.includes(nonce) ?? false,
    toolCallsSeen: session.toolCalls(),
    executedBeforeDecision,
    executedAfterDecision: executed.length,
    serverLog: executed,
    resumeResponses,
    finalOutput: turn.output,
    pass:
      pendingRefs.length > 0 &&
      executedBeforeDecision === 0 &&
      (decision === 'allow' ? executed.length === 1 : executed.length === 0),
  };
}

async function testProbe(model: string, mode: ProbeMode): Promise<Record<string, unknown>> {
  console.log(`\n=== probe-${mode}: gate ${PROBE_TOOL} by name ===`);
  const allow = await withTransientRetry(`probe-${mode}-allow`, () => runProbe(model, mode, 'allow'));
  await sleep(GAP_SECONDS * 1000);
  const deny = await withTransientRetry(`probe-${mode}-deny`, () => runProbe(model, mode, 'deny'));
  return { allow, deny, pass: allow['pass'] === true && deny['pass'] === true };
}

async function main(): Promise<number> {
  const token = randomBytes(32).toString('hex');
  const mcp = await startEditorMcpServer({
    port: new NodeEditorPort(workspace),
    token,
    listenPort: MCP_PORT,
    onToolCall: (record) => {
      serverCalls.push(record);
      console.log(`\n[OUR MCP SERVER] ${record.at} ${record.tool} ${JSON.stringify(record.args)} ok=${record.ok}`);
    },
    configure: (server) => {
      server.registerTool(
        PROBE_TOOL,
        {
          description: 'Spike only: stands in for apply_changes. Records that it ran and changes nothing.',
          inputSchema: { summary: z.string().describe('What is being applied') },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        (args) => {
          const record = { tool: PROBE_TOOL, args, at: new Date().toISOString(), ok: true };
          serverCalls.push(record);
          console.log(`\n[OUR MCP SERVER] ${record.at} ${PROBE_TOOL} ${JSON.stringify(args)} EXECUTED`);
          return { content: [{ type: 'text', text: `probe executed: ${args.summary}` }] };
        },
      );
    },
  });
  console.log(`MCP server: ${mcp.url}\nworkspace:  ${workspace}`);

  try {
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name: MCP_SERVER_NAME,
        url: mcp.url,
        description: 'ForgeLens editor tools for the open VS Code workspace.',
        auth: { type: 'header', headers: { [MCP_TOKEN_HEADER]: token } },
      },
    });
    const { data: tools } = await client.mcpServers.listTools(MCP_SERVER_NAME);
    console.log(`TrueForge sees tools: ${JSON.stringify(tools.map((t) => t['name']))}`);

    const { data: models } = await client.models.list();
    const model = argValue('--model');
    if (!model || !models.some((m) => m.name === model)) {
      console.log(`Pass --model with one of:\n  ${models.map((m) => m.name).join('\n  ')}`);
      return 2;
    }
    console.log(`using: ${model}`);

    const tests = (argValue('--tests') ?? ALL_TESTS.join(',')).split(',');
    const results: Record<string, unknown> = { model, at: new Date().toISOString() };
    for (const test of tests) {
      if (test === 'read') results[test] = await withTransientRetry(test, () => testRead(model));
      else if (test === 'subagent') results[test] = await withTransientRetry(test, () => testSubagent(model));
      else if (test === 'probe-preloaded') results[test] = await testProbe(model, 'preloaded');
      else if (test === 'probe-via-call-tool') results[test] = await testProbe(model, 'preloaded-via-call-tool');
      else if (test === 'probe-deferred') results[test] = await testProbe(model, 'deferred');
      else if (test === 'probe-subagent') results[test] = await testProbe(model, 'subagent');
      else throw new Error(`Unknown test: ${test}`);
      await sleep(GAP_SECONDS * 1000);
    }
    results['transientErrors'] = transientErrors;

    const json = JSON.stringify(results, null, 2);
    console.log(`\n=== RESULTS ===\n${json}`);
    const out = argValue('--out');
    if (out) await writeFile(out, json);
    return 0;
  } finally {
    // The port closes with this script, so leave no registration pointing at it.
    await client.settings.mcpServers.delete(MCP_SERVER_NAME).catch(() => undefined);
    await mcp.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('spike failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
