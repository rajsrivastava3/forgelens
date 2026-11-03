import type { EditorPort } from './editorPort';
import { capText, forEachTextFile } from './output';
import { findMatches } from './searchCode';

export type SymbolKind = 'function' | 'class' | 'method' | 'variable';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  signature: string;
  doc?: string | undefined;
}

const PY_DEFINITION = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
const PY_CONSTANT = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/;
const JS_DEFINITION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const JS_CONSTANT = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)/;

/** Reads a Python signature that may span lines, stopping at the colon that ends it. */
function pythonSignature(lines: readonly string[], start: number): { text: string; end: number } {
  let text = '';
  for (let i = start; i < Math.min(lines.length, start + 20); i += 1) {
    text += `${text ? ' ' : ''}${(lines[i] ?? '').trim()}`;
    const depth = (text.match(/[([{]/g)?.length ?? 0) - (text.match(/[)\]}]/g)?.length ?? 0);
    if (depth <= 0 && text.trimEnd().endsWith(':')) return { text: text.slice(0, -1).trim(), end: i };
  }
  return { text: (lines[start] ?? '').trim(), end: start };
}

function pythonDocstring(lines: readonly string[], afterLine: number): string | undefined {
  const first = (lines[afterLine + 1] ?? '').trim();
  const match = /^[rRbBuU]?("""|''')(.*)$/.exec(first);
  if (!match) return undefined;
  const rest = (match[2] ?? '').replace(/("""|''')$/, '').trim();
  return rest || (lines[afterLine + 2] ?? '').trim() || undefined;
}

/** Deliberately small line-based parsers: fast, and good enough to locate definitions. */
export function extractSymbols(path: string, text: string): CodeSymbol[] {
  const lines = text.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];

  if (path.endsWith('.py')) {
    let classIndent: number | undefined;
    lines.forEach((line, i) => {
      const constant = PY_CONSTANT.exec(line);
      if (constant?.[1]) {
        symbols.push({ name: constant[1], kind: 'variable', path, line: i + 1, signature: line.trim().slice(0, 120) });
        return;
      }
      const definition = PY_DEFINITION.exec(line);
      if (!definition?.[3]) return;
      const indent = definition[1]?.length ?? 0;
      if (classIndent !== undefined && indent <= classIndent) classIndent = undefined;
      const isClass = definition[2] === 'class';
      const signature = pythonSignature(lines, i);
      // Functions nested inside functions are implementation details, not navigation targets.
      if (indent > 0 && !(classIndent !== undefined && indent > classIndent)) return;
      symbols.push({
        name: definition[3],
        kind: isClass ? 'class' : classIndent !== undefined ? 'method' : 'function',
        path,
        line: i + 1,
        signature: signature.text.slice(0, 200),
        doc: pythonDocstring(lines, signature.end)?.slice(0, 160),
      });
      if (isClass && classIndent === undefined) classIndent = indent;
    });
  } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
    lines.forEach((line, i) => {
      const definition = JS_DEFINITION.exec(line);
      if (definition?.[2]) {
        const kind = definition[1]?.startsWith('function') ? 'function' : 'class';
        symbols.push({ name: definition[2], kind, path, line: i + 1, signature: line.trim().slice(0, 200) });
        return;
      }
      const constant = JS_CONSTANT.exec(line);
      if (constant?.[1]) {
        const kind = /=>|^function/.test(constant[2] ?? '') ? 'function' : 'variable';
        symbols.push({ name: constant[1], kind, path, line: i + 1, signature: line.trim().slice(0, 200) });
      }
    });
  }
  return symbols;
}

export async function collectSymbols(port: EditorPort, pathPrefix?: string): Promise<CodeSymbol[]> {
  const files = (await port.listFiles()).filter(
    (file) => /\.(py|ts|tsx|js|jsx|mjs|cjs)$/.test(file) && (!pathPrefix || file.startsWith(pathPrefix)),
  );
  const symbols: CodeSymbol[] = [];
  await forEachTextFile(port, files, ({ path, text }) => {
    symbols.push(...extractSymbols(path, text));
  });
  return symbols;
}

function describe(symbol: CodeSymbol): string {
  const doc = symbol.doc ? `  # ${symbol.doc}` : '';
  return `${symbol.path}:${symbol.line} [${symbol.kind}] ${symbol.signature}${doc}`;
}

export async function findSymbolTool(
  port: EditorPort,
  args: { name: string; kind?: SymbolKind | undefined },
): Promise<string> {
  const symbols = (await collectSymbols(port)).filter((s) => !args.kind || s.kind === args.kind);
  const exact = symbols.filter((s) => s.name === args.name);
  if (exact.length > 0) return capText(exact.map(describe).join('\n'), 'Add a kind filter.');

  const needle = args.name.toLowerCase();
  const near = symbols.filter((s) => s.name.toLowerCase().includes(needle)).slice(0, 30);
  if (near.length === 0) return `No symbol named "${args.name}".`;
  return capText(
    `No exact match for "${args.name}". Similar symbols:\n${near.map(describe).join('\n')}`,
    'Use a more specific name.',
  );
}

export async function findReferencesTool(
  port: EditorPort,
  args: { name: string; max_results?: number | undefined },
): Promise<string> {
  const { matches, limited } = await findMatches(port, {
    query: `\\b${args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
    regex: true,
    case_sensitive: true,
    max_results: args.max_results ?? 100,
  });
  if (matches.length === 0) return `No references to "${args.name}".`;
  const body = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
  return capText(
    `${matches.length} reference(s), found by text search\n${body}${limited ? '\n[limited: more references exist]' : ''}`,
    'Reduce max_results.',
  );
}
