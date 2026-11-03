import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { EditorPort } from '../tools/editorPort';
import { readFileTool } from '../tools/readFile';

export const MCP_TOKEN_HEADER = 'x-forgelens-token';

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  at: string;
  ok: boolean;
}

export interface EditorMcpServerOptions {
  port: EditorPort;
  token: string;
  /** TCP port on 127.0.0.1. 0 picks a free port. */
  listenPort?: number;
  onToolCall?: (record: ToolCallRecord) => void;
  /** Registers additional tools on each per-request server instance. */
  configure?: (server: McpServer) => void;
}

export interface RunningEditorMcpServer {
  url: string;
  close(): Promise<void>;
}

function buildMcpServer(options: EditorMcpServerOptions): McpServer {
  const server = new McpServer({ name: 'forgelens-editor', version: '0.0.1' });

  server.registerTool(
    'read_file',
    {
      description:
        'Read a text file from the workspace. Returns numbered lines; says when the result was truncated.',
      inputSchema: {
        path: z.string().describe('Path relative to the workspace root'),
        start_line: z.number().int().positive().optional().describe('First line, 1-based'),
        end_line: z.number().int().positive().optional().describe('Last line, inclusive'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      const at = new Date().toISOString();
      try {
        const text = await readFileTool(options.port, args);
        options.onToolCall?.({ tool: 'read_file', args, at, ok: true });
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        options.onToolCall?.({ tool: 'read_file', args, at, ok: false });
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );

  options.configure?.(server);
  return server;
}

function tokensMatch(expected: string, received: string | string[] | undefined): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Rejecting other Host values blocks DNS rebinding from a web page in the user's browser.
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(hostHeader);
}

function respondJson(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/** Stateless: each request gets its own server and transport, so nothing depends on MCP session state. */
async function handleRequest(
  options: EditorMcpServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) return respondJson(res, 403, 'forbidden host');
  if (req.url?.split('?')[0] !== '/mcp') return respondJson(res, 404, 'not found');
  if (!tokensMatch(options.token, req.headers[MCP_TOKEN_HEADER])) {
    return respondJson(res, 401, 'invalid token');
  }
  // A stateless server has nothing to push on a standalone GET stream or to end on DELETE. The MCP
  // spec has clients treat 405 as "not offered".
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return respondJson(res, 405, 'method not allowed');
  }

  const server = buildMcpServer(options);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function startEditorMcpServer(
  options: EditorMcpServerOptions,
): Promise<RunningEditorMcpServer> {
  const http: Server = createServer((req, res) => {
    handleRequest(options, req, res).catch((error: unknown) => {
      if (!res.headersSent) respondJson(res, 500, String(error));
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.listenPort ?? 0, '127.0.0.1', () => {
      http.off('error', reject);
      const { port } = http.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () =>
          new Promise((done, fail) => {
            http.close((err) => (err ? fail(err) : done()));
            http.closeAllConnections();
          }),
      });
    });
  });
}
