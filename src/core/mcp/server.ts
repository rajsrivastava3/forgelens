import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { StagedEditorPort } from '../changeset/changeset';
import { APPLY_TOOL, ReviewFlow } from '../changeset/reviewFlow';
import { ContextEngine } from '../context/engine';
import { ShadowWorkspace } from '../shadow/shadowWorkspace';
import type { WritablePort } from '../tools/editorPort';
import { readFileTool } from '../tools/readFile';
import { retrieveContextTool } from '../tools/retrieveContext';
import { searchCodeTool } from '../tools/searchCode';
import { findReferencesTool, findSymbolTool } from '../tools/symbols';
import { CommandRunner, runCommandTool, RUN_COMMAND_TOOL } from '../tools/runCommand';
import { getStagedChangesTool, stageCreateFileTool, stageDeleteFileTool,
  stageReplaceLinesTool,
  unstageFileTool, stageEditTool } from '../tools/stageTools';
import { getDiagnosticsTool, listDirTool, repoMapTool } from '../tools/workspaceViews';

export const MCP_TOKEN_HEADER = 'x-forgelens-token';
export const MCP_SERVER_NAME = 'forgelens-editor';
export const MCP_SERVER_DESCRIPTION =
  'ForgeLens editor tools for the open VS Code workspace: read, search and navigate code, stage edits, and apply what the user approves.';

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  at: string;
  ok: boolean;
}

export interface EditorMcpServerOptions {
  port: WritablePort;
  /** Holds staged edits and reviews. Created here when not given, for headless use. */
  flow?: ReviewFlow;
  /** The context index. Created here when not given, for headless use, and kept only in memory. */
  context?: ContextEngine;
  /** Where staged runs copy the workspace. Defaults to the system temp folder. */
  shadowRoot?: string;
  /** Runs commands. Passed in so Stop can end them. */
  runner?: CommandRunner;
  token: string;
  /** TCP port on 127.0.0.1. 0 picks a free port. */
  listenPort?: number;
  onToolCall?: (record: ToolCallRecord) => void;
  /** Registers additional tools on each per-request server instance. */
  configure?: (server: McpServer) => void;
}

export interface RunningEditorMcpServer {
  url: string;
  /** A new turn starts: the count of reads since the last staged edit starts again. */
  newTask(readLimit?: number): void;
  /** A change is planned: start copying the workspace for the staged test run now, in the background. */
  prepareShadow(): void;
  close(): Promise<void>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;
/** Staging changes nothing on disk, but it is not read-only: it changes what apply_changes will propose. */
const STAGING = { readOnlyHint: false, destructiveHint: false } as const;

/** Reads and searches. Past READ_LIMIT of them in a turn with nothing staged, they refuse until something is. */
const CAPPED_TOOLS = new Set(['read_file', 'search_code', 'find_symbol', 'find_references', 'retrieve_context', 'repo_map']);
export const READ_LIMIT = 8;
export const READ_LIMIT_MESSAGE = 'Read limit reached. Stage your edits with stage_edit now; reads unlock after the next stage_edit.';
/** The plan turn's limit is smaller, and nothing is staged in it, so it says what to do instead. */
export const PLAN_LIMIT_MESSAGE = 'Read limit for this turn reached. Write your plan, or your answer, from what you have.';

interface ServerParts {
  /** Reads and searches since the last staged edit or the start of the turn. Kept per server, not per request. */
  gather: { count: number; limit: number };
  flow: ReviewFlow;
  context: ContextEngine;
  shadow: ShadowWorkspace;
  runner: CommandRunner;
}

function buildMcpServer(options: EditorMcpServerOptions, parts: ServerParts): McpServer {
  const { flow, context, shadow, runner } = parts;
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.0.1' });
  // Every read tool sees staged content, so the agent always reads its own edits back.
  const port = new StagedEditorPort(options.port, flow.changeset);
  const { changeset } = flow;
  const root = (): string => options.port.workspaceRoot;

  const run = async (tool: string, args: unknown, execute: () => Promise<string>) => {
    const at = new Date().toISOString();
    // Trying to stage, even with an edit that does not match, means the gathering is over.
    if (tool.startsWith('stage_')) parts.gather.count = 0;
    if (CAPPED_TOOLS.has(tool)) {
      parts.gather.count += 1;
      if (parts.gather.count > parts.gather.limit) {
        options.onToolCall?.({ tool, args, at, ok: false });
        const text = parts.gather.limit < READ_LIMIT ? PLAN_LIMIT_MESSAGE : READ_LIMIT_MESSAGE;
        // Not an error: the model did nothing wrong, it is being told what to do next, so the card stays plain.
        return { content: [{ type: 'text' as const, text }] };
      }
    }
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
        'Find the files most relevant to a question or task, using a code index: word matches, symbol names, imports, and test and doc pairings. Returns ranked files with the reason each was chosen, the best code in full, then signatures, then paths, within a token budget.',
      inputSchema: {
        query: z.string().describe('The task or question, in plain words and identifiers'),
        budget_tokens: z.number().int().positive().optional().describe('Token budget for the result'),
      },
      annotations: READ_ONLY,
    },
    (args) => run('retrieve_context', args, () => retrieveContextTool(context, args)),
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
    (args) => run('repo_map', args, async () => repoMapTool(port, args, await context.outlines())),
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
      description: 'Read lines of a text file in the workspace, including any edits you have staged. Pass start_line and end_line; at most 150 lines come back per call. Returns numbered lines and says when more remain.',
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
    () => run('get_staged_changes', {}, () => getStagedChangesTool(changeset)),
  );

