import type { ContextIndex } from './engine';
import { isChangelog, isDataFile, isDocFile, isTestFile, moduleStem, pairedFiles } from './relations';
import { tokenize, uniqueTokens } from './tokenize';

export interface RetrieveOptions {
  /** Files named by @file or @symbol. Always included. */
  mentionedFiles?: readonly string[];
  activeFile?: string | undefined;
  openFiles?: readonly string[];
  /** Selected text, which says what the question is about. */
  selection?: string | undefined;
  limit?: number;
}

export interface RetrievedItem {
  path: string;
  score: number;
  /** One plain sentence on why this file was chosen. */
  reason: string;
  mentioned: boolean;
  /** Indexes into the file's chunks, best first. */
  chunks: number[];
}

const DEFAULT_LIMIT = 24;
const SEEDS = 5;
const IMPORT_SEEDS = 3;
/** A word that names a file (cli in cli.py) says more than any number of mentions inside other files. */
const NAME_MATCH_BOOST = 1.6;
const SYMBOL_MATCH_BOOST = 1.2;
const CHANGE_WORDS = /\b(add|adds|adding|new|fix|fixes|change|changes|remove|removes|rename|renames|deprecate|support|implement)\b/i;
const DATA_FILE_WEIGHT = 0.35;
const MAX_NAMES = 3;
const MAX_MATCHES = 3;

interface Candidate {
  path: string;
  score: number;
  chunks: number[];
  matched: Set<string>;
  names: string[];
  relations: string[];
  mentioned: boolean;
}

/**
 * The best chunk counts most, and a few more show the file is about this rather than one lucky match. Coverage
 * then rewards a file for matching many different words of the request, so one common word cannot carry a file
 * past the one where the work really is.
 */
function fileScore(chunks: readonly { score: number; matched: Set<string> }[], termCount: number): number {
  const base = (chunks[0]?.score ?? 0) + 0.35 * (chunks[1]?.score ?? 0) + 0.15 * (chunks[2]?.score ?? 0);
  const covered = new Set(chunks.flatMap((chunk) => [...chunk.matched])).size;
  return base * (1 + (3 * covered) / Math.max(1, termCount));
}

/** One plain phrase per signal, in the order a person would care about. */
function describe(candidate: Candidate, rarity: (word: string) => number): string {
  const parts: string[] = [];
  if (candidate.mentioned) parts.push('mentioned by you');
  const isTest = isTestFile(candidate.path);
  const isCode = !isTest && !isDocFile(candidate.path);
  // What a code file defines says more than which doc pointed at it. A test's own name adds nothing to its pairing.
  const defined = isCode ? [...new Set(candidate.names.map((name) => name.split('.')[0] ?? name))].slice(0, MAX_NAMES) : [];
  if (defined.length > 0) parts.push(`defines ${defined.join(', ')}`);
  const relations = defined.length > 0 ? candidate.relations.filter((relation) => !relation.startsWith('code for ')) : candidate.relations;
  parts.push(...relations.slice(0, 2));
  // The rarest words explain the choice best. A joined form such as built-in only repeats its parts.
  const matched = [...candidate.matched]
    .filter((word) => !/[-_]/.test(word))
    .sort((a, b) => rarity(a) - rarity(b))
    .slice(0, MAX_MATCHES);
  if (matched.length > 0) parts.push(`matches ${matched.join(', ')}`);
  return parts.join('; ') || 'listed for context';
}

/**
 * Budgeted multi-signal retrieval, the ranking half: BM25 over chunks, then what names, imports, pairings,
 * open editors and mentions add. Every signal that lifts a file also adds to the reason shown for it.
 */
