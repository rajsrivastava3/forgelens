import type { EditorPort } from './editorPort';
import { capText, estimateTokens, forEachTextFile } from './output';

const DEFAULT_BUDGET_TOKENS = 4_000;
const MAX_BUDGET_TOKENS = 12_000;
const MAX_ITEMS = 8;
const MAX_SNIPPETS_PER_FILE = 4;

const STOP_WORDS = new Set(
  'a an and are as at be but by can do does for from has have how i if in into is it its of on or that the their them then there these this to was were what when where which while who why will with would you your'.split(
    ' ',
  ),
);

function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  return [...new Set(words.filter((word) => word.length > 1 && !STOP_WORDS.has(word)))];
}

interface FileHit {
  path: string;
  score: number;
  termCounts: Map<string, number>;
  snippets: string[];
}

function scoreFile(path: string, text: string, terms: readonly string[]): FileHit | undefined {
  const lowerPath = path.toLowerCase();
  const termCounts = new Map<string, number>();
  const snippets: string[] = [];
  let score = 0;

  text.split(/\r?\n/).forEach((line, i) => {
    const lower = line.toLowerCase();
    const hits = terms.filter((term) => lower.includes(term));
    for (const term of hits) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    // Prefer lines that match several terms: they say more about the file than repetition does.
    if (hits.length >= 2 && snippets.length < MAX_SNIPPETS_PER_FILE) {
      snippets.push(`${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  });
  for (const count of termCounts.values()) score += 1 + Math.log(count);
  for (const term of terms) if (lowerPath.includes(term)) score += 3;

  return score > 0 ? { path, score, termCounts, snippets } : undefined;
}

function reasonFor(hit: FileHit, terms: readonly string[]): string {
  const counts = [...hit.termCounts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([term, count]) => `${term} x${count}`)
    .join(', ');
  const inPath = terms.filter((term) => hit.path.toLowerCase().includes(term));
  return `${inPath.length > 0 ? `path mentions ${inPath.join(', ')}; ` : ''}content mentions ${counts || 'none'}`;
}

/** Placeholder keyword ranking: the shape of the real context engine, not its quality. */
export async function retrieveContextTool(
  port: EditorPort,
  args: { query: string; budget_tokens?: number | undefined },
): Promise<string> {
  const budget = Math.min(args.budget_tokens ?? DEFAULT_BUDGET_TOKENS, MAX_BUDGET_TOKENS);
  const terms = queryTerms(args.query);
  if (terms.length === 0) return 'The query has no searchable terms. Use identifiers or specific words.';

  const hits: FileHit[] = [];
  await forEachTextFile(port, await port.listFiles(), ({ path, text }) => {
    const hit = scoreFile(path, text, terms);
    if (hit) hits.push(hit);
  });
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  let used = 0;
  let dropped = 0;
  const items: string[] = [];
  for (const hit of hits.slice(0, MAX_ITEMS)) {
    const snippetBlock = hit.snippets.map((snippet) => `    ${snippet}`).join('\n');
    const item = `- ${hit.path}\n  why: ${reasonFor(hit, terms)}${snippetBlock ? `\n${snippetBlock}` : ''}`;
    const cost = estimateTokens(item);
    if (used + cost > budget) {
      dropped += 1;
      continue;
    }
    items.push(item);
    used += cost;
  }
  if (items.length === 0) return `No files match: ${terms.join(', ')}.`;

  const remaining = hits.length - Math.min(hits.length, MAX_ITEMS) + dropped;
  const footer = remaining > 0 ? `\n${remaining} more matching file(s) left out: over budget or item limit.` : '';
  return capText(
    `Context pack (keyword search): ${items.length} files, ~${used} of ${budget} tokens.\n${items.join('\n')}${footer}`,
    'Lower budget_tokens or refine the query.',
  );
}
