import type { EditorPort } from './editorPort';
import { capText, estimateTokens, forEachTextFile } from './output';
import { extractSymbols } from './symbols';

const DEFAULT_REPO_MAP_TOKENS = 2_000;
const MAX_REPO_MAP_TOKENS = 6_000;

/** Derived from listFiles so ignored directories such as .venv never appear. */
export async function listDirTool(
  port: EditorPort,
  args: { path?: string | undefined; depth?: number | undefined },
): Promise<string> {
  const prefix = (args.path ?? '').replace(/\\/g, '/').replace(/^\.?\/?/, '').replace(/\/$/, '');
  const depth = Math.max(1, args.depth ?? 1);
  const files = (await port.listFiles()).filter((f) => !prefix || f.startsWith(`${prefix}/`));
  if (files.length === 0) return `No files under "${args.path ?? '.'}".`;

  const fileEntries = new Set<string>();
  const directoryCounts = new Map<string, number>();
  for (const file of files) {
    const parts = (prefix ? file.slice(prefix.length + 1) : file).split('/');
    if (parts.length <= depth) {
      fileEntries.add(parts.join('/'));
    } else {
      const directory = parts.slice(0, depth).join('/');
      directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
    }
  }
  const lines = [
    ...[...directoryCounts].map(([dir, count]) => `${dir}/ (${count} file${count === 1 ? '' : 's'})`),
    ...fileEntries,
  ].sort();
  return capText(`${prefix || '.'}:\n${lines.join('\n')}`, 'List a subdirectory instead.');
}

/** A budgeted outline: paths first, then each file's top-level signatures until the budget runs out. */
export async function repoMapTool(
  port: EditorPort,
  args: { path_prefix?: string | undefined; budget_tokens?: number | undefined },
  /** Definitions per file from the context index. Without it, this reads the files itself. */
  indexed?: ReadonlyMap<string, readonly { kind: string; line: number; signature: string }[]>,
): Promise<string> {
  const budget = Math.min(args.budget_tokens ?? DEFAULT_REPO_MAP_TOKENS, MAX_REPO_MAP_TOKENS);
  const files = (await port.listFiles())
    .filter((f) => !args.path_prefix || f.startsWith(args.path_prefix))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  const describe = (symbols: readonly { kind: string; line: number; signature: string }[]): string[] =>
    symbols.filter((s) => s.kind === 'class' || s.kind === 'function').map((s) => `  ${s.line}: ${s.signature}`);
  const outlines = new Map<string, string[]>();
  if (indexed) {
    for (const [path, symbols] of indexed) outlines.set(path, describe(symbols));
  } else {
    await forEachTextFile(port, files.filter((f) => /\.(py|ts|tsx|js|jsx)$/.test(f)), ({ path, text }) => {
      outlines.set(path, describe(extractSymbols(path, text)));
    });
  }

  let used = 0;
  let omitted = 0;
  const lines: string[] = [];
  for (const file of files) {
    const entry = [file, ...(outlines.get(file) ?? [])].join('\n');
    const cost = estimateTokens(entry) + 1;
    if (used + cost <= budget) {
      lines.push(entry);
      used += cost;
      continue;
    }
    // Over budget: keep the bare path when it still fits, so the file stays discoverable.
    const pathCost = estimateTokens(file) + 1;
    if (used + pathCost <= budget) {
      lines.push(file);
      used += pathCost;
    } else {
      omitted += 1;
    }
  }
  const header = `Repo map: ~${used} of ${budget} tokens, ${files.length - omitted} of ${files.length} files shown.`;
  const footer = omitted > 0 ? `\n[${omitted} files omitted: over budget. Use path_prefix to focus]` : '';
  return capText(`${header}\n${lines.join('\n')}${footer}`, 'Use path_prefix to focus.');
}

export async function getDiagnosticsTool(
  port: EditorPort,
  args: { path?: string | undefined },
): Promise<string> {
  const diagnostics = await port.getDiagnostics(args.path);
  if (diagnostics.length === 0) return `No diagnostics${args.path ? ` for ${args.path}` : ''}.`;
  const body = diagnostics
    .map((d) => `${d.path}:${d.line} ${d.severity}: ${d.message}${d.source ? ` (${d.source})` : ''}`)
    .join('\n');
  return capText(body, 'Ask for one file.');
}