export function retrieve(index: ContextIndex, query: string, options: RetrieveOptions = {}): RetrievedItem[] {
  const queryText = options.selection ? `${query}\n${options.selection}` : query;
  const terms = uniqueTokens(queryText);
  const queryWords = new Set(tokenize(query));
  const candidates = new Map<string, Candidate>();
  const candidate = (path: string): Candidate => {
    let entry = candidates.get(path);
    if (!entry) {
      entry = { path, score: 0, chunks: [], matched: new Set(), names: [], relations: [], mentioned: false };
      candidates.set(path, entry);
    }
    return entry;
  };

  for (const [path, chunks] of index.scoreChunks(terms)) {
    const file = index.files.get(path);
    const entry = candidate(path);
    entry.score = fileScore(chunks, terms.length);
    if (isDataFile(path)) entry.score *= DATA_FILE_WEIGHT;
    entry.chunks = chunks.slice(0, 6).map((chunk) => chunk.chunk);
    for (const chunk of chunks.slice(0, 3)) {
      for (const word of chunk.matched) entry.matched.add(word);
      const name = file?.chunks[chunk.chunk]?.name;
      if (name && chunk.score > 0) entry.names.push(name);
    }
    // A word that names the file itself.
    if (queryWords.has(moduleStem(path).toLowerCase())) entry.score *= NAME_MATCH_BOOST;
    // A symbol the request names exactly.
    if (file?.symbols.some((symbol) => queryWords.has(symbol.name.toLowerCase()))) entry.score *= SYMBOL_MATCH_BOOST;
  }

  const top = (): Candidate[] => [...candidates.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const seeds = top().slice(0, SEEDS);
  const bestScore = seeds[0]?.score ?? 1;
  const paths = index.paths;

  for (const seed of seeds) {
    for (const pair of pairedFiles(seed.path, paths)) {
      const entry = candidate(pair.path);
      const weight = pair.relation === 'test' ? 0.8 : pair.relation === 'doc' ? 0.7 : 0.6;
      entry.score += seed.score * weight;
      entry.relations.push(
        pair.relation === 'test' ? `test pair of ${seed.path}` : pair.relation === 'doc' ? `documents ${seed.path}` : `the code ${seed.path} describes`,
      );
    }
    // Docs that talk about this module, even under another file name.
    if (!isDocFile(seed.path) && !isTestFile(seed.path)) {
      const stem = moduleStem(seed.path).toLowerCase();
      // Only names that are clearly identifiers: a function called command proves nothing about a doc using the word.
      const symbols = (index.files.get(seed.path)?.symbols ?? [])
        .filter((symbol) => symbol.name.length > 5 && /_|[a-z][A-Z]/.test(symbol.name))
        .map((symbol) => symbol.name.toLowerCase());
      for (const [path, words] of index.fileTerms) {
        if (!isDocFile(path) || isChangelog(path) || path === seed.path) continue;
        const mentionsSymbol = symbols.find((name) => words.has(name));
        const mentionsModule = (words.get(stem) ?? 0) >= 3;
        if (mentionsModule || mentionsSymbol) {
          const entry = candidate(path);
          entry.score += seed.score * 0.15;
          if (entry.relations.length < 2) entry.relations.push(`mentions ${mentionsSymbol ?? stem} from ${seed.path}`);
        }
      }
    }
  }

  for (const seed of seeds.slice(0, IMPORT_SEEDS)) {
    for (const target of index.imports.get(seed.path) ?? []) {
      const entry = candidate(target);
      entry.score += seed.score * 0.12;
      if (entry.relations.length < 2) entry.relations.push(`imported by ${seed.path}`);
    }
    for (const importer of index.importedBy.get(seed.path) ?? []) {
      const entry = candidate(importer);
      entry.score += seed.score * 0.06;
      if (entry.relations.length < 2) entry.relations.push(`imports ${seed.path}`);
    }
  }

  if (CHANGE_WORDS.test(query)) {
    for (const path of paths.filter(isChangelog)) {
      const entry = candidate(path);
      entry.score = Math.max(entry.score, bestScore * 0.3);
      entry.chunks = entry.chunks.length > 0 ? entry.chunks : [0];
      entry.names = [];
      entry.matched.clear();
      entry.relations.unshift('changelog: user-facing changes are recorded here');
    }
  }

  const open = new Set(options.openFiles ?? []);
  for (const path of open) {
    if (!index.files.has(path)) continue;
    const entry = candidate(path);
    entry.score += bestScore * 0.1;
    entry.relations.push('open in the editor');
  }
  if (options.activeFile && index.files.has(options.activeFile)) {
    const entry = candidate(options.activeFile);
    entry.score += bestScore * 0.2;
    if (!entry.relations.includes('open in the editor')) entry.relations.push('open in the editor');
  }

  const mentioned = new Set(options.mentionedFiles ?? []);
  for (const path of mentioned) {
    const entry = candidate(path);
    entry.mentioned = true;
  }

  const ranked = top().sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || b.score - a.score || a.path.localeCompare(b.path));
  const limit = options.limit ?? DEFAULT_LIMIT;
  const kept = ranked.filter((entry, position) => entry.mentioned || (position < limit + mentioned.size && entry.score > 0));
  return kept.map((entry) => ({
    path: entry.path,
    score: entry.score,
    reason: describe(entry, (word) => index.postings.get(word)?.length ?? 0),
    mentioned: entry.mentioned,
    chunks: entry.chunks.length > 0 ? entry.chunks : (index.files.get(entry.path)?.chunks.map((_, i) => i).slice(0, 3) ?? []),
  }));
}
