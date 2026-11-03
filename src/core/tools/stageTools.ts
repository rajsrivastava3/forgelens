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

/** All-or-nothing: if any edit fails, none of this call's edits are staged. */
export async function stageEditTool(
  changeset: Changeset,
  workspaceRoot: string,
  args: { path: string; edits: EditRequest[] },
): Promise<string> {
  const path = normalizeStagePath(workspaceRoot, args.path);
  if (args.edits.length === 0) throw new Error('edits is empty.');
  let text = await changeset.currentText(path);
  const notes: string[] = [];
  for (const [index, edit] of args.edits.entries()) {
    try {
      const result = applyEdit(text, edit);
      text = result.text;
      if (result.match === 'whitespace') notes.push(`Edit ${index + 1} matched at line ${result.line} after ignoring whitespace.`);
    } catch (error) {
      if (error instanceof EditMatchError) {
        throw new Error(`Edit ${index + 1} of ${args.edits.length} in ${path}: ${error.message}\nNothing from this call was staged.`, { cause: error });
      }
      throw error;
    }
  }
  const change = await changeset.stageText(path, text);
  return capText([NOT_ON_DISK, ...notes, miniDiff(change, path)].join('\n'), 'Use get_staged_changes for a summary.');
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
