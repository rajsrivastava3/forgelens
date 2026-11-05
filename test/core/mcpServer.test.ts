import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MCP_TOKEN_HEADER,
  startEditorMcpServer,
  type RunningEditorMcpServer,
  type ToolCallRecord,
} from '../../src/core/mcp/server';

const TOKEN = 'test-token';
const calls: ToolCallRecord[] = [];
let server: RunningEditorMcpServer;

beforeAll(async () => {
  server = await startEditorMcpServer({
    token: TOKEN,
    port: {
      workspaceRoot: '/ws',
      readTextFile: (p) =>
        p === 'hello.py' ? Promise.resolve('print("hi")\n') : Promise.reject(new Error('missing')),
      listFiles: () => Promise.resolve(['hello.py']),
      getDiagnostics: () => Promise.resolve([]),
      readDiskBytes: () => Promise.resolve(undefined),
      hasUnsavedChanges: () => false,
      writeFiles: () => Promise.resolve(),
    },
    onToolCall: (r) => calls.push(r),
    configure: (mcp) => {
      mcp.registerTool('extra_tool', { description: 'added by a test' }, () => ({
        content: [{ type: 'text', text: 'extra' }],
      }));
    },
  });
});

afterAll(() => server.close());

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { [MCP_TOKEN_HEADER]: TOKEN } },
    }),
  );
  return client;
}

describe('editor MCP server', () => {
  it('rejects a missing or wrong token', async () => {
    const missing = await fetch(server.url, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(401);
    const wrong = await fetch(server.url, {
      method: 'POST',
      body: '{}',
      headers: { [MCP_TOKEN_HEADER]: 'nope' },
    });
    expect(wrong.status).toBe(401);
  });

  it('rejects a non-loopback Host header', async () => {
    const { request } = await import('node:http');
    const url = new URL(server.url);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { host: 'evil.example', [MCP_TOKEN_HEADER]: TOKEN } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('answers GET with 405 so no standalone stream stays open', async () => {
    const res = await fetch(server.url, { headers: { [MCP_TOKEN_HEADER]: TOKEN } });
    expect(res.status).toBe(405);
  });

  it('lists every tool, annotated, plus configured tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'retrieve_context',
      'repo_map',
      'search_code',
      'find_symbol',
      'find_references',
      'read_file',
      'list_dir',
      'get_diagnostics',
      'get_staged_changes',
      'stage_edit',
      'stage_create_file',
      'stage_delete_file',
      'apply_changes',
      'run_command',
      'extra_tool',
    ]);
    const writers = ['stage_edit', 'stage_create_file', 'stage_delete_file', 'apply_changes', 'run_command'];
    for (const tool of tools.filter((t) => t.name !== 'extra_tool')) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!writers.includes(tool.name));
    }
    expect(tools.find((t) => t.name === 'apply_changes')?.annotations?.destructiveHint).toBe(true);
    await client.close();
  });

  it('apply_changes writes nothing without a reviewed change', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'apply_changes', arguments: { summary: 'not reviewed' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Nothing is staged');
    await client.close();
  });

  it('serves read_file and records the call', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'hello.py' } });
    expect(JSON.stringify(result.content)).toContain('1: print');
    expect(calls.at(-1)).toMatchObject({ tool: 'read_file', ok: true });
    await client.close();
  });

  it('returns a tool error rather than failing the request', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'gone.py' } });
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('reads since the last staged edit', () => {
  const text = (result: Awaited<ReturnType<Client['callTool']>>): string =>
    (result.content as { type: string; text: string }[]).map((part) => part.text).join('');

  it('says it is time to stage after six, starts again on a staged edit, and on a new request', async () => {
    server.newTask();
    const client = await connect();
    const read = async (): Promise<string> => text(await client.callTool({ name: 'read_file', arguments: { path: 'hello.py' } }));
    for (let i = 0; i < 6; i += 1) expect(await read()).not.toContain('[ForgeLens:');
    expect(await read()).toContain('[ForgeLens: 7 reads and searches since your last staged edit.');

    await client.callTool({ name: 'stage_edit', arguments: { path: 'hello.py', edits: [{ old_text: 'hi', new_text: 'hello' }] } });
    expect(await read()).not.toContain('[ForgeLens:');

    for (let i = 0; i < 6; i += 1) await read();
    expect(await read()).toContain('[ForgeLens:');
    server.newTask();
    expect(await read()).not.toContain('[ForgeLens:');
    await client.close();
  });
});
