import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewFlow, type ReviewCard } from '../../src/core/changeset/reviewFlow';
import { NodeEditorPort } from '../../src/core/tools/nodeEditorPort';
import { stageCreateFileTool, stageDeleteFileTool, stageEditTool } from '../../src/core/tools/stageTools';
import type { PendingApproval } from '../../src/core/trueforge/turnRunner';

const numbered = (count: number, eol = '\n'): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join(eol) + eol;

const APPROVAL: PendingApproval = {
  threadId: 'main',
  toolCallId: 'call-1',
  call: { id: 'call-1', name: 'apply_changes', server: 'forgelens-editor', args: { summary: 's' }, viaCallTool: false, system: false },
};

describe('ReviewFlow', () => {
  let dir: string;
  let port: NodeEditorPort;
  let flow: ReviewFlow;
  let cards: ReviewCard[];
  let warnings: string[];

  const onDisk = (file: string): string => readFileSync(path.join(dir, file), 'utf8');
  const lastCard = (): ReviewCard | undefined => cards.at(-1);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'forgelens review '));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/a.py'), numbered(40));
    writeFileSync(path.join(dir, 'src/b.py'), numbered(40));
    writeFileSync(path.join(dir, 'src/crlf.py'), numbered(40, '\r\n'));
    port = new NodeEditorPort(dir);
    cards = [];
    warnings = [];
    flow = new ReviewFlow(port, { onCard: (card) => cards.push(card), onWarning: (message) => warnings.push(message) });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stageTwoFiles = async (): Promise<void> => {
    await stageEditTool(flow.changeset, dir, {
      path: 'src/a.py',
      edits: [
        { old_text: 'line 5\n', new_text: 'a five\n' },
        { old_text: 'line 30\n', new_text: 'a thirty\n' },
      ],
    });
    await stageEditTool(flow.changeset, dir, { path: 'src/b.py', edits: [{ old_text: 'line 10\n', new_text: 'b ten\n' }] });
  };

  it('opens a review that says what is waiting', async () => {
    await stageTwoFiles();
    void flow.requestReview(APPROVAL);
    expect(flow.isReviewing).toBe(true);
    expect(lastCard()).toMatchObject({ phase: 'reviewing', text: '2 files, 3 hunks, waiting for your review', pending: 3, canUndo: false });
  });

  it('partial accept across files writes only accepted hunks, and tells the model which', async () => {
    await stageTwoFiles();
    const [aFive, aThirty, bTen] = flow.changeset.hunks;
    const decision = flow.requestReview(APPROVAL);

    flow.setDecision(aFive?.id as string, 'accepted');
    flow.setDecision(aThirty?.id as string, 'rejected');
    flow.setDecision(bTen?.id as string, 'accepted');
    expect(lastCard()).toMatchObject({ accepted: 2, rejected: 1, pending: 0 });
    expect(onDisk('src/a.py')).toBe(numbered(40)); // Still nothing on disk.

    expect(await flow.applyDecisions()).toBe('sent');
    await expect(decision).resolves.toEqual({ allow: true });
    expect(onDisk('src/a.py')).toBe(numbered(40)); // Only the tool writes.

    const result = await flow.applyApproved('rename things');
    expect(onDisk('src/a.py')).toBe(numbered(40).replace('line 5\n', 'a five\n'));
    expect(onDisk('src/b.py')).toBe(numbered(40).replace('line 10\n', 'b ten\n'));
    expect(result).toContain('2 of 3 hunks are now on disk');
    expect(result).toContain(`Applied: ${aFive?.id} (src/a.py`);
    expect(result).toContain(`Rejected by the user: ${aThirty?.id} (src/a.py`);
    expect(lastCard()).toMatchObject({ phase: 'applied', text: 'Applied 2/3 hunks in 2 files', canUndo: true, accepted: 2, rejected: 1 });
    expect(flow.changeset.isEmpty).toBe(true);
  });

  it('counts undecided hunks as rejected', async () => {
    await stageTwoFiles();
    const [first] = flow.changeset.hunks;
    void flow.requestReview(APPROVAL);
    flow.setDecision(first?.id as string, 'accepted');
    await flow.applyDecisions();
    expect(await flow.applyApproved('s')).toContain('1 of 3 hunks');
    expect(onDisk('src/b.py')).toBe(numbered(40));
  });

  it('all rejected denies with every hunk id and writes nothing', async () => {
    await stageTwoFiles();
    const ids = flow.changeset.hunks.map((hunk) => hunk.id);
    const decision = flow.requestReview(APPROVAL);
    flow.setAll('rejected');
    await flow.applyDecisions();
    await expect(decision).resolves.toEqual({ allow: false, reason: `user rejected all hunks: ${ids.join(', ')}` });
    expect(lastCard()).toMatchObject({ phase: 'rejected', canUndo: false });
    expect(onDisk('src/a.py')).toBe(numbered(40));
    expect(flow.changeset.isEmpty).toBe(true);
  });

  it('apply_changes writes nothing without a reviewed change, even if the gate were skipped', async () => {
    await stageTwoFiles();
    await expect(flow.applyApproved('sneaky')).rejects.toThrow(/nothing was written/);
    expect(onDisk('src/a.py')).toBe(numbered(40));
    expect(flow.changeset.isEmpty).toBe(false);
  });

  it('is safe when apply_changes is called twice', async () => {
    await stageTwoFiles();
    void flow.requestReview(APPROVAL);
    flow.setAll('accepted');
    await flow.applyDecisions();
    await flow.applyApproved('once');
    const written = onDisk('src/a.py');
    await expect(flow.applyApproved('twice')).rejects.toThrow(/Nothing is staged/);
    expect(onDisk('src/a.py')).toBe(written);
  });

  it('a second approval in the same pause does not open another review', async () => {
    await stageTwoFiles();
    void flow.requestReview(APPROVAL);
    flow.setAll('accepted');
    await flow.applyDecisions();
    await expect(flow.requestReview(APPROVAL)).resolves.toMatchObject({ allow: false });
  });

  it('with nothing staged it denies at once, without asking the user', async () => {
    await expect(flow.requestReview(APPROVAL)).resolves.toMatchObject({ allow: false, reason: expect.stringMatching(/Nothing is staged/) });
    expect(flow.isReviewing).toBe(false);
  });

  it('applies new files and deletions, and leaves them when rejected', async () => {
    await stageCreateFileTool(flow.changeset, dir, { path: 'src/new/deep.py', content: 'new\n' });
    await stageDeleteFileTool(flow.changeset, dir, { path: 'src/b.py' });
    void flow.requestReview(APPROVAL);
    flow.setAll('accepted');
    await flow.applyDecisions();
    await flow.applyApproved('add and remove');
    expect(onDisk('src/new/deep.py')).toBe('new\n');
    expect(existsSync(path.join(dir, 'src/b.py'))).toBe(false);

    const undo = await flow.undoLast();
    expect(undo).toMatchObject({ ok: true, files: 2 });
    expect(existsSync(path.join(dir, 'src/new/deep.py'))).toBe(false);
    expect(onDisk('src/b.py')).toBe(numbered(40));
  });

  it('a rejected deletion keeps the file', async () => {
    await stageDeleteFileTool(flow.changeset, dir, { path: 'src/b.py' });
    await stageEditTool(flow.changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'five\n' }] });
    const del = flow.changeset.get('src/b.py')?.hunks[0];
    const edit = flow.changeset.get('src/a.py')?.hunks[0];
    void flow.requestReview(APPROVAL);
    flow.setDecision(del?.id as string, 'rejected');
    flow.setDecision(edit?.id as string, 'accepted');
    await flow.applyDecisions();
    await flow.applyApproved('s');
    expect(onDisk('src/b.py')).toBe(numbered(40));
    expect(onDisk('src/a.py')).toContain('five');
  });

  it('keeps CRLF through staging, partial apply and undo, byte for byte', async () => {
    const original = readFileSync(path.join(dir, 'src/crlf.py'));
    await stageEditTool(flow.changeset, dir, {
      path: 'src/crlf.py',
      edits: [
        { old_text: 'line 5\n', new_text: 'five\nand more\n' },
        { old_text: 'line 30\n', new_text: 'thirty\n' },
      ],
    });
    const [first] = flow.changeset.hunks;
    void flow.requestReview(APPROVAL);
    flow.setDecision(first?.id as string, 'accepted');
    await flow.applyDecisions();
    await flow.applyApproved('s');

    const written = onDisk('src/crlf.py');
    expect(written).toBe(numbered(40, '\r\n').replace('line 5\r\n', 'five\r\nand more\r\n'));
    expect(written.match(/(?<!\r)\n/g)).toBeNull();
    await flow.undoLast();
    expect(Buffer.compare(readFileSync(path.join(dir, 'src/crlf.py')), original)).toBe(0);
  });

  describe('file changed on disk after staging', () => {
    it('re-diffs, warns and keeps the review open instead of clobbering', async () => {
      await stageTwoFiles();
      const decision = flow.requestReview(APPROVAL);
      flow.setAll('accepted');
      const userVersion = numbered(40).replace('line 20\n', 'user wrote this\n');
      writeFileSync(path.join(dir, 'src/a.py'), userVersion);

      expect(await flow.applyDecisions()).toBe('changed-on-disk');
      expect(flow.isReviewing).toBe(true);
      expect(warnings[0]).toContain('src/a.py changed while you were reviewing');
      expect(lastCard()?.warning).toContain('src/a.py');
      expect(onDisk('src/a.py')).toBe(userVersion);

      // The same hunks keep their ids and decisions, so a second press applies them on the new content.
      expect(await flow.applyDecisions()).toBe('sent');
      await expect(decision).resolves.toEqual({ allow: true });
      await flow.applyApproved('s');
      const final = onDisk('src/a.py');
      expect(final).toContain('user wrote this');
      expect(final).toContain('a five');
      expect(final).toContain('a thirty');
    });

    it('never overwrites when the change lands between Apply and the tool running', async () => {
      await stageTwoFiles();
      void flow.requestReview(APPROVAL);
      flow.setAll('accepted');
      await flow.applyDecisions();
      const userVersion = numbered(40).replace('line 5\n', 'user fifth\n');
      writeFileSync(path.join(dir, 'src/a.py'), userVersion);

      const result = await flow.applyApproved('s');
      expect(onDisk('src/a.py')).toBe(userVersion);
      expect(onDisk('src/b.py')).toContain('b ten');
      expect(result).toContain('Skipped, the file changed on disk after review');
      expect(result).toContain('1 of 3 hunks');
      expect(warnings.join()).toContain('2 hunks skipped');
    });

    it('denies when nothing is left to apply', async () => {
      await stageEditTool(flow.changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'five\n' }] });
      const decision = flow.requestReview(APPROVAL);
      flow.setAll('accepted');
      rmSync(path.join(dir, 'src/a.py'));
      await flow.applyDecisions();
      await expect(decision).resolves.toMatchObject({ allow: false });
      expect(lastCard()?.phase).toBe('discarded');
      expect(existsSync(path.join(dir, 'src/a.py'))).toBe(false);
    });
  });

  describe('undo', () => {
    const applyAll = async (): Promise<void> => {
      void flow.requestReview(APPROVAL);
      flow.setAll('accepted');
      await flow.applyDecisions();
      await flow.applyApproved('s');
    };

    it('restores every touched file and says how many', async () => {
      await stageTwoFiles();
      await applyAll();
      expect(onDisk('src/a.py')).not.toBe(numbered(40));
      await expect(flow.undoLast()).resolves.toEqual({ ok: true, message: 'Reverted 2 files', files: 2 });
      expect(onDisk('src/a.py')).toBe(numbered(40));
      expect(onDisk('src/b.py')).toBe(numbered(40));
      expect(lastCard()).toMatchObject({ phase: 'undone', canUndo: false });
      expect(lastCard()?.text).toContain('reverted 2 files');
    });

    it('is a stack: only the newest shows Undo, and the previous one gets it back', async () => {
      await stageEditTool(flow.changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'first\n' }] });
      await applyAll();
      await stageEditTool(flow.changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'first\n', new_text: 'second\n' }] });
      await applyAll();
      const firstCardId = cards.find((card) => card.phase === 'applied')?.id;
      expect(cards.filter((card) => card.id === firstCardId).at(-1)?.canUndo).toBe(false);

      await flow.undoLast();
      expect(onDisk('src/a.py')).toContain('first');
      expect(cards.filter((card) => card.id === firstCardId).at(-1)?.canUndo).toBe(true);
      await flow.undoLast();
      expect(onDisk('src/a.py')).toBe(numbered(40));
      await expect(flow.undoLast()).resolves.toMatchObject({ ok: false });
    });

    it('refuses to overwrite edits made after the apply, and touches no file', async () => {
      await stageTwoFiles();
      await applyAll();
      const bBefore = onDisk('src/b.py');
      writeFileSync(path.join(dir, 'src/a.py'), 'user edit\n');
      const result = await flow.undoLast();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('src/a.py changed after');
      expect(onDisk('src/a.py')).toBe('user edit\n');
      expect(onDisk('src/b.py')).toBe(bBefore);
      expect(flow.canUndo).toBe(true);
    });
  });

  describe('cancel', () => {
    it('Stop during staging discards everything', async () => {
      await stageTwoFiles();
      flow.discard();
      expect(flow.changeset.isEmpty).toBe(true);
      expect(onDisk('src/a.py')).toBe(numbered(40));
    });

    it('Stop during review closes it and writes nothing', async () => {
      await stageTwoFiles();
      const stop = new AbortController();
      void flow.requestReview(APPROVAL, stop.signal);
      flow.setAll('accepted');
      stop.abort();
      expect(flow.isReviewing).toBe(false);
      expect(flow.changeset.isEmpty).toBe(true);
      expect(lastCard()).toMatchObject({ phase: 'discarded', text: 'Review closed. Nothing was written.' });
      await expect(flow.applyDecisions()).resolves.toBe('no-review');
      expect(onDisk('src/a.py')).toBe(numbered(40));
    });

    it('Stop after allow but before the tool runs writes nothing', async () => {
      await stageTwoFiles();
      void flow.requestReview(APPROVAL);
      flow.setAll('accepted');
      await flow.applyDecisions();
      flow.discard();
      await expect(flow.applyApproved('late')).rejects.toThrow();
      expect(onDisk('src/a.py')).toBe(numbered(40));
      expect(lastCard()).toMatchObject({ phase: 'discarded', text: 'Stopped before applying. Nothing was written.' });
    });

    it('Stop during apply is safe: the applied change lands whole and can be undone', async () => {
      await stageTwoFiles();
      void flow.requestReview(APPROVAL);
      flow.setAll('accepted');
      await flow.applyDecisions();
      const applying = flow.applyApproved('s');
      flow.discard(); // The user presses Stop while the write is in flight.
      await applying;
      expect(onDisk('src/a.py')).toContain('a five');
      expect(onDisk('src/a.py')).toContain('a thirty');
      expect(onDisk('src/b.py')).toContain('b ten');
      expect(lastCard()).toMatchObject({ phase: 'applied', canUndo: true });
      await flow.undoLast();
      expect(onDisk('src/a.py')).toBe(numbered(40));
    });
  });

  it('a failed write restores what it changed and reports it', async () => {
    await stageTwoFiles();
    void flow.requestReview(APPROVAL);
    flow.setAll('accepted');
    await flow.applyDecisions();
    // b.py becomes a directory, so writing it fails after a.py has already been written.
    rmSync(path.join(dir, 'src/b.py'));
    mkdirSync(path.join(dir, 'src/b.py'));
    writeFileSync(path.join(dir, 'src/b.py/blocker'), 'x');
    const failing = Object.assign(Object.create(port) as NodeEditorPort, { readDiskBytes: async (file: string) =>
      file === 'src/b.py' ? Buffer.from(numbered(40)) : port.readDiskBytes(file) });
    const other = new ReviewFlow(failing, { onCard: (card) => cards.push(card) });
    writeFileSync(path.join(dir, 'src/c.py'), numbered(40));
    await stageEditTool(other.changeset, dir, { path: 'src/c.py', edits: [{ old_text: 'line 5\n', new_text: 'c five\n' }] });
    await stageEditTool(other.changeset, dir, { path: 'src/b.py', edits: [{ old_text: 'line 5\n', new_text: 'b five\n' }] });
    void other.requestReview(APPROVAL);
    other.setAll('accepted');
    await other.applyDecisions();

    await expect(other.applyApproved('s')).rejects.toThrow(/nothing was applied/);
    expect(onDisk('src/c.py')).toBe(numbered(40));
    expect(lastCard()?.phase).toBe('failed');
    expect(lastCard()?.text).toContain('workspace is unchanged');
  });
});
