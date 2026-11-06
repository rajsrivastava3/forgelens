/**
 * Prices every session TrueForge has kept, request by request, from the usage and model each model.message
 * recorded, with the same prices the rehearsals use. Usage: npx tsx scripts/spend-report.ts [--since 2026-11-05]
 */
import { arg, BASE_URL, estimateCostUsd, INR_PER_USD } from './rehearse/harness';

interface Page<T> {
  data: T[];
  pagination?: { next_page_token?: string | null };
}
interface StoredEvent {
  event: { type: string; created_at?: string; model?: { name?: string }; usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number } };
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

async function main(): Promise<void> {
  const since = arg('--since') ?? '2026-11-01';
  const sessions = await all<{ id: string; created_at: string }>(`${BASE_URL}/api/v1/sessions`, 25);
  const rows: { id: string; day: string; models: Set<string>; input: number; cached: number; output: number; usd: number; requests: number }[] = [];
  for (const session of sessions.filter((item) => item.created_at >= since)) {
    const row = { id: session.id, day: session.created_at.slice(0, 10), models: new Set<string>(), input: 0, cached: 0, output: 0, usd: 0, requests: 0 };
    for (const { event } of await all<StoredEvent>(`${BASE_URL}/api/v1/sessions/${session.id}/events`, 100)) {
      if (event.type !== 'model.message' || !event.usage) continue;
      const model = event.model?.name ?? 'unknown';
      const use = { input: event.usage.input_tokens ?? 0, cached: event.usage.cache_read_tokens ?? 0, output: event.usage.output_tokens ?? 0 };
      const usd = estimateCostUsd(model, use);
      row.models.add(model);
      row.input += use.input;
      row.cached += use.cached;
      row.output += use.output;
      row.usd += usd;
      row.requests += 1;
    }
    if (row.usd > 0) rows.push(row);
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const byDay = new Map<string, number>();
  for (const row of rows) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.usd);
    console.log(
      `${row.id} ${row.day} ${[...row.models].join('+')} req ${row.requests} in ${row.input} (cached ${row.cached}) out ${row.output} Rs ${(row.usd * INR_PER_USD).toFixed(2)}`,
    );
  }
  for (const [day, usd] of byDay) console.log(`Day ${day} (UTC): Rs ${(usd * INR_PER_USD).toFixed(2)}`);
  const total = rows.reduce((sum, row) => sum + row.usd, 0);
  console.log(`Total of ${rows.length} priced sessions: $${total.toFixed(4)}, Rs ${(total * INR_PER_USD).toFixed(2)}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
