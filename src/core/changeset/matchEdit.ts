import { dominantEol } from './hunks';

export interface EditRequest {
  old_text: string;
  new_text: string;
}

export interface MatchedEdit {
  text: string;
  /** How old_text was found. */
  match: 'exact' | 'whitespace';
  /** 1-based line where the edit starts in the text it was applied to. */
  line: number;
}

export class EditMatchError extends Error {}

const toLf = (text: string): string => text.replace(/\r\n/g, '\n');
const squeeze = (line: string): string => line.trim().replace(/\s+/g, ' ');

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

/** Applies one search/replace: exact text first, then ignoring differences in whitespace. */
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
  const start = matches[0];
  if (start === undefined) {
    const candidates = nearestCandidates(fileLines, oldLines);
    const hint = candidates.length > 0 ? ` Nearest places in the file:\n\n${candidates.join('\n\n')}` : '';
    throw new EditMatchError(`old_text was not found, even ignoring whitespace.${hint}`);
  }

  const last = start + wanted.length - 1;
  const lfStart = offsets[start] ?? 0;
  const lfEnd = (offsets[last] ?? 0) + (fileLines[last] ?? '').length;
  const adjusted = reindent(newLines, leadingWhitespace(oldLines[0] ?? ''), leadingWhitespace(fileLines[start] ?? ''));
  return { text: replaceRange(lfStart, lfEnd, adjusted.join('\n')), match: 'whitespace', line: start + 1 };
}
