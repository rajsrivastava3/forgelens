/**
 * Lists what went wrong in the TrueForge sessions since a time: every tool call that returned an error, every
 * turn that ended in error or was cancelled, grouped by cause with counts and the exact text.
 * Usage: npx tsx scripts/session-audit.ts [--since 2026-11-11T21:30:00Z] [--limit 40]
 */
import { arg, BASE_URL } from './rehearse/harness';

interface Page<T> {
  data: T[];
  pagination?: { next_page_token?: string | null };
}
interface Session {
  id: string;
  created_at: string;
  agent?: { name?: string; spec?: { model?: { name?: string } } };
}
interface ToolCall {
  id: string;
  function?: { name?: string; arguments?: string };
  tool_info?: { name?: string };
}
interface StoredEvent {
  turn_id: string;
  event: {
    type: string;
    id?: string;
    thread_id?: string | null;
    created_at?: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    model?: { name?: string };
    state?: { status?: string; message?: string; cancelled_reason?: string; reason?: string };
  };
}

async function all<T>(url: string, limit: number): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  for (;;) {
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}limit=${limit}${token ? `&page_token=${encodeURIComponent(token)}` : ''}`);
    const page = (await response.json()) as Page<T> & { error?: { message?: string } };
    if (!Array.isArray(page.data)) throw new Error(`${url}: ${page.error?.message ?? response.status}`);
    items.push(...page.data);
    token = page.pagination?.next_page_token ?? undefined;
    if (!token || page.data.length === 0) return items;
  }
}

function callTarget(call: ToolCall): string {
  const name = call.tool_info?.name ?? call.function?.name ?? '?';
  if (name !== 'call_tool') return name;
  try {
    return `call_tool(${String((JSON.parse(call.function?.arguments ?? '{}') as { tool_name?: string }).tool_name)})`;
  } catch {
    return 'call_tool(?)';
  }
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
  return content === null || content === undefined ? '' : JSON.stringify(content);
}

/** The first line, with ids, paths and counts generalised so the same cause groups together. */
function cause(message: string): string {
  return message
    .split('\n')[0]!
    .replace(/Edit \d+ of \d+ in \S+/, 'Edit N of M in <file>')
    .replace(/matches \d+ places \(lines [^)]*\)/, 'matches N places')
    .replace(/at line \d+/g, 'at line N')
    .replace(/request_id[^,}]*/g, '')
    .slice(0, 220);
}

async function main(): Promise<void> {
  const since = arg('--since') ?? '2026-11-11T21:30:00Z';
  const limit = Number(arg('--limit') ?? 60);
  const sessions = (await all<Session>(`${BASE_URL}/api/v1/sessions`, 25)).filter((session) => session.created_at >= since).slice(0, limit).reverse();
  const groups = new Map<string, { count: number; where: string[]; sample: string }>();
  const note = (key: string, where: string, sample: string): void => {
    const entry = groups.get(key) ?? { count: 0, where: [], sample };
    entry.count += 1;
    entry.where.push(where);
    groups.set(key, entry);
  };
  console.log(`${sessions.length} sessions since ${since}\n`);
  for (const session of sessions) {
    const model = session.agent?.spec?.model?.name ?? session.agent?.name ?? '?';
    const events = (await all<StoredEvent>(`${BASE_URL}/api/v1/sessions/${session.id}/events`, 100)).reverse();
    const calls = new Map<string, string>();
    const turns = new Map<string, string>();
    const lines: string[] = [];
    for (const { turn_id, event } of events) {
      if (event.type === 'model.message') for (const call of event.tool_calls ?? []) calls.set(call.id, callTarget(call));
      if (event.type === 'tool.response') {
        const body = text(event.content);
        if (/^(Error:|\{"error")/.test(body.trimStart()) || /^MCP error/.test(body)) {
          const tool = calls.get(event.tool_call_id ?? '') ?? '?';
          lines.push(`  tool error ${tool}: ${body.split('\n')[0]!.slice(0, 200)}`);
          note(`tool error ${tool}: ${cause(body)}`, session.id, body.slice(0, 600));
        }
      }
      if (event.type === 'turn.done') {
        const status = event.state?.status ?? '?';
        turns.set(turn_id, status);
        if (status === 'error') {
          const message = event.state?.message ?? '';
          lines.push(`  turn error: ${message.split('\n')[0]!.slice(0, 200)}`);
          note(`turn error: ${cause(message)}`, session.id, message.slice(0, 600));
        }
        if (status === 'cancelled') {
          const reason = event.state?.cancelled_reason ?? event.state?.reason ?? '';
          lines.push(`  turn cancelled: ${reason}`);
          note(`turn cancelled (${reason})`, session.id, reason);
        }
      }
    }
    const statuses = [...turns.values()];
    console.log(`${session.created_at} ${session.id} ${model}: ${statuses.length} turns (${statuses.join(', ') || 'none'})`);
    for (const line of lines) console.log(line);
  }
  console.log('\nBy cause:');
  for (const [key, entry] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`\n${entry.count}x ${key}`);
    console.log(`  sessions: ${[...new Set(entry.where)].join(', ')}`);
    console.log(`  exact text: ${entry.sample.replace(/\n/g, '\n    ')}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
