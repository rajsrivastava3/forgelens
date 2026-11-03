import type { EditorPort } from './editorPort';

/**
 * Every tool caps its own output: TrueForge only offloads large tool responses when a sandbox is
 * enabled, and ForgeLens runs without one.
 */
export const MAX_TOOL_OUTPUT_CHARS = 24_000;

const MAX_SEARCHABLE_FILE_CHARS = 1_000_000;

const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|ico|webp|bmp|pdf|zip|gz|tar|tgz|7z|whl|exe|dll|so|dylib|pyc|woff2?|ttf|eot|mp[34]|mov|sqlite)$/i;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Cuts at a line boundary where possible, and always says what happened and how to get more. */
export function capText(text: string, hint: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf('\n', maxChars);
  const kept = text.slice(0, cut > 0 ? cut : maxChars);
  return `${kept}\n[truncated: output exceeded ${maxChars} characters. ${hint}]`;
}

export interface TextFile {
  path: string;
  text: string;
}

/** Visits readable text files without blocking the host: yields to the event loop between batches. */
export async function forEachTextFile(
  port: EditorPort,
  paths: readonly string[],
  visit: (file: TextFile) => boolean | void,
): Promise<void> {
  let visited = 0;
  for (const path of paths) {
    if (BINARY_EXTENSIONS.test(path)) continue;
    let text: string;
    try {
      text = await port.readTextFile(path);
    } catch {
      continue; // Listed but unreadable, for example deleted a moment ago.
    }
    if (text.length > MAX_SEARCHABLE_FILE_CHARS || text.includes('\0')) continue;
    if (visit({ path, text }) === false) return;
    visited += 1;
    if (visited % 25 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Supports `*`, `**` and `?`. Matching is on forward-slash relative paths. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob.charAt(i);
    if (char === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') {
        i += 1;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}
