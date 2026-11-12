import { dominantEol } from './hunks';

export interface EditRequest {
  old_text: string;
  new_text: string;
}

export interface MatchedEdit {
  text: string;
  /**
   * How old_text was found: as given, with whitespace differences ignored, or approximately (the same place
   * once blank lines are ignored, or a block whose first and last lines match and whose middle is close).
   */
  match: 'exact' | 'whitespace' | 'approximate';
  /** 1-based line where the edit starts in the text it was applied to. */
  line: number;
  /** For an approximate match: how many of the replaced lines differed from old_text. */
  differingLines?: number;
}

export class EditMatchError extends Error {}

const toLf = (text: string): string => text.replace(/\r\n/g, '\n');
const squeeze = (line: string): string => line.trim().replace(/\s+/g, ' ');

/** The share of the file's lines an approximate match may differ by, and the least similarity of those lines. */
const APPROXIMATE_MAX_DIFFERING = 0.3;
const APPROXIMATE_MIN_SIMILARITY = 0.6;
/** An anchored match may be this much longer or shorter than old_text, in lines. */
const ANCHOR_SLACK = 0.5;

function offsetsOfLines(lfText: string): number[] {
  const offsets = [0];
  for (let i = lfText.indexOf('\n'); i !== -1; i = lfText.indexOf('\n', i + 1)) offsets.push(i + 1);
  return offsets;
}

function allIndexes(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) found.push(i);
  return found;
}

