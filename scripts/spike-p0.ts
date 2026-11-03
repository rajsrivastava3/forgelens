/**
 * P0 spike: proves the architecture end to end, headlessly.
 *   1. Host our MCP server on 127.0.0.1 and register it in TrueForge through the API.
 *   2. Have TrueForge list its tools, which proves TrueForge can reach it past the SSRF guard.
 *   3. Run an agent with an inline spec and show it calling OUR read_file.
 *   4. Check whether a dynamic subagent can call our tool too.
 *
 * Usage: npm run spike -- [--model provider/model] [--workspace path]
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { isEventDelta, mergeEventDelta, TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import {
  MCP_TOKEN_HEADER,
  startEditorMcpServer,
  type ToolCallRecord,
} from '../src/core/mcp/server';
import { NodeEditorPort } from '../src/core/tools/nodeEditorPort';

const MCP_SERVER_NAME = 'forgelens-editor';
const MCP_PORT = 8799;
const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const workspace = path.resolve(argValue('--workspace') ?? path.join(process.cwd(), '..', 'flask'));
const client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });
const serverCalls: ToolCallRecord[] = [];

interface TurnOutcome {
  sessionId: string;
  status: string;
  output: string;
  /** Every tool call the model made, with the thread it came from. */
  toolCalls: { threadId: string; tool: string; type: string; args: string }[];
  threads: { threadId: string; title: string }[];
}

function contentText(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

async function runTurn(label: string, model: string, instructions: string, message: string): Promise<TurnOutcome> {
  console.log(`\n=== ${label} ===`);
  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: model },
        instructions,
        mcpServers: [{ name: MCP_SERVER_NAME, preloadTools: ['read_file'] }],
        config: {
          dynamicSubAgents: { enabled: true },
          generativeUi: { enabled: false },
          askUserQuestions: { enabled: false },
        },
      },
    },
  });
  console.log(`session: ${session.id}  (${baseUrl})`);

  const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
  const threads: TurnOutcome['threads'] = [];
  let status = 'unknown';
  let output = '';

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: message }],
  });
  for await (const { data: event } of stream.withMetadata()) {
    if (isEventDelta(event)) {
      const base = events.get(event.id);
      if (base) mergeEventDelta(base, event);
      if (typeof event.content === 'string') process.stdout.write(event.content);
      continue;
    }
    events.set(event.id, event);
    console.log(`\n[event] ${event.type}${'threadId' in event ? ` thread=${event.threadId}` : ''}`);
    if (event.type === 'thread.created') {
      threads.push({ threadId: event.threadId, title: event.title });
      console.log(`        subagent: ${event.title}`);
    }
    if (event.type === 'turn.done') {
      status = event.state.status;
      if (event.state.status === 'done') output = contentText(event.state.output?.content);
      if (event.state.status === 'error') console.log(`        error: ${event.state.message}`);
      if (event.state.status === 'cancelled') console.log(`        reason: ${event.state.reason}`);
    }
  }

  const toolCalls: TurnOutcome['toolCalls'] = [];
  for (const event of events.values()) {
    if (event.type !== 'model.message') continue;
    for (const call of event.toolCalls ?? []) {
      toolCalls.push({
        threadId: event.threadId,
        tool: call.toolInfo.name,
        type: call.toolInfo.type,
        args: call.function.arguments,
      });
    }
  }
  console.log(`\nstatus: ${status}`);
  console.log('tool calls seen in the TrueForge stream:', JSON.stringify(toolCalls, null, 2));
  return { sessionId: session.id, status, output, toolCalls, threads };
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
  });
  console.log(`MCP server: ${mcp.url}\nworkspace:  ${workspace}`);

  try {
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name: MCP_SERVER_NAME,
        url: mcp.url,
        description: 'ForgeLens editor tools: read files in the open VS Code workspace.',
        auth: { type: 'header', headers: { [MCP_TOKEN_HEADER]: token } },
      },
    });
    console.log(`registered ${MCP_SERVER_NAME} in TrueForge`);

    const { data: tools } = await client.mcpServers.listTools(MCP_SERVER_NAME);
    console.log('tools as TrueForge sees them:', JSON.stringify(tools));

    const { data: models } = await client.models.list();
    const model = argValue('--model') ?? models[0]?.name;
    if (!model) {
      console.log('\nNo models configured in TrueForge. Add one under Settings -> Models, then rerun.');
      return 2;
    }
    console.log(`models available: ${models.map((m) => m.name).join(', ')}\nusing: ${model}`);

    const direct = await runTurn(
      'TEST 1: agent calls our read_file',
      model,
      'You answer questions about a code repository. Use your tools to read files; never guess.',
      'Read src/flask/helpers.py and tell me the line where get_debug_flag is defined',
    );
    const directCalls = serverCalls.length;

    const sub = await runTurn(
      'TEST 2: dynamic subagent calls our read_file',
      model,
      'You coordinate work. You must delegate every file reading task to a subagent with the create_sub_agent tool. Never read files yourself.',
      'Spawn one subagent that uses the read_file tool on src/flask/helpers.py and reports the line where get_debug_flag is defined. Then tell me its answer.',
    );
    const subServerCalls = serverCalls.length - directCalls;
    const subThreadCalls = sub.toolCalls.filter(
      (c) => c.threadId !== 'main' && c.tool.includes('read_file'),
    );

    console.log('\n=== RESULTS ===');
    console.log(`TEST 1 session ${direct.sessionId}: status=${direct.status}, our server received ${directCalls} call(s)`);
    console.log(`  answer: ${direct.output}`);
    console.log(`TEST 2 session ${sub.sessionId}: status=${sub.status}, threads=${JSON.stringify(sub.threads)}`);
    console.log(`  read_file calls from non-main threads: ${subThreadCalls.length}; our server received ${subServerCalls} call(s)`);
    console.log(`  answer: ${sub.output}`);
    console.log(`\nTEST 1 ${directCalls > 0 ? 'PASS' : 'FAIL'}: agent called our tool`);
    console.log(`TEST 2 ${subThreadCalls.length > 0 && subServerCalls > 0 ? 'PASS' : 'FAIL'}: subagent called our tool`);
    return directCalls > 0 && subThreadCalls.length > 0 && subServerCalls > 0 ? 0 : 1;
  } finally {
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
