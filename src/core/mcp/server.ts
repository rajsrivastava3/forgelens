import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { EditorPort } from '../tools/editorPort';
import { readFileTool } from '../tools/readFile';
import { retrieveContextTool } from '../tools/retrieveContext';
import { searchCodeTool } from '../tools/searchCode';
import { findReferencesTool, findSymbolTool } from '../tools/symbols';
import { getDiagnosticsTool, getStagedChangesTool, listDirTool, repoMapTool } from '../tools/workspaceViews';

export const MCP_TOKEN_HEADER = 'x-forgelens-token';
export const MCP_SERVER_NAME = 'forgelens-editor';
export const MCP_SERVER_DESCRIPTION =
  'ForgeLens editor tools for the open VS Code workspace: read, search and navigate code.';

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

const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;

function buildMcpServer(options: EditorMcpServerOptions): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.0.1' });
  const { port } = options;

  const run = async (tool: string, args: unknown, execute: () => Promise<string>) => {
    const at = new Date().toISOString();
    try {
      const text = await execute();
      options.onToolCall?.({ tool, args, at, ok: true });
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      options.onToolCall?.({ tool, args, at, ok: false });
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
    }
  };

  server.registerTool(
    'retrieve_context',
    {
      description:
        'Find the files most relevant to a question or task. Returns ranked files, each with the reason it was chosen, within a token budget. Start here when you do not know where the code is.',
      inputSchema: {
        query: z.string().describe('The task or question, in plain words and identifiers'),
        budget_tokens: z.number().int().positive().optional().describe('Token budget for the result'),
      },
      annotations: READ_ONLY,
    },
    (args) => run('retrieve_context', args, () => retrieveContextTool(port, args)),
  );

  server.registerTool(
    'repo_map',
    {
      description: 'Outline the repository: file paths plus top-level signatures, within a token budget.',
      inputSchema: {
        path_prefix: z.string().optional().describe('Only include paths starting with this'),
        budget_tokens: z.number().int().positive().optional().describe('Token budget for the result'),
      },
      annotations: READ_ONLY,
    },
    (args) => run('repo_map', args, () => repoMapTool(port, args)),
  );

  server.registerTool(
    'search_code',
    {
      description: 'Search workspace files for text or a regular expression. Returns path:line matches.',
      inputSchema: {
        query: z.string().describe('Text to find. All-lowercase matches any case'),
        regex: z.boolean().optional().describe('Treat query as a regular expression'),
        path_glob: z.string().optional().describe('Limit to matching paths, for example tests/**/*.py'),
        max_results: z.number().int().positive().optional().describe('Result limit, at most 200'),
      },
      annotations: READ_ONLY,
    },
    (args) => run('search_code', args, () => searchCodeTool(port, args)),
  );

  server.registerTool(
    'find_symbol',
    {
      description: 'Find where a function, class, method or constant is defined. Returns file:line and signature.',
      inputSchema: {
        name: z.string().describe('The symbol name'),
        kind: z.enum(['function', 'class', 'method', 'variable']).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => run('find_symbol', args, () => findSymbolTool(port, args)),
  );

  server.registerTool(
    'find_references',
    {
      description: 'Find every whole-word use of an identifier in the workspace.',
      inputSchema: {
        name: z.string().describe('The identifier'),
        max_results: z.number().int().positive().optional().describe('Result limit, at most 200'),
      },
      annotations: READ_ONLY,
    },
    (args) => run('find_references', args, () => findReferencesTool(port, args)),
  );

  server.registerTool(
    'read_file',
    {
      description: 'Read a text file from the workspace. Returns numbered lines; says when the result was truncated.',
      inputSchema: {
        path: z.string().describe('Path relative to the workspace root'),
        start_line: z.number().int().positive().optional().describe('First line, 1-based'),
        end_line: z.number().int().positive().optional().describe('Last line, inclusive'),
      },
      annotations: READ_ONLY,
    },
    (args) => run('read_file', args, () => readFileTool(port, args)),
  );

  server.registerTool(
    'list_dir',
    {
      description: 'List files and subdirectories, leaving out ignored files.',
      inputSchema: {
        path: z.string().optional().describe('Directory relative to the workspace root. Defaults to the root'),
        depth: z.number().int().positive().optional().describe('Levels to expand. Defaults to 1'),
      },
      annotations: READ_ONLY,
    },
    (args) => run('list_dir', args, () => listDirTool(port, args)),
  );

  server.registerTool(
    'get_diagnostics',
    {
      description: 'Get errors and warnings the editor currently reports, for one file or the workspace.',
      inputSchema: { path: z.string().optional().describe('Path relative to the workspace root') },
      annotations: READ_ONLY,
    },
    (args) => run('get_diagnostics', args, () => getDiagnosticsTool(port, args)),
  );

  server.registerTool(
    'get_staged_changes',
    {
      description: 'Summarise edits staged for review but not yet written to disk.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => run('get_staged_changes', {}, () => getStagedChangesTool()),
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