function lineAt(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Maps an offset in the LF view back to the real text, which may use CRLF. */
function rawOffset(raw: string, lfOffset: number): number {
  let lf = 0;
  let i = 0;
  while (lf < lfOffset && i < raw.length) {
    if (raw[i] === '\r' && raw[i + 1] === '\n') i += 1;
    i += 1;
    lf += 1;
  }
  return i;
}

function leadingWhitespace(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? '';
}

function reindent(lines: readonly string[], from: string, to: string): string[] {
  if (from === to) return [...lines];
  return lines.map((line) => {
    if (line.trim() === '') return line;
    return line.startsWith(from) ? `${to}${line.slice(from.length)}` : line;
  });
}

function wordSet(line: string): Set<string> {
  return new Set(line.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared || 1);
}

/** The places most like old_text, so the model can correct itself without another search. */
export function nearestCandidates(fileLines: readonly string[], wanted: readonly string[], limit = 3): string[] {
  const size = Math.max(1, wanted.length);
  const wantedWords = wanted.map(wordSet);
  const lineWords = fileLines.map(wordSet);
  const scored: { start: number; score: number }[] = [];
  for (let start = 0; start + size <= fileLines.length; start += 1) {
    let total = 0;
    for (let i = 0; i < size; i += 1) total += similarity(wantedWords[i] ?? new Set(), lineWords[start + i] ?? new Set());
    scored.push({ start, score: total / size });
  }
  scored.sort((a, b) => b.score - a.score || a.start - b.start);

  const chosen: { start: number; score: number }[] = [];
  for (const candidate of scored) {
    if (candidate.score <= 0 || chosen.length >= limit) break;
    if (chosen.every((other) => Math.abs(other.start - candidate.start) >= size)) chosen.push(candidate);
  }
  return chosen.map(({ start }) => {
    const excerpt = fileLines.slice(start, start + Math.min(size, 6)).join('\n');
    return `lines ${start + 1}-${start + size}:\n${excerpt}`;
  });
}

/** Where the first and last lines of old_text appear on their own: the hint that most often explains a miss. */
function anchorHints(fileLines: readonly string[], oldLines: readonly string[]): string {
  const squeezed = fileLines.map(squeeze);
  const where = (line: string | undefined): number[] => {
    const wanted = squeeze(line ?? '');
    return wanted ? squeezed.flatMap((candidate, i) => (candidate === wanted ? [i + 1] : [])) : [];
  };
  const first = oldLines.find((line) => line.trim() !== '');
  const last = [...oldLines].reverse().find((line) => line.trim() !== '');
  const parts: string[] = [];
  const firstAt = where(first);
  const lastAt = where(last);
  if (firstAt.length > 0) parts.push(`The first line of old_text is at line ${firstAt.slice(0, 5).join(', ')}.`);
  else if (first) parts.push('The first line of old_text is not in the file at all.');
  if (last && last !== first) {
    if (lastAt.length > 0) parts.push(`The last line is at line ${lastAt.slice(0, 5).join(', ')}.`);
    else parts.push('The last line of old_text is not in the file at all.');
  }
  return parts.join(' ');
}

interface Span {
  start: number;
  end: number;
  differing: number;
}

/**
 * The same block with blank lines left out of the comparison: a model often drops or adds an empty line.
 * Returns the one span whose non-blank lines all match, or nothing.
 */
function blankInsensitiveSpan(fileLines: readonly string[], oldLines: readonly string[]): Span | undefined {
  const wanted = oldLines.map(squeeze).filter((line) => line !== '');
  if (wanted.length === 0) return undefined;
  const squeezed = fileLines.map(squeeze);
  const spans: Span[] = [];
  for (let start = 0; start < squeezed.length; start += 1) {
    if (squeezed[start] !== wanted[0]) continue;
    let i = start;
    let matched = 0;
    while (i < squeezed.length && matched < wanted.length) {
      if (squeezed[i] === wanted[matched]) matched += 1;
      else if (squeezed[i] !== '') break;
      i += 1;
    }
    if (matched === wanted.length) spans.push({ start, end: i - 1, differing: 0 });
  }
  return spans.length === 1 ? spans[0] : undefined;
}

/**
 * A block whose first and last lines are where old_text says, and whose middle is close enough: the model
 * remembered the block a little wrong. Needs at least four lines, one place for the pair, and a middle that is
 * mostly the same, line for line by words.
 */
function anchoredSpan(fileLines: readonly string[], oldLines: readonly string[]): Span | undefined {
  const wanted = oldLines.map(squeeze);
  const firstIndex = wanted.findIndex((line) => line !== '');
  let lastIndex = wanted.length - 1;
  while (lastIndex > firstIndex && wanted[lastIndex] === '') lastIndex -= 1;
  if (firstIndex < 0 || lastIndex - firstIndex < 3) return undefined;
  const head = wanted[firstIndex] as string;
  const tail = wanted[lastIndex] as string;
  const inner = oldLines.slice(firstIndex + 1, lastIndex).map(wordSet);
  const length = lastIndex - firstIndex + 1;
  const squeezed = fileLines.map(squeeze);
  const spans: Span[] = [];
  for (let start = 0; start < squeezed.length; start += 1) {
    if (squeezed[start] !== head) continue;
    const minEnd = start + Math.max(3, Math.floor(length * (1 - ANCHOR_SLACK)) - 1);
    const maxEnd = Math.min(squeezed.length - 1, start + Math.ceil(length * (1 + ANCHOR_SLACK)) - 1);
    for (let end = minEnd; end <= maxEnd; end += 1) {
      if (squeezed[end] !== tail) continue;
      const middle = fileLines.slice(start + 1, end).map(wordSet);
      // Each remembered line is matched to its best counterpart nearby, so one dropped or added line does not
      // shift every comparison after it.
      let differing = 0;
      for (const [i, words] of inner.entries()) {
        const around = middle.slice(Math.max(0, i - 2), i + 3);
        const best = around.reduce((top, candidate) => Math.max(top, similarity(words, candidate)), 0);
        if (best < APPROXIMATE_MIN_SIMILARITY) differing += 1;
      }
      differing += Math.abs(middle.length - inner.length);
      if (differing <= Math.max(1, Math.floor(length * APPROXIMATE_MAX_DIFFERING))) spans.push({ start, end, differing });
    }
  }
  if (spans.length !== 1) return undefined;
  return spans[0];
}

/** The least share of old_text's lines a fuzzy match must contain, in order. */
const FUZZY_MIN_SHARE = 0.75;

/**
 * The block that shares the most lines with old_text, in order, when no other block comes close: the model
 * remembered the first line wrong, or several lines. The span runs from the first matched line to the last.
 */
function fuzzySpan(fileLines: readonly string[], oldLines: readonly string[]): Span | undefined {
  const wanted = oldLines.map(squeeze).filter((line) => line !== '');
  if (wanted.length < 3) return undefined;
  const squeezed = fileLines.map(squeeze);
  const starts = new Set<number>();
  for (let k = 0; k < Math.min(3, wanted.length); k += 1) {
    squeezed.forEach((line, i) => {
      if (line === wanted[k]) starts.add(Math.max(0, i - k));
    });
  }
  const need = Math.ceil(wanted.length * FUZZY_MIN_SHARE);
  const spans: Span[] = [];
  for (const start of starts) {
    const window = squeezed
      .slice(start, Math.min(squeezed.length, start + Math.ceil(wanted.length * (1 + ANCHOR_SLACK))))
      .map((line, i) => ({ line, i }))
      .filter((entry) => entry.line !== '');
    const n = wanted.length;
    const m = window.length;
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        table[i]![j] = wanted[i - 1] === window[j - 1]!.line ? table[i - 1]![j - 1]! + 1 : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
      }
    }
    const matched = table[n]![m]!;
    if (matched < need) continue;
    let i = n;
    let j = m;
    let first = -1;
    let last = -1;
    while (i > 0 && j > 0) {
      if (wanted[i - 1] === window[j - 1]!.line) {
        if (last < 0) last = window[j - 1]!.i;
        first = window[j - 1]!.i;
        i -= 1;
        j -= 1;
      } else if (table[i - 1]![j]! >= table[i]![j - 1]!) i -= 1;
      else j -= 1;
    }
    if (first < 0) continue;
    const span = { start: start + first, end: start + last, differing: n - matched };
    if (!spans.some((other) => other.start === span.start && other.end === span.end)) spans.push(span);
  }
  spans.sort((a, b) => a.differing - b.differing);
  const best = spans[0];
  const next = spans[1];
  if (!best || (next && next.differing <= best.differing)) return undefined;
  return best;
}

