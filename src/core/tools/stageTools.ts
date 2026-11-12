import { normalizeStagePath, type Changeset, type FileChange } from '../changeset/changeset';
import { dominantEol, formatHunk } from '../changeset/hunks';
import { applyEdit, EditMatchError, type EditRequest } from '../changeset/matchEdit';
import { capText } from './output';

const NOT_ON_DISK = 'Staged only: nothing is on disk until the user reviews it through apply_changes.';
const RECOVERY =
  'Do not send this old_text again from memory. Call read_file on the lines you mean (reads show the staged text), then either stage_replace_lines with the line numbers it shows, or stage_edit with old_text copied from it. To start this file over from what is on disk, call unstage_file first.';

/**
 * A model sometimes sends the same insertion twice. When the edit grows old_text into new_text (an insertion or
 * an expansion of at least three lines) and new_text is already in the file, once, the earlier call did the
 * work, and applying it again would add the lines a second time.
 */
function alreadyApplied(text: string, edit: EditRequest): boolean {
  const squeeze = (value: string): string => value.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n');
  const wanted = squeeze(edit.new_text);
  const before = squeeze(edit.old_text);
  if (wanted.split('\n').length < 3 || !before || wanted.length <= before.length || !wanted.includes(before)) return false;
  const haystack = squeeze(text);
  const first = haystack.indexOf(wanted);
  return first >= 0 && haystack.indexOf(wanted, first + 1) < 0;
}

function describeFile(change: FileChange): string {
  const added = change.hunks.reduce((sum, hunk) => sum + hunk.added, 0);
  const removed = change.hunks.reduce((sum, hunk) => sum + hunk.removed, 0);
  return `${change.path} (${change.kind}, +${added} -${removed}, ${change.hunks.length} hunk${change.hunks.length === 1 ? '' : 's'})`;
}

function miniDiff(change: FileChange | undefined, path: string): string {
  if (!change) return `${path}: no difference from the file on disk, so nothing is staged for it.`;
  return `${describeFile(change)}\n${change.hunks.map(formatHunk).join('\n')}`;
}

/**
 * Stages the edits that match. An edit whose old_text equals new_text is skipped, one whose old_text is not found
 * is reported with the nearest places, and the rest land. Only when nothing could be staged is the call an error.
 */
export async function stageEditTool(
  changeset: Changeset,
  workspaceRoot: string,
  args: { path: string; edits: EditRequest[] },
): Promise<string> {
  const path = normalizeStagePath(workspaceRoot, args.path);
  if (args.edits.length === 0) throw new Error('edits is empty.');
  let text = await changeset.currentText(path);
  const notes: string[] = [];
  const problems: string[] = [];
  let staged = 0;
  let skipped = 0;
  for (const [index, edit] of args.edits.entries()) {
    const label = `Edit ${index + 1} of ${args.edits.length}`;
    if (alreadyApplied(text, edit)) {
      skipped += 1;
      notes.push(`${label} skipped: its new_text is already in the file, so this edit was applied earlier.`);
      continue;
    }
    try {
      const result = applyEdit(text, edit);
      text = result.text;
      staged += 1;
      if (result.match === 'whitespace') notes.push(`${label} matched at line ${result.line} after ignoring whitespace.`);
      if (result.match === 'approximate') {
        notes.push(
          `${label} matched approximately at line ${result.line}: ${result.differingLines ? `${result.differingLines} line${result.differingLines === 1 ? '' : 's'} of old_text differed from the file` : 'blank lines differed'}. Check the diff below shows the lines you meant.`,
        );
      }
    } catch (error) {
      if (!(error instanceof EditMatchError)) throw error;
      if (edit.old_text.replace(/\r\n/g, '\n') === edit.new_text.replace(/\r\n/g, '\n')) {
        skipped += 1;
        notes.push(`${label} skipped: old_text and new_text are the same, so it changes nothing.`);
      } else {
        problems.push(`${label} was not applied: ${error.message}`);
      }
    }
  }
  if (staged === 0 && skipped > 0 && problems.length === 0) {
    const change = changeset.get(path);
    return `Nothing new to stage in ${path}: ${notes.join(' ')}${change ? `\n${miniDiff(change, path)}` : ''}`;
  }
  if (staged === 0) {
    // Not an error: the model is told exactly where its text was and how to edit by line number instead.
    return `No edit staged in ${path}.\n${problems.join('\n')}\n${RECOVERY}`;
  }
  const change = await changeset.stageText(path, text);
  const count = `Staged ${staged} of ${args.edits.length} edit${args.edits.length === 1 ? '' : 's'} in ${path}${skipped > 0 ? `, skipped ${skipped}` : ''}${problems.length > 0 ? `, ${problems.length} not applied` : ''}.`;
  return capText([count, NOT_ON_DISK, ...notes, ...problems, miniDiff(change, path)].join('\n'), 'Use get_staged_changes for a summary.');
}

