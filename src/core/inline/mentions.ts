import type { EditorPort } from '../tools/editorPort';
import { forEachTextFile } from '../tools/output';
import { extractSymbols, findSymbolTool } from '../tools/symbols';

export const MENTION_MAX_CHARS = 8_000;
const MAX_CANDIDATES = 4_000;

export interface Mention {
  kind: 'file' | 'symbol';
  name: string;
}

export interface ResolvedMention extends Mention {
  label: string;
  found: boolean;
  text: string;
}

export interface MentionCandidate {
  kind: 'file' | 'symbol';
  name: string;
  /** Where it is, for the picker's second column. */
  detail: string;
}

/** Finds @file:path and @symbol:name. The prefix is required, so an email address is never a mention. */
export function parseMentions(text: string): Mention[] {
  const found = new Map<string, Mention>();
  for (const match of text.matchAll(/(?:^|\s)@(file|symbol):([^\s,;]+)/g)) {
    const kind = match[1] as Mention['kind'];
    const name = (match[2] ?? '').replace(/[.)]+$/, '');
    if (name) found.set(`${kind}:${name}`, { kind, name });
  }
  return [...found.values()];
}

/** Mentions are always included, capped so one large file cannot crowd out the rest. */
export async function resolveMentions(port: EditorPort, mentions: readonly Mention[]): Promise<ResolvedMention[]> {
  return Promise.all(
    mentions.map(async (mention): Promise<ResolvedMention> => {
      const label = mention.kind === 'file' ? `file ${mention.name}` : `symbol ${mention.name}`;
      try {
        const raw = mention.kind === 'file' ? await port.readTextFile(mention.name) : await findSymbolTool(port, { name: mention.name });
        const text = raw.length > MENTION_MAX_CHARS ? `${raw.slice(0, MENTION_MAX_CHARS)}\n[shortened: read_file has the rest]` : raw;
        return { ...mention, label, found: true, text };
      } catch {
        return { ...mention, label, found: false, text: `Not found in the workspace: ${mention.name}` };
      }
    }),
  );
}

/** Everything the @ picker offers: each file, and each top-level symbol of the source files. */
export async function mentionCandidates(port: EditorPort): Promise<MentionCandidate[]> {
  const files = await port.listFiles();
  const candidates: MentionCandidate[] = files.map((file) => ({ kind: 'file', name: file, detail: '' }));
  const sources = files.filter((file) => /\.(py|ts|tsx|js|jsx)$/.test(file));
  await forEachTextFile(port, sources, ({ path, text }) => {
    for (const symbol of extractSymbols(path, text)) {
      if (symbol.kind === 'class' || symbol.kind === 'function') {
        candidates.push({ kind: 'symbol', name: symbol.name, detail: `${path}:${symbol.line}` });
      }
    }
  });
  return candidates.slice(0, MAX_CANDIDATES);
}
