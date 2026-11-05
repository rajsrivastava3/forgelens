import { extractSymbols, type CodeSymbol } from '../tools/symbols';

export type ChunkKind = 'module' | 'function' | 'class' | 'method' | 'window';

export interface Chunk {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  name?: string | undefined;
}

const WINDOW_LINES = 60;
const WINDOW_STEP = 50;

const TOP_LEVEL_DEFINITION = /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/;
const MEMBER_DEFINITION = /^\s+(?:async\s+def|def)\s+([A-Za-z_]\w*)/;

interface Block {
  start: number;
  end: number;
  kind: 'function' | 'class';
  name: string;
}

function lastContentLine(lines: readonly string[], from: number, to: number): number {
  let end = to;
  while (end > from && !(lines[end] ?? '').trim()) end -= 1;
  return end;
}

/** Top-level definitions, each with its decorators, up to the next statement at the left margin. */
function topLevelBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let decoratorStart: number | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('@')) {
      decoratorStart ??= i;
      continue;
    }
    const match = TOP_LEVEL_DEFINITION.exec(line);
    if (!match?.[1]) {
      // Lines that only continue a decorator's arguments keep it attached.
      if (decoratorStart !== undefined && line && !/^[\s)\]}]/.test(line)) decoratorStart = undefined;
      continue;
    }
    const start = decoratorStart ?? i;
    decoratorStart = undefined;
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      // A closing bracket at the margin only ends a multi-line signature.
      if (next && !/^[\s#)\]}]/.test(next)) break;
      end = j;
    }
    end = lastContentLine(lines, i, end);
    blocks.push({ start, end, kind: line.startsWith('class') ? 'class' : 'function', name: match[1] });
    i = end;
  }
  return blocks;
}

function classChunks(lines: readonly string[], block: Block): Chunk[] {
  const body = lines.slice(block.start, block.end + 1);
  const firstMember = body.findIndex((line) => MEMBER_DEFINITION.test(line));
  if (firstMember < 0) return [{ startLine: block.start + 1, endLine: block.end + 1, kind: 'class', name: block.name }];

  const indent = /^\s*/.exec(body[firstMember] ?? '')?.[0].length ?? 4;
  const starts: number[] = [];
  let decorator: number | undefined;
  for (let i = block.start; i <= block.end; i += 1) {
    const line = lines[i] ?? '';
    const lineIndent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (lineIndent === indent && line.trim().startsWith('@')) decorator ??= i;
    else if (lineIndent === indent && MEMBER_DEFINITION.test(line)) {
      starts.push(decorator ?? i);
      decorator = undefined;
    } else if (lineIndent === indent && line.trim()) decorator = undefined;
  }
  const first = starts[0] ?? block.end + 1;
  const chunks: Chunk[] = [{ startLine: block.start + 1, endLine: lastContentLine(lines, block.start, first - 1) + 1, kind: 'class', name: block.name }];
  starts.forEach((start, index) => {
    const next = starts[index + 1] ?? block.end + 1;
    const definition = lines.slice(start, next).find((line) => MEMBER_DEFINITION.test(line)) ?? '';
    const name = MEMBER_DEFINITION.exec(definition)?.[1];
    chunks.push({ startLine: start + 1, endLine: lastContentLine(lines, start, next - 1) + 1, kind: 'method', name: name ? `${block.name}.${name}` : block.name });
  });
  return chunks;
}

function chunkPython(lines: readonly string[]): Chunk[] {
  const blocks = topLevelBlocks(lines);
  const chunks: Chunk[] = [];
  let cursor = 0;
  const addModuleLines = (from: number, to: number): void => {
    const end = lastContentLine(lines, from, to);
    let start = from;
    while (start <= end && !(lines[start] ?? '').trim()) start += 1;
    if (start <= end) chunks.push({ startLine: start + 1, endLine: end + 1, kind: 'module' });
  };
  for (const block of blocks) {
    addModuleLines(cursor, block.start - 1);
    if (block.kind === 'class') chunks.push(...classChunks(lines, block));
    else chunks.push({ startLine: block.start + 1, endLine: block.end + 1, kind: 'function', name: block.name });
    cursor = block.end + 1;
  }
  addModuleLines(cursor, lines.length - 1);
  return chunks;
}

function chunkWindows(lines: readonly string[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += WINDOW_STEP) {
    const end = Math.min(lines.length, start + WINDOW_LINES);
    if (lines.slice(start, end).some((line) => line.trim())) {
      chunks.push({ startLine: start + 1, endLine: end, kind: 'window' });
    }
    if (end === lines.length) break;
  }
  return chunks;
}

export function chunkFile(path: string, text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return path.endsWith('.py') ? chunkPython(lines) : chunkWindows(lines);
}

export function chunkText(fileText: string, chunk: Pick<Chunk, 'startLine' | 'endLine'>): string {
  return fileText
    .split(/\r?\n/)
    .slice(chunk.startLine - 1, chunk.endLine)
    .join('\n');
}

/** Definitions worth showing in an outline, which is what a skeleton is. */
export function outlineSymbols(path: string, text: string): CodeSymbol[] {
  return extractSymbols(path, text).filter((symbol) => symbol.kind !== 'variable');
}