export async function stageCreateFileTool(
  changeset: Changeset,
  workspaceRoot: string,
  args: { path: string; content: string },
): Promise<string> {
  const path = normalizeStagePath(workspaceRoot, args.path);
  const change = await changeset.stageCreate(path, args.content);
  return capText(`${NOT_ON_DISK}\n${miniDiff(change, path)}`, 'Use get_staged_changes for a summary.');
}

export async function stageDeleteFileTool(
  changeset: Changeset,
  workspaceRoot: string,
  args: { path: string },
): Promise<string> {
  const path = normalizeStagePath(workspaceRoot, args.path);
  const change = await changeset.stageDelete(path);
  return change ? `${NOT_ON_DISK}\n${describeFile(change)}` : `${path}: the staged new file was removed.`;
}

export interface ReplaceLinesArgs {
  path: string;
  start_line: number;
  end_line: number;
  new_text: string;
  expect_first_line?: string | undefined;
}

/**
 * Replaces lines start_line to end_line (1-based, inclusive, as read_file numbers them) with new_text. With
 * end_line one less than start_line it inserts before start_line. No text matching: the numbers come from a read.
 */
export async function stageReplaceLinesTool(changeset: Changeset, workspaceRoot: string, args: ReplaceLinesArgs): Promise<string> {
  const path = normalizeStagePath(workspaceRoot, args.path);
  const text = await changeset.currentText(path);
  const eol = dominantEol(text);
  const lines = text.split(/\r?\n/);
  const trailing = lines.at(-1) === '';
  if (trailing) lines.pop();
  const start = Math.floor(args.start_line);
  const end = Math.floor(args.end_line);
  if (!(start >= 1 && start <= lines.length + 1 && end >= start - 1 && end <= lines.length)) {
    return `No change staged in ${path}: the file has ${lines.length} lines, so start_line ${start} to end_line ${end} is not a range in it. Read the lines again and use the numbers read_file shows.`;
  }
  if (args.expect_first_line !== undefined && end >= start) {
    const squeeze = (value: string): string => value.trim().replace(/\s+/g, ' ');
    const actual = lines[start - 1] ?? '';
    if (squeeze(actual) !== squeeze(args.expect_first_line)) {
      return `No change staged in ${path}: line ${start} is "${actual.trim()}", not "${args.expect_first_line.trim()}". The file has changed since you read it; read_file the lines again.`;
    }
  }
  const replacement = args.new_text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const next = [...lines.slice(0, start - 1), ...(args.new_text === '' ? [] : replacement), ...lines.slice(end)];
  const result = next.join(eol) + (trailing ? eol : '');
  const change = await changeset.stageText(path, result);
  const what = end >= start ? `Replaced lines ${start}-${end}` : `Inserted before line ${start}`;
  return capText([`${what} of ${path} with ${replacement.length} line${replacement.length === 1 ? '' : 's'}.`, NOT_ON_DISK, miniDiff(change, path)].join('\n'), 'Use get_staged_changes for a summary.');
}

export function unstageFileTool(changeset: Changeset, workspaceRoot: string, args: { path: string }): string {
  const path = normalizeStagePath(workspaceRoot, args.path);
  return changeset.unstage(path)
    ? `${path}: staged changes dropped. Reads of it now show the file on disk; stage it again from that text.`
    : `${path}: nothing was staged for it.`;
}

export function getStagedChangesTool(changeset: Changeset): Promise<string> {
  if (changeset.isEmpty) return Promise.resolve('No staged changes.');
  const files = changeset.files;
  const hunks = changeset.hunks.length;
  const header = `${files.length} file${files.length === 1 ? '' : 's'}, ${hunks} hunk${hunks === 1 ? '' : 's'} staged, not on disk.`;
  const body = files
    .map(
      (file) =>
        `${describeFile(file)}\n${file.hunks.map((hunk) => `  ${hunk.id} @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`).join('\n')}`,
    )
    .join('\n');
  return Promise.resolve(capText(`${header}\n${body}`, 'Read individual files with read_file.'));
}