/**
 * Applies one search/replace. old_text is looked for as given, then with whitespace differences ignored, then
 * with blank lines ignored, then as a block whose first and last lines match and whose middle is close. The
 * result says which, so the caller can tell the model when the match was approximate.
 */
export function applyEdit(raw: string, edit: EditRequest): MatchedEdit {
  const oldText = toLf(edit.old_text);
  const newText = toLf(edit.new_text);
  if (oldText.trim() === '') throw new EditMatchError('old_text is empty. Use stage_create_file for a new file.');
  if (oldText === newText) throw new EditMatchError('old_text and new_text are the same, so this edit changes nothing.');

  const lf = toLf(raw);
  const eol = dominantEol(raw);
  const offsets = offsetsOfLines(lf);
  const fileLines = lf.split('\n');

  const replaceRange = (lfStart: number, lfEnd: number, replacement: string): string =>
    `${raw.slice(0, rawOffset(raw, lfStart))}${replacement.replace(/\n/g, eol)}${raw.slice(rawOffset(raw, lfEnd))}`;

  const exact = allIndexes(lf, oldText);
  if (exact.length > 1) {
    const lines = exact.slice(0, 8).map((offset) => lineAt(offsets, offset));
    throw new EditMatchError(
      `old_text matches ${exact.length} places (lines ${lines.join(', ')}). Include more surrounding lines so it matches one.`,
    );
  }
  const only = exact[0];
  if (only !== undefined) {
    return { text: replaceRange(only, only + oldText.length, newText), match: 'exact', line: lineAt(offsets, only) };
  }

  // Whitespace-tolerant: same lines once indentation and runs of spaces are ignored.
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  while (oldLines.length > 1 && oldLines.at(-1)?.trim() === '') {
    oldLines.pop();
    if (newLines.length > 1 && newLines.at(-1)?.trim() === '') newLines.pop();
  }
  while (oldLines.length > 1 && oldLines[0]?.trim() === '') {
    oldLines.shift();
    if (newLines.length > 1 && newLines[0]?.trim() === '') newLines.shift();
  }
  const wanted = oldLines.map(squeeze);
  const matches: number[] = [];
  for (let start = 0; start + wanted.length <= fileLines.length; start += 1) {
    if (wanted.every((line, i) => squeeze(fileLines[start + i] ?? '') === line)) matches.push(start);
  }
  if (matches.length > 1) {
    throw new EditMatchError(
      `old_text matches ${matches.length} places once whitespace is ignored (lines ${matches
        .slice(0, 8)
        .map((start) => start + 1)
        .join(', ')}). Include more surrounding lines so it matches one.`,
    );
  }
  const replaceLines = (start: number, last: number, match: MatchedEdit['match'], differingLines?: number): MatchedEdit => {
    const lfStart = offsets[start] ?? 0;
    const lfEnd = (offsets[last] ?? 0) + (fileLines[last] ?? '').length;
    // Re-indenting follows the first line of old_text; an approximate match may start elsewhere, so it keeps
    // new_text as written.
    const adjusted = match === 'whitespace' ? reindent(newLines, leadingWhitespace(oldLines[0] ?? ''), leadingWhitespace(fileLines[start] ?? '')) : [...newLines];
    return { text: replaceRange(lfStart, lfEnd, adjusted.join('\n')), match, line: start + 1, ...(differingLines === undefined ? {} : { differingLines }) };
  };
  const start = matches[0];
  if (start !== undefined) return replaceLines(start, start + wanted.length - 1, 'whitespace');

  const blankFree = blankInsensitiveSpan(fileLines, oldLines);
  if (blankFree) return replaceLines(blankFree.start, blankFree.end, 'approximate', 0);
  const anchored = anchoredSpan(fileLines, oldLines);
  if (anchored) return replaceLines(anchored.start, anchored.end, 'approximate', anchored.differing);
  const fuzzy = fuzzySpan(fileLines, oldLines);
  if (fuzzy) return replaceLines(fuzzy.start, fuzzy.end, 'approximate', fuzzy.differing);

  const candidates = nearestCandidates(fileLines, oldLines);
  const hints = anchorHints(fileLines, oldLines);
  const hint = candidates.length > 0 ? ` Nearest places in the file:\n\n${candidates.join('\n\n')}` : '';
  throw new EditMatchError(`old_text was not found, even ignoring whitespace.${hints ? ` ${hints}` : ''}${hint}`);
}
