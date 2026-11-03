import type { EditorPort } from './editorPort';
import { capText, forEachTextFile, globToRegExp } from './output';

export interface SearchCodeArgs {
  query: string;
  regex?: boolean | undefined;
  path_glob?: string | undefined;
  max_results?: number | undefined;
  /** Overrides smart case, for matching identifiers. */
  case_sensitive?: boolean | undefined;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 200;
const MAX_LINE_CHARS = 200;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Smart case, like ripgrep: an all-lowercase query matches any case. */
function buildMatcher(args: SearchCodeArgs): RegExp {
  const source = args.regex ? args.query : escapeRegExp(args.query);
  const flags = args.case_sensitive || /[A-Z]/.test(args.query) ? '' : 'i';
  try {
    return new RegExp(source, flags);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression "${args.query}": ${reason}`, { cause: error });
  }
}

export async function findMatches(
  port: EditorPort,
  args: SearchCodeArgs,
): Promise<{ matches: SearchMatch[]; limited: boolean }> {
  const matcher = buildMatcher(args);
  const limit = Math.min(args.max_results ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
  const glob = args.path_glob ? globToRegExp(args.path_glob) : undefined;
  const files = (await port.listFiles()).filter((file) => !glob || glob.test(file));

  const matches: SearchMatch[] = [];
  let limited = false;
  await forEachTextFile(port, files, ({ path, text }) => {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!matcher.test(line)) continue;
      if (matches.length === limit) {
        limited = true;
        return false;
      }
      matches.push({ path, line: i + 1, text: line.trim().slice(0, MAX_LINE_CHARS) });
    }
    return true;
  });
  return { matches, limited };
}

export async function searchCodeTool(port: EditorPort, args: SearchCodeArgs): Promise<string> {
  const { matches, limited } = await findMatches(port, args);
  if (matches.length === 0) return `No matches for "${args.query}".`;
  const body = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
  const footer = limited
    ? `\n[limited to ${matches.length} results: narrow the query or set path_glob]`
    : '';
  return capText(`${matches.length} match(es)\n${body}${footer}`, 'Narrow the query or set path_glob.');
}
