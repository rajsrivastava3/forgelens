import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Changeset, normalizeStagePath, StagedEditorPort } from '../../src/core/changeset/changeset';
import { decodeText, encodeText } from '../../src/core/changeset/encoding';
import { applyAcceptedHunks, computeHunks, dominantEol, splitKeepingEol } from '../../src/core/changeset/hunks';
import { applyEdit, EditMatchError } from '../../src/core/changeset/matchEdit';
import { NodeEditorPort } from '../../src/core/tools/nodeEditorPort';
import { readFileTool } from '../../src/core/tools/readFile';
import { getStagedChangesTool, stageCreateFileTool, stageDeleteFileTool, stageEditTool } from '../../src/core/tools/stageTools';

const numbered = (count: number, eol = '\n'): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join(eol) + eol;

describe('hunks', () => {
  it('splits edits far apart into separate hunks with context 3', () => {
    const before = numbered(30);
    const after = before.replace('line 5\n', 'line five\n').replace('line 25\n', 'line twenty-five\n');
    const hunks = computeHunks('a.py', before, after);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 2, oldLines: 7, added: 1, removed: 1 });
    expect(hunks[0]?.lines.filter((line) => line.startsWith(' '))).toHaveLength(6);
  });

  it('merges edits close enough that their context overlaps', () => {
    const before = numbered(30);
    const after = before.replace('line 5\n', 'x\n').replace('line 8\n', 'y\n');
    expect(computeHunks('a.py', before, after)).toHaveLength(1);
  });

  it('keeps a hunk id when another part of the file changes', () => {
    const before = numbered(40);
    const one = before.replace('line 5\n', 'five\n');
    const two = one.replace('line 30\n', 'thirty\n');
    const first = computeHunks('a.py', before, one)[0]?.id;
    expect(first).toBeDefined();
    expect(computeHunks('a.py', before, two).map((hunk) => hunk.id)).toContain(first);
  });

  it('gives identical hunks different ids', () => {
    const block = 'a\nb\nc\nd\ne\nf\ng\nh\ni\n';
    const before = `${block}target\n${block}${block}target\n${block}`;
    const ids = computeHunks('a.py', before, before.replaceAll('target', 'changed')).map((hunk) => hunk.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('applies any subset of hunks onto the original, bottom up', () => {
    const before = numbered(50);
    const after = before
      .replace('line 5\n', 'five\nand a half\n')
      .replace('line 25\n', '')
      .replace('line 45\n', 'forty-five\n');
    const hunks = computeHunks('a.py', before, after);
    expect(hunks).toHaveLength(3);
    const ids = hunks.map((hunk) => hunk.id);

    expect(applyAcceptedHunks(before, after, hunks, new Set())).toBe(before);
    expect(applyAcceptedHunks(before, after, hunks, new Set(ids))).toBe(after);
    expect(applyAcceptedHunks(before, after, hunks, new Set([ids[0] as string]))).toBe(before.replace('line 5\n', 'five\nand a half\n'));
    expect(applyAcceptedHunks(before, after, hunks, new Set([ids[1] as string]))).toBe(before.replace('line 25\n', ''));
    expect(applyAcceptedHunks(before, after, hunks, new Set([ids[0] as string, ids[2] as string]))).toBe(
      before.replace('line 5\n', 'five\nand a half\n').replace('line 45\n', 'forty-five\n'),
    );
  });

  it('keeps CRLF on every line, changed or not', () => {
    const before = numbered(30, '\r\n');
    const after = before.replace('line 5\r\n', 'five\r\n').replace('line 25\r\n', 'twenty-five\r\n');
    const hunks = computeHunks('a.py', before, after);
    const result = applyAcceptedHunks(before, after, hunks, new Set([hunks[1]?.id as string]));
    expect(result).toBe(before.replace('line 25\r\n', 'twenty-five\r\n'));
    expect(result.match(/(?<!\r)\n/g)).toBeNull();
  });

  it('keeps mixed line endings on untouched lines', () => {
    const before = 'a\r\nb\nc\r\nd\ne\nf\ng\nh\ni\nj\nk\n';
    const after = before.replace('j\n', 'J\n');
    const hunks = computeHunks('a.py', before, after);
    expect(applyAcceptedHunks(before, after, hunks, new Set(hunks.map((hunk) => hunk.id)))).toBe(after);
    expect(after.startsWith('a\r\nb\nc\r\n')).toBe(true);
  });

  it('keeps a missing final newline when another hunk is applied', () => {
    const before = `${numbered(30)}last`;
    const after = before.replace('line 3\n', 'three\n').replace('last', 'LAST');
    const hunks = computeHunks('a.py', before, after);
    expect(hunks).toHaveLength(2);
    const result = applyAcceptedHunks(before, after, hunks, new Set([hunks[0]?.id as string]));
    expect(result.endsWith('last')).toBe(true);
    expect(applyAcceptedHunks(before, after, hunks, new Set([hunks[1]?.id as string])).endsWith('LAST')).toBe(true);
  });

  it('can add or remove the final newline', () => {
    const before = 'a\nb';
    const after = 'a\nb\n';
    const hunks = computeHunks('a.py', before, after);
    expect(applyAcceptedHunks(before, after, hunks, new Set(hunks.map((hunk) => hunk.id)))).toBe(after);
    const back = computeHunks('a.py', after, before);
    expect(applyAcceptedHunks(after, before, back, new Set(back.map((hunk) => hunk.id)))).toBe(before);
  });

  it('handles empty files on either side', () => {
    const created = computeHunks('a.py', '', 'x\ny\n');
    expect(applyAcceptedHunks('', 'x\ny\n', created, new Set(created.map((hunk) => hunk.id)))).toBe('x\ny\n');
    const emptied = computeHunks('a.py', 'x\ny\n', '');
    expect(applyAcceptedHunks('x\ny\n', '', emptied, new Set(emptied.map((hunk) => hunk.id)))).toBe('');
  });

  it('splits lines and finds the dominant ending', () => {
    expect(splitKeepingEol('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    expect(splitKeepingEol('')).toEqual([]);
    expect(dominantEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(dominantEol('a\nb')).toBe('\n');
  });
});

describe('encoding', () => {
  it.each([
    ['utf8', Buffer.from('héllo\n', 'utf8')],
    ['utf8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\n', 'utf8')])],
    ['utf16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo\n', 'utf16le')])],
    ['utf16be', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('héllo\n', 'utf16le').swap16()])],
    ['latin1', Buffer.from([0x68, 0xe9, 0x6c, 0x0a])],
  ] as const)('round-trips %s byte for byte', (encoding, bytes) => {
    const decoded = decodeText(bytes);
    expect(decoded?.encoding).toBe(encoding);
    expect(Buffer.compare(encodeText(decoded?.text ?? '', encoding), bytes)).toBe(0);
  });

  it('treats NUL bytes as binary', () => {
    expect(decodeText(Buffer.from([0x61, 0x00, 0x62]))).toBeUndefined();
  });
});

