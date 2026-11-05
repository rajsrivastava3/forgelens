import { estimateTokens } from '../tools/output';
import type { ContextIndex } from './engine';
import type { RetrievedItem } from './retrieve';
import { splitIdentifier } from './tokenize';

export const DEFAULT_BUDGET_TOKENS = 6_000;
const MENTION_MAX_TOKENS = 2_000;
/** One file may not take over the pack. */
const MAX_ITEM_SHARE = 0.35;
const MAX_FULL_ITEMS = 5;
const MAX_SKELETON_ITEMS = 8;
const MAX_LISTED_ITEMS = 12;
const MAX_CHUNKS_PER_ITEM = 3;
/** The rest of a file as signatures, short enough to say what is there without costing much. */
const MAX_OUTLINE_LINES = 12;
/** Each tier stops at its share of the budget, so full text cannot crowd out the wider view below it. */
const FULL_TIER_SHARE = 0.6;
const SKELETON_TIER_SHARE = 0.85;
/** Below this, a cut-off chunk says too little to be worth its tokens. */
const MIN_SHORTENED_TOKENS = 200;
/** The table's heading and the "left out" line. */
const PACK_OVERHEAD_TOKENS = 80;
/** A file's heading and code fence, and the marker on shortened text. */
const ITEM_OVERHEAD_TOKENS = 30;

export type PackMode = 'full' | 'skeleton' | 'listed';

export interface PackedItem {
  path: string;
  reason: string;
  mode: PackMode;
  mentioned: boolean;
  tokens: number;
  /** What the agent sees of this file. Empty when only listed. */
  content: string;
}

export interface DroppedItem {
  path: string;
  why: string;
}

export interface PackResult {
  items: PackedItem[];
  dropped: DroppedItem[];
  usedTokens: number;
  budgetTokens: number;
}

export interface PackOptions {
  budgetTokens?: number;
}

function fenceLanguage(path: string): string {
  return /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
}

function numbered(lines: readonly string[], startLine: number, endLine: number): string {
  return lines
    .slice(startLine - 1, endLine)
    .map((line, i) => `${startLine + i}: ${line}`)
    .join('\n');
}

function fullContent(index: ContextIndex, item: RetrievedItem, text: string, maxTokens: number): string | undefined {
  const lines = text.split(/\r?\n/);
  const file = index.files.get(item.path);
  const best = item.chunks
    .slice(0, MAX_CHUNKS_PER_ITEM)
    .map((chunkIndex) => file?.chunks[chunkIndex])
    .filter((chunk) => chunk !== undefined);
  // Where a shown function is used in the same file, such as the place that registers it, is often the other
  // half of a change, so one such chunk comes along: the one naming the most shown functions, then the most of
  // the file's own definitions, as a registration list does. Only names of two or more words are indexed whole,
  // so only those can be looked up.
  const lookupName = (name: string | undefined): string | undefined => {
    const last = name?.split('.').pop();
    return last && splitIdentifier(last).length > 1 ? last.toLowerCase() : undefined;
  };
  const shownNames = best.map((chunk) => lookupName(chunk.name)).filter((name) => name !== undefined);
  const fileNames = [...new Set((file?.symbols ?? []).map((symbol) => lookupName(symbol.name)).filter((name) => name !== undefined))];
  const useSite = (file?.chunks ?? [])
    .filter((chunk) => !best.includes(chunk) && chunk.length < 400)
    .map((chunk) => {
      const own = lookupName(chunk.name);
      const named = (names: string[]): number => names.filter((name) => name !== own && (chunk.terms[name] ?? 0) > 0).length;
      return { chunk, uses: named(shownNames), siblings: named(fileNames) };
    })
    .filter((entry) => entry.uses > 0)
    .sort((a, b) => b.uses - a.uses || b.siblings - a.siblings || a.chunk.length - b.chunk.length)[0]?.chunk;
  const ranges = [...best, ...(useSite ? [useSite] : [])].sort((a, b) => a.startLine - b.startLine);
  const parts: string[] = [];
  let used = 0;
  for (const range of ranges) {
    const part = numbered(lines, range.startLine, range.endLine);
    const cost = estimateTokens(part);
    if (used + cost > maxTokens) continue;
    parts.push(part);
    used += cost;
  }
  if (parts.length > 0) {
    // The rest of the file as signatures, because the best example to follow is often not the best match.
    const shown = (line: number): boolean => ranges.some((range) => line >= range.startLine && line <= range.endLine);
    // When the outline is cut short, keep the definitions named like the shown ones (a shown run_command keeps
    // routes_command): those are the siblings a change usually copies.
    const shownWords = new Set((file?.symbols ?? []).filter((symbol) => shown(symbol.line)).flatMap((symbol) => splitIdentifier(symbol.name)));
    const kinship = (name: string): number => splitIdentifier(name).filter((word) => shownWords.has(word)).length;
    const rest = (file?.symbols ?? []).filter((symbol) => !shown(symbol.line));
    const others = [...rest]
      .sort((a, b) => kinship(b.name) - kinship(a.name) || a.line - b.line)
      .slice(0, MAX_OUTLINE_LINES)
      .sort((a, b) => a.line - b.line)
      .map((symbol) => `${symbol.line}: ${symbol.signature}`)
      .concat(rest.length > MAX_OUTLINE_LINES ? [`[${rest.length - MAX_OUTLINE_LINES} more definitions]`] : [])
      .join('\n');
    const outline = others ? `\n[other definitions in this file]\n${others}` : '';
    return parts.join('\n[...]\n') + (used + estimateTokens(outline) <= maxTokens ? outline : '');
  }
  // Its best chunk alone is over the limit, as a very long function can be: the start of it still helps.
  const first = ranges[0];
  if (!first || maxTokens < MIN_SHORTENED_TOKENS) return undefined;
  return `${numbered(lines, first.startLine, first.endLine).slice(0, (maxTokens - 12) * 4)}\n[shortened: read_file has the rest]`;
}