  server.registerTool(
    'stage_edit',
    {
      description:
        'Propose search/replace edits to one file. Writes nothing to disk. Each old_text must match one place: exact text first, then ignoring whitespace differences. Edits that match are staged; an edit whose old_text is not found is reported with the nearest places, and one whose old_text equals new_text is skipped. It is an error only when nothing could be staged. Returns the resulting diff.',
      inputSchema: {
        path: z.string().describe('Path relative to the workspace root'),
        edits: z
          .array(z.object({ old_text: z.string().describe('Text to replace, with enough lines to be unique'), new_text: z.string().describe('Replacement text') }))
          .min(1),
      },
      annotations: STAGING,
    },
    (args) => run('stage_edit', args, () => stageEditTool(changeset, root(), args)),
  );

  server.registerTool(
    'stage_create_file',
    {
      description: 'Propose a new file. Writes nothing to disk.',
      inputSchema: {
        path: z.string().describe('Path relative to the workspace root'),
        content: z.string().describe('The whole file'),
      },
      annotations: STAGING,
    },
    (args) => run('stage_create_file', args, () => stageCreateFileTool(changeset, root(), args)),
  );

  server.registerTool(
    'stage_delete_file',
    {
      description: 'Propose deleting a file. Writes nothing to disk.',
      inputSchema: { path: z.string().describe('Path relative to the workspace root') },
      annotations: STAGING,
    },
    (args) => run('stage_delete_file', args, () => stageDeleteFileTool(changeset, root(), args)),
  );

  server.registerTool(
    'stage_replace_lines',
    {
      description:
        'Propose replacing lines start_line to end_line (1-based, inclusive, the numbers read_file shows, staged text included) with new_text. Set end_line to start_line minus one to insert before start_line; set new_text to "" to delete the lines. No text matching, so use it when stage_edit could not find your old_text. Writes nothing to disk. Returns the resulting diff.',
      inputSchema: {
        path: z.string().describe('Path relative to the workspace root'),
        start_line: z.number().int().positive().describe('First line to replace, 1-based'),
        end_line: z.number().int().describe('Last line to replace, inclusive; start_line - 1 inserts before start_line'),
        new_text: z.string().describe('The new lines; "" deletes the range'),
        expect_first_line: z.string().optional().describe('What you expect on start_line; the edit is refused with the real line if it differs'),
      },
      annotations: STAGING,
    },
    (args) => run('stage_replace_lines', args, () => stageReplaceLinesTool(changeset, root(), args)),
  );

  server.registerTool(
    'unstage_file',
    {
      description: 'Drop what you staged for one file, so reads show the file on disk again and you can stage it afresh. Writes nothing to disk. Use it when your staged edits to a file went wrong.',
      inputSchema: { path: z.string().describe('Path relative to the workspace root') },
      annotations: STAGING,
    },
    (args) => run('unstage_file', args, () => Promise.resolve(unstageFileTool(changeset, root(), args))),
  );

  server.registerTool(
    APPLY_TOOL,
    {
      description:
        'Ask the user to review everything staged, hunk by hunk. This is the only way anything reaches disk. Call it once, after all edits are staged. The result lists exactly which hunks landed and which the user rejected.',
      inputSchema: { summary: z.string().describe('One sentence on what this change does, for the user') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (args) => run(APPLY_TOOL, args, () => flow.applyApproved(args.summary)),
  );

  server.registerTool(
    RUN_COMMAND_TOOL,
    {
      description:
        'Run a shell command. target "staged" (the default) runs in a private copy of the workspace with your staged edits applied, so you can run the tests before the user reviews anything. target "workspace" runs in the real folder. Output is capped to its last part. Returns the exit code and output.',
      inputSchema: {
        command: z.string().describe('The command, for example python -m pytest tests/test_cli.py -q'),
        cwd: z.string().optional().describe('Folder relative to the workspace root'),
        target: z.enum(['staged', 'workspace']).optional().describe('Where to run. Defaults to staged'),
        timeout_s: z.number().int().positive().optional().describe('Time limit in seconds, at most 600. Defaults to 120'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (args) => run(RUN_COMMAND_TOOL, args, () => runCommandTool({ workspaceRoot: root, shadow, runner }, args)),
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
  parts: ServerParts,
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

  const server = buildMcpServer(options, parts);
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
  // One per server, not per request: staged edits must outlive the request that made them.
  const flow = options.flow ?? new ReviewFlow(options.port);
  const parts: ServerParts = {
    gather: { count: 0, limit: READ_LIMIT },
    flow,
    context: options.context ?? new ContextEngine(options.port),
    runner: options.runner ?? new CommandRunner(),
    shadow: new ShadowWorkspace(
      () => options.port.workspaceRoot,
      options.shadowRoot ?? path.join(tmpdir(), `forgelens-shadow-${randomBytes(6).toString('hex')}`),
      () => options.port.listFiles(),
      flow.changeset,
    ),
  };
  const http: Server = createServer((req, res) => {
    handleRequest(options, parts, req, res).catch((error: unknown) => {
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
        newTask: (readLimit = READ_LIMIT) => {
          parts.gather.count = 0;
          parts.gather.limit = readLimit;
        },
        prepareShadow: () => parts.shadow.prepare(),
        close: () =>
          new Promise((done, fail) => {
            http.close((err) => (err ? fail(err) : done()));
            http.closeAllConnections();
          }),
      });
    });
  });
}