describe('applyEdit', () => {
  const file = 'def a():\n    return 1\n\n\ndef b():\n    return 2\n';

  it('replaces an exact match', () => {
    expect(applyEdit(file, { old_text: '    return 1', new_text: '    return 10' })).toMatchObject({
      text: file.replace('return 1', 'return 10'),
      match: 'exact',
      line: 2,
    });
  });

  it('refuses text that matches several places and names the lines', () => {
    const twice = 'x = 1\ny\nx = 1\n';
    expect(() => applyEdit(twice, { old_text: 'x = 1', new_text: 'x = 2' })).toThrow(/2 places \(lines 1, 3\)/);
  });

  it('matches LF old_text in a CRLF file and writes CRLF', () => {
    const crlf = file.replace(/\n/g, '\r\n');
    const result = applyEdit(crlf, { old_text: 'def a():\n    return 1', new_text: 'def a():\n    x = 1\n    return x' });
    expect(result.match).toBe('exact');
    expect(result.text).toBe(crlf.replace('    return 1', '    x = 1\r\n    return x'));
    expect(result.text.match(/(?<!\r)\n/g)).toBeNull();
  });

  it('tolerates different indentation and re-indents the new text', () => {
    const result = applyEdit(file, { old_text: 'def b():\nreturn 2', new_text: 'def b():\n  return 3\nreturn 4' });
    expect(result.match).toBe('whitespace');
    expect(result.line).toBe(5);
  });

  it('adds the file indentation when the model dropped it', () => {
    const result = applyEdit('class C:\n    def m(self):\n        return 1\n', {
      old_text: 'def m(self):\n    return 1',
      new_text: 'def m(self):\n    return 2',
    });
    expect(result.match).toBe('whitespace');
    expect(result.text).toBe('class C:\n    def m(self):\n        return 2\n');
  });

  it('tolerates tabs, runs of spaces and blank lines around old_text', () => {
    const result = applyEdit('a  =   1\nb = 2\n', { old_text: '\n\ta = 1\n\n', new_text: 'a = 9\n' });
    expect(result.match).toBe('whitespace');
    expect(result.text.startsWith('a = 9')).toBe(true);
    expect(result.text.endsWith('b = 2\n')).toBe(true);
  });

  it('does not treat a difference in words as whitespace', () => {
    expect(() => applyEdit(file, { old_text: 'return 99', new_text: 'return 1' })).toThrow(EditMatchError);
  });

  it('lists the nearest candidates when nothing matches', () => {
    const big = `${numbered(40)}def get_debug_flag():\n    val = os.environ.get("FLASK_DEBUG")\n`;
    try {
      applyEdit(big, { old_text: 'def get_debug_flag(x):\n    val = os.environ.get("DEBUG")', new_text: 'nope' });
      throw new Error('should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(EditMatchError);
      const message = (error as Error).message;
      expect(message).toContain('Nearest places');
      expect(message).toContain('lines 41-42');
      expect(message).toContain('get_debug_flag');
    }
  });

  it('refuses empty old_text and edits that change nothing', () => {
    expect(() => applyEdit(file, { old_text: '  ', new_text: 'x' })).toThrow(/stage_create_file/);
    expect(() => applyEdit(file, { old_text: 'def a', new_text: 'def a' })).toThrow(/changes nothing/);
  });
});

describe('Changeset and staging tools', () => {
  let dir: string;
  let port: NodeEditorPort;
  let changeset: Changeset;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'forgelens changeset '));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/a.py'), numbered(30));
    writeFileSync(path.join(dir, 'src/crlf.py'), numbered(30, '\r\n'));
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
    port = new NodeEditorPort(dir);
    changeset = new Changeset(port);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const onDisk = (file: string): string => readFileSync(path.join(dir, file), 'utf8');

  it('stages without touching disk and returns a mini diff', async () => {
    const result = await stageEditTool(changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5', new_text: 'five' }] });
    expect(result).toContain('+five');
    expect(result).toContain('Staged only');
    expect(onDisk('src/a.py')).toBe(numbered(30));
    expect(changeset.hunks).toHaveLength(1);
  });

  it('lands all edits of a call or none', async () => {
    await expect(
      stageEditTool(changeset, dir, {
        path: 'src/a.py',
        edits: [
          { old_text: 'line 5\n', new_text: 'five\n' },
          { old_text: 'not there at all', new_text: 'x' },
        ],
      }),
    ).rejects.toThrow(/Edit 2 of 2.*Nothing from this call was staged/s);
    expect(changeset.isEmpty).toBe(true);
  });

  it('builds a later edit on staged content', async () => {
    await stageEditTool(changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'five\n' }] });
    await stageEditTool(changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'five\n', new_text: 'FIVE\n' }] });
    expect(changeset.get('src/a.py')?.staged).toContain('FIVE');
    expect(changeset.get('src/a.py')?.original).toBe(numbered(30));
  });

  it('drops a file once its edits cancel out', async () => {
    await stageEditTool(changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'five\n' }] });
    const result = await stageEditTool(changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'five\n', new_text: 'line 5\n' }] });
    expect(result).toContain('no difference');
    expect(changeset.isEmpty).toBe(true);
  });

  it('staged reads overlay disk: read_file, deletions and new files', async () => {
    const overlay = new StagedEditorPort(port, changeset);
    await stageEditTool(changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'five\n' }] });
    await stageCreateFileTool(changeset, dir, { path: 'src/new.py', content: 'new = 1\n' });
    await stageDeleteFileTool(changeset, dir, { path: 'src/crlf.py' });

    const read = await readFileTool(overlay, { path: 'src/a.py', start_line: 5, end_line: 5 });
    expect(read).toContain('5: five');
    expect(read).toContain('staged edits');
    expect(await readFileTool(overlay, { path: 'src/new.py' })).toContain('new = 1');
    await expect(readFileTool(overlay, { path: 'src/crlf.py' })).rejects.toThrow(/staged for deletion/);
    // A file nothing was staged for reads from disk as usual.
    expect(existsSync(path.join(dir, 'src/new.py'))).toBe(false);
  });

  it('summarises with hunk ids', async () => {
    expect(await getStagedChangesTool(changeset)).toBe('No staged changes.');
    await stageEditTool(changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'five\n' }] });
    const summary = await getStagedChangesTool(changeset);
    expect(summary).toContain('1 file, 1 hunk');
    expect(summary).toContain(changeset.hunks[0]?.id);
  });

  it('create and delete refuse the wrong situation', async () => {
    await expect(stageCreateFileTool(changeset, dir, { path: 'src/a.py', content: 'x' })).rejects.toThrow(/already exists/);
    await expect(stageDeleteFileTool(changeset, dir, { path: 'src/nope.py' })).rejects.toThrow(/does not exist/);
    await expect(stageEditTool(changeset, dir, { path: 'src/nope.py', edits: [{ old_text: 'a', new_text: 'b' }] })).rejects.toThrow(/stage_create_file/);
    await expect(stageEditTool(changeset, dir, { path: 'blob.bin', edits: [{ old_text: 'a', new_text: 'b' }] })).rejects.toThrow(/binary/);
  });

  it('a new file then deleted leaves nothing staged', async () => {
    await stageCreateFileTool(changeset, dir, { path: 'src/new.py', content: 'x\n' });
    await stageDeleteFileTool(changeset, dir, { path: 'src/new.py' });
    expect(changeset.isEmpty).toBe(true);
  });

  it('an empty new file still gets one hunk to decide on', async () => {
    await stageCreateFileTool(changeset, dir, { path: 'src/empty.py', content: '' });
    expect(changeset.hunks).toHaveLength(1);
  });

  it('refuses paths outside the workspace and inside .git', () => {
    expect(() => normalizeStagePath(dir, '../evil.py')).toThrow(/outside the workspace/);
    expect(() => normalizeStagePath(dir, '.git/config')).toThrow(/inside .git/);
    expect(normalizeStagePath(dir, './src\\a.py'.replace('\\', '/'))).toBe('src/a.py');
  });

  it('refuses to stage a file with unsaved editor changes', async () => {
    const dirty = new Changeset(Object.assign(Object.create(port) as NodeEditorPort, { hasUnsavedChanges: () => true }));
    await expect(stageEditTool(dirty, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5', new_text: 'x' }] })).rejects.toThrow(/unsaved changes/);
  });

  describe('reconcileWithDisk', () => {
    it('re-diffs: hunks away from the user edit are carried over', async () => {
      await stageEditTool(changeset, dir, {
        path: 'src/a.py',
        edits: [
          { old_text: 'line 5\n', new_text: 'five\n' },
          { old_text: 'line 25\n', new_text: 'twenty-five\n' },
        ],
      });
      const [first, second] = changeset.hunks.map((hunk) => hunk.id);
      writeFileSync(path.join(dir, 'src/a.py'), numbered(30).replace('line 15\n', 'user wrote this\n'));

      const reports = await changeset.reconcileWithDisk();
      expect(reports).toEqual([{ path: 'src/a.py', carried: [first, second], lost: [] }]);
      const staged = changeset.get('src/a.py')?.staged ?? '';
      expect(staged).toContain('user wrote this');
      expect(staged).toContain('five');
      expect(staged).toContain('twenty-five');
    });

    it('drops hunks the user edit collided with, and reports them', async () => {
      await stageEditTool(changeset, dir, {
        path: 'src/a.py',
        edits: [
          { old_text: 'line 5\n', new_text: 'five\n' },
          { old_text: 'line 25\n', new_text: 'twenty-five\n' },
        ],
      });
      const [first, second] = changeset.hunks.map((hunk) => hunk.id);
      writeFileSync(path.join(dir, 'src/a.py'), numbered(30).replace('line 5\n', 'user fifth\n'));

      const [report] = await changeset.reconcileWithDisk();
      expect(report?.lost).toEqual([first]);
      expect(report?.carried).toEqual([second]);
      expect(changeset.get('src/a.py')?.staged).toContain('user fifth');
      expect(changeset.get('src/a.py')?.staged).not.toMatch(/^five$/m);
    });

    it('drops the proposal when the file vanished or a new file now exists', async () => {
      await stageEditTool(changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'five\n' }] });
      await stageCreateFileTool(changeset, dir, { path: 'src/new.py', content: 'mine\n' });
      rmSync(path.join(dir, 'src/a.py'));
      writeFileSync(path.join(dir, 'src/new.py'), 'theirs\n');

      const reports = await changeset.reconcileWithDisk();
      expect(reports.map((report) => report.path).sort()).toEqual(['src/a.py', 'src/new.py']);
      expect(changeset.isEmpty).toBe(true);
    });

    it('reports nothing when disk is unchanged', async () => {
      await stageEditTool(changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'five\n' }] });
      expect(await changeset.reconcileWithDisk()).toEqual([]);
    });
  });
});
