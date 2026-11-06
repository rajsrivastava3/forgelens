import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MCP_TOKEN_HEADER,
  startEditorMcpServer,
  type RunningEditorMcpServer,
  type ToolCallRecord,
  READ_LIMIT_MESSAGE,
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

describe('read limit', () => {
  const text = (result: Awaited<ReturnType<Client['callTool']>>): string =>
    (result.content as { type: string; text: string }[]).map((part) => part.text).join('');

  it('refuses reads and searches after eight with nothing staged, until a stage_edit or a new turn', async () => {
    server.newTask();
    const client = await connect();
    const read = (): Promise<Awaited<ReturnType<Client['callTool']>>> => client.callTool({ name: 'read_file', arguments: { path: 'hello.py' } });
    const search = (): Promise<Awaited<ReturnType<Client['callTool']>>> => client.callTool({ name: 'search_code', arguments: { query: 'hi' } });
    for (let i = 0; i < 4; i += 1) expect((await read()).isError).toBeFalsy();
    for (let i = 0; i < 4; i += 1) expect(text(await search())).not.toBe(READ_LIMIT_MESSAGE);
    const refused = await read();
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('Read limit reached. Stage your edits with stage_edit now; reads unlock after the next stage_edit.');
    expect(text(await client.callTool({ name: 'find_symbol', arguments: { name: 'hi' } }))).toBe(READ_LIMIT_MESSAGE);
    // Tools outside the limit still work.
    expect(text(await client.callTool({ name: 'get_staged_changes', arguments: {} }))).not.toBe(READ_LIMIT_MESSAGE);

    // Any staging attempt unlocks reads, even one whose edit does not match.
    await client.callTool({ name: 'stage_edit', arguments: { path: 'hello.py', edits: [{ old_text: 'no such text', new_text: 'x' }] } });
    expect(text(await read())).toContain('1: print("hi")');

    for (let i = 0; i < 7; i += 1) await read();
    expect(text(await read())).toBe(READ_LIMIT_MESSAGE);
    server.newTask();
    expect(text(await read())).toContain('1: print("hi")');
    await client.close();
  });
});
