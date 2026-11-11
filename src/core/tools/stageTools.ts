import { normalizeStagePath, type Changeset, type FileChange } from '../changeset/changeset';
import { formatHunk } from '../changeset/hunks';
import { applyEdit, EditMatchError, type EditRequest } from '../changeset/matchEdit';
import { capText } from './output';

const NOT_ON_DISK = 'Staged only: nothing is on disk until the user reviews it through apply_changes.';

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
    try {
      const result = applyEdit(text, edit);
      text = result.text;
      staged += 1;
      if (result.match === 'whitespace') notes.push(`${label} matched at line ${result.line} after ignoring whitespace.`);
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
  if (staged === 0) {
    const why = problems.length > 0 ? problems.join('\n') : `Every edit has old_text equal to new_text, so there is nothing to change.`;
    throw new Error(`${why}\nNothing from this call was staged in ${path}.`);
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
