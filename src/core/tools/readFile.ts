import type { EditorPort } from './editorPort';
import { capText } from './output';

export interface ReadFileArgs {
  path: string;
  start_line?: number | undefined;
  end_line?: number | undefined;
}

export const READ_FILE_MAX_LINES = 400;

/** Returns numbered lines and says so when the result was truncated, so the model can page. */
export async function readFileTool(port: EditorPort, args: ReadFileArgs): Promise<string> {
  const text = await port.readTextFile(args.path);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const start = Math.max(1, args.start_line ?? 1);
  const requestedEnd = Math.min(lines.length, args.end_line ?? lines.length);
  const end = Math.min(requestedEnd, start + READ_FILE_MAX_LINES - 1);

  const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`);
  const staged = port.isStaged?.(args.path) ? ', with your staged edits, not yet on disk' : '';
  const header = `${args.path} (lines ${start}-${end} of ${lines.length}${staged})`;
  const footer =
    end < requestedEnd ? `\n[truncated: call again with start_line=${end + 1} to continue]` : '';
  return capText(`${header}\n${numbered.join('\n')}${footer}`, 'Request a smaller line range.');
}
