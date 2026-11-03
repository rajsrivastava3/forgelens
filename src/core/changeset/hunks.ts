import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';

export const HUNK_CONTEXT_LINES = 3;

export interface Hunk {
  /** Derived from the path and the hunk's lines, so a decision survives edits elsewhere in the file. */
  id: string;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Prefixed with ' ', '-' or '+', without line endings. */
  lines: string[];
  added: number;
  removed: number;
}

/** Keeps each line's own terminator, so mixed line endings and a missing final newline survive. */
export function splitKeepingEol(text: string): string[] {
  if (text === '') return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', start)) {
    lines.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** The ending most lines use. An edit's new lines take this, so a CRLF file stays CRLF. */
export function dominantEol(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text[i - 1] === '\r') crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? '\r\n' : '\n';
}

function hunkId(path: string, lines: readonly string[], seen: Map<string, number>): string {
  const digest = createHash('sha1').update(path).update('\0').update(lines.join('\n')).digest('hex').slice(0, 8);
  const count = seen.get(digest) ?? 0;
  seen.set(digest, count + 1);
  // Identical hunks can occur in one file; numbering keeps each id unique and repeatable.
  return count === 0 ? `h-${digest}` : `h-${digest}-${count + 1}`;
}

export function computeHunks(path: string, oldText: string, newText: string): Hunk[] {
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context: HUNK_CONTEXT_LINES });
  const seen = new Map<string, number>();
  return patch.hunks.map((hunk) => {
    const lines = hunk.lines.filter((line) => !line.startsWith('\\')).map((line) => line.replace(/\r$/, ''));
    return {
      // Keeps the raw lines in the hash, so a change of line ending alone is a different hunk.
      id: hunkId(path, hunk.lines, seen),
      path,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines,
      added: lines.filter((line) => line.startsWith('+')).length,
      removed: lines.filter((line) => line.startsWith('-')).length,
    };
  });
}

/**
 * Builds the file with only the accepted hunks. Works from the bottom up on the ORIGINAL, so earlier
 * positions stay valid, and copies raw lines from the staged text, so endings are never rewritten.
 */
export function applyAcceptedHunks(
  oldText: string,
  newText: string,
  hunks: readonly Hunk[],
  accepted: ReadonlySet<string>,
): string {
  const result = splitKeepingEol(oldText);
  const staged = splitKeepingEol(newText);
  const bottomUp = hunks.filter((hunk) => accepted.has(hunk.id)).sort((a, b) => b.oldStart - a.oldStart);
  for (const hunk of bottomUp) {
    const replacement = staged.slice(Math.max(0, hunk.newStart - 1), Math.max(0, hunk.newStart - 1) + hunk.newLines);
    result.splice(Math.max(0, hunk.oldStart - 1), hunk.oldLines, ...replacement);
  }
  return result.join('');
}

/** The raw text a hunk covers on each side, used to carry it onto a file that changed underneath it. */
export function hunkBlocks(oldText: string, newText: string, hunk: Hunk): { before: string; after: string } {
  const oldStart = Math.max(0, hunk.oldStart - 1);
  const newStart = Math.max(0, hunk.newStart - 1);
  return {
    before: splitKeepingEol(oldText).slice(oldStart, oldStart + hunk.oldLines).join(''),
    after: splitKeepingEol(newText).slice(newStart, newStart + hunk.newLines).join(''),
  };
}

/** The 1-based line on the proposed side where this hunk's change begins, after its context lines. */
export function firstChangedLine(hunk: Hunk): number {
  const context = hunk.lines.findIndex((line) => line.startsWith('+') || line.startsWith('-'));
  return hunk.newStart + Math.max(0, context);
}

export function formatHunk(hunk: Hunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ [${hunk.id}]\n${hunk.lines.join('\n')}`;
}