function skeletonContent(index: ContextIndex, path: string): string {
  const symbols = index.files.get(path)?.symbols ?? [];
  return symbols.map((symbol) => `${symbol.line}: ${symbol.signature}${symbol.doc ? `  # ${symbol.doc}` : ''}`).join('\n');
}

function rowCost(item: Pick<PackedItem, 'path' | 'reason'>): number {
  return estimateTokens(`| ${item.path} | ${item.reason} | 00000 | skeleton |\n`);
}

/**
 * The other half of budgeted multi-signal retrieval. Greedy by score: the top files get their best chunks in full,
 * the next get signatures only, the rest just a path and a reason. What was left out is recorded and shown.
 * Mentions always go in, cut to a hard cap, so asking for a file by name is never undone by the budget.
 */
export async function buildPack(
  index: ContextIndex,
  ranked: readonly RetrievedItem[],
  read: (path: string) => Promise<string>,
  options: PackOptions = {},
): Promise<PackResult> {
  const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const items: PackedItem[] = [];
  const dropped: DroppedItem[] = [];
  let used = PACK_OVERHEAD_TOKENS;
  let fullCount = 0;
  let skeletonCount = 0;
  let listedCount = 0;

  const add = (item: RetrievedItem, mode: PackMode, content: string): void => {
    const tokens = estimateTokens(content) + rowCost(item) + (content ? ITEM_OVERHEAD_TOKENS : 0);
    items.push({ path: item.path, reason: item.reason, mode, mentioned: item.mentioned, tokens, content });
    used += tokens;
  };

  for (const item of ranked.filter((candidate) => candidate.mentioned)) {
    try {
      const text = await read(item.path);
      const cap = MENTION_MAX_TOKENS * 4;
      const lines = text.split(/\r?\n/);
      const whole = numbered(lines, 1, lines.length);
      add(item, 'full', whole.length > cap ? `${whole.slice(0, cap)}\n[shortened: read_file has the rest]` : whole);
    } catch {
      dropped.push({ path: item.path, why: 'mentioned, but the file could not be read' });
    }
  }

  const maxItemTokens = Math.floor(budgetTokens * MAX_ITEM_SHARE);
  const fullLimit = Math.floor(budgetTokens * FULL_TIER_SHARE);
  const skeletonLimit = Math.floor(budgetTokens * SKELETON_TIER_SHARE);
  for (const item of ranked.filter((candidate) => !candidate.mentioned)) {
    const left = budgetTokens - used;
    const row = rowCost(item);
    const fullRoom = fullLimit - used - row - ITEM_OVERHEAD_TOKENS;
    if (fullCount < MAX_FULL_ITEMS && fullRoom > 0) {
      let text: string;
      try {
        text = await read(item.path);
      } catch {
        dropped.push({ path: item.path, why: 'the file could not be read' });
        continue;
      }
      const content = fullContent(index, item, text, Math.min(maxItemTokens - row - ITEM_OVERHEAD_TOKENS, fullRoom));
      if (content) {
        add(item, 'full', content);
        fullCount += 1;
        continue;
      }
    }
    if (skeletonCount < MAX_SKELETON_ITEMS) {
      const skeleton = skeletonContent(index, item.path);
      if (skeleton && estimateTokens(skeleton) + row + ITEM_OVERHEAD_TOKENS <= Math.min(maxItemTokens, skeletonLimit - used)) {
        add(item, 'skeleton', skeleton);
        skeletonCount += 1;
        continue;
      }
    }
    if (listedCount < MAX_LISTED_ITEMS && row <= left) {
      add(item, 'listed', '');
      listedCount += 1;
      continue;
    }
    dropped.push({ path: item.path, why: 'over budget' });
  }
  return { items, dropped, usedTokens: used, budgetTokens };
}

function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** The pack as the agent reads it: a table of what was chosen and why, then the text itself. */
export function formatPack(pack: PackResult): string {
  const rows = pack.items.map((item) => `| ${tableCell(item.path)} | ${tableCell(item.reason)} | ${item.tokens} | ${item.mode} |`);
  const parts = [
    `## Context Pack: ${pack.items.length} files, ${pack.usedTokens} of ${pack.budgetTokens} tokens`,
    'ForgeLens chose these files for this request. They may not be everything the task touches.',
    ['| File | Why | Tokens | Shown as |', '| --- | --- | --- | --- |', ...rows].join('\n'),
  ];
  for (const item of pack.items) {
    if (item.mode === 'listed') continue;
    const label = item.mode === 'skeleton' ? 'signatures only' : 'numbered lines';
    parts.push(`### ${item.path} (${label})\n\`\`\`${fenceLanguage(item.path)}\n${item.content}\n\`\`\``);
  }
  if (pack.dropped.length > 0) {
    parts.push(`Left out: ${pack.dropped.map((item) => `${item.path} (${item.why})`).join(', ')}.`);
  }
  return parts.join('\n\n');
}
