/** The fields of a streamed tool call we rely on. Fragments may lack any of them while streaming. */
export interface RawToolCallLike {
  id?: string | undefined;
  function?: { name?: string | undefined; arguments?: string | undefined } | undefined;
  toolInfo?:
    | { type?: string | undefined; name?: string | undefined; serverName?: string | undefined }
    | undefined;
}

export interface ResolvedToolCall {
  id: string;
  /** The tool the model really targets, never a meta tool that wraps it. */
  name: string;
  /** MCP server, when known. */
  server: string | undefined;
  args: Record<string, unknown>;
  /** True when the call was routed through the call_tool meta tool. */
  viaCallTool: boolean;
  /** True for harness tools such as list_tools or create_sub_agent. */
  system: boolean;
}

const META_TOOL = 'call_tool';

function parseObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {}; // Arguments stream in as fragments, so partial JSON is normal.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The one place that decides what a tool call means. Models may reach any MCP tool through call_tool,
 * even a preloaded one, so toolInfo.name alone cannot identify a call. The approval gate holds on
 * every route; this keeps the UI and the review from misreading it.
 */
export function resolveToolCall(call: RawToolCallLike): ResolvedToolCall {
  const id = call.id ?? '';
  const infoName = call.toolInfo?.name ?? call.function?.name ?? '';
  const args = parseObject(call.function?.arguments);

  if (infoName === META_TOOL) {
    const target = args['tool_name'];
    const server = args['mcp_server'];
    if (typeof target === 'string' && target.length > 0) {
      const input = args['input'];
      // Some models send the nested input as a JSON string rather than an object.
      const nested = typeof input === 'string' ? parseObject(input) : isRecord(input) ? input : {};
      return {
        id,
        name: target,
        server: typeof server === 'string' ? server : undefined,
        args: nested,
        viaCallTool: true,
        system: false,
      };
    }
    // Still streaming, or malformed: show the meta tool rather than guessing.
    return { id, name: META_TOOL, server: undefined, args, viaCallTool: true, system: true };
  }

  return {
    id,
    name: infoName,
    server: call.toolInfo?.serverName,
    args,
    viaCallTool: false,
    system: call.toolInfo?.type === 'truefoundry-system',
  };
}

const SHORT_ARGS_LIMIT = 90;

/** One-line argument summary for a tool card. */
export function shortArgs(args: Record<string, unknown>): string {
  const text = Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ')
    .replace(/\s+/g, ' ');
  return text.length > SHORT_ARGS_LIMIT ? `${text.slice(0, SHORT_ARGS_LIMIT - 1)}…` : text;
}
