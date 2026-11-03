import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewFlow } from '../../src/core/changeset/reviewFlow';
import {
  buildInlinePrompt,
  extractCodeBlocks,
  finishInlineEdit,
  inlineDisplayText,
  readSelection,
  replacementFromText,
  type InlineTarget,
} from '../../src/core/inline/inlineEdit';
import { mentionCandidates, MENTION_MAX_CHARS, parseMentions, resolveMentions } from '../../src/core/inline/mentions';
import { NodeEditorPort } from '../../src/core/tools/nodeEditorPort';
import { stageEditTool } from '../../src/core/tools/stageTools';

const FILE = [
  'import os',
  '',
  '',
  'def get_debug_flag() -> bool:',
  '    """Get the flag."""',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no"})',
  '',
  '',
  'def other():',
  '    return 1',
  '',
].join('\n');
const SELECTION = { startLine: 4, endLine: 7 };
const NEW_FUNCTION = [
  'def get_debug_flag() -> bool:',
  '    """Get the flag. False for 0, false, no, nope and nah."""',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no", "nope", "nah"})',
].join('\n');

describe('readSelection and the prompt', () => {
  it('takes whole lines and the context around them', () => {
    const { selected, before, after } = readSelection(FILE, SELECTION);
    expect(selected.startsWith('def get_debug_flag')).toBe(true);
    expect(selected.endsWith('"no"})\n')).toBe(true);
    expect(before).toBe('import os\n\n\n');
    expect(after).toContain('def other');
  });

  it('gives the agent the path, lines, instruction, selection and context', () => {
    const target: InlineTarget = { path: 'src/h.py', ...SELECTION, language: 'python', instruction: 'Treat off as false.' };
    const prompt = buildInlinePrompt(target, readSelection(FILE, SELECTION));
    expect(prompt).toContain('File: src/h.py');
    expect(prompt).toContain('Selected lines: 4-7');
    expect(prompt).toContain('Instruction: Treat off as false.');
    expect(prompt).toContain('```python\ndef get_debug_flag');
    expect(prompt).toContain('import os');
    expect(prompt).toContain('def other');
    expect(prompt).toContain('stage_edit');
    expect(prompt).toContain('apply_changes');
    expect(inlineDisplayText(target)).toBe('Edit src/h.py, lines 4-7: Treat off as false.');
  });

  it('labels what was mentioned, and says when something was not found', () => {
    const target: InlineTarget = { path: 'a.py', startLine: 1, endLine: 1, language: 'python', instruction: 'x' };
    const prompt = buildInlinePrompt(target, readSelection('a\n', target), [
      { kind: 'file', name: 'b.py', label: 'file b.py', found: true, text: 'B body' },
      { kind: 'symbol', name: 'nope', label: 'symbol nope', found: false, text: 'Not found in the workspace: nope' },
    ]);
    expect(prompt).toContain('Mentioned by you, file b.py:');
    expect(prompt).toContain('B body');
    expect(prompt).toContain('Not found in the workspace: nope');
  });

  it('sends CRLF selections to the model with plain newlines', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    const target: InlineTarget = { path: 'h.py', ...SELECTION, language: 'python', instruction: 'x' };
    expect(buildInlinePrompt(target, readSelection(crlf, SELECTION))).not.toContain('\r');
  });
});

describe('extractCodeBlocks', () => {
  it('finds fenced blocks, their language, and tilde fences', () => {
    const text = 'Here:\n```python\nx = 1\n```\nand\n~~~\ny = 2\n~~~\n';
    expect(extractCodeBlocks(text)).toEqual([
      { language: 'python', code: 'x = 1\n' },
      { language: '', code: 'y = 2\n' },
    ]);
  });

  it('ignores empty blocks and unclosed fences', () => {
    expect(extractCodeBlocks('```\n\n```\n```python\nnever closed')).toEqual([]);
  });

  it('handles CRLF answers', () => {
    expect(extractCodeBlocks('```py\r\nx = 1\r\n```\r\n')[0]?.code).toBe('x = 1\n');
  });
});

describe('replacementFromText', () => {
  const answer = (code: string, language = 'python'): string => `Sure, here you go:\n\n\`\`\`${language}\n${code}\n\`\`\`\n\nThat treats off as false.`;

  it('replaces only the selection and keeps everything else', () => {
    const result = replacementFromText(answer(NEW_FUNCTION), FILE, SELECTION);
    expect(result).toEqual({ ok: true, text: FILE.replace(readSelection(FILE, SELECTION).selected, `${NEW_FUNCTION}\n`) });
  });

  it('keeps CRLF across the whole file', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    const result = replacementFromText(answer(NEW_FUNCTION), crlf, SELECTION);
    expect(result.ok && result.text.match(/(?<!\r)\n/g)).toBeNull();
    expect(result.ok && result.text).toContain('"nope", "nah"})\r\n');
  });

  it('keeps a selection with no final newline that way', () => {
    const noNewline = 'def f():\n    return 1';
    const result = replacementFromText(answer('def f():\n    return 2'), noNewline, { startLine: 1, endLine: 2 });
    expect(result).toEqual({ ok: true, text: 'def f():\n    return 2' });
  });

  it('restores indentation a model removed', () => {
    const nested = 'class C:\n    def m(self):\n        return 1\n\n    def n(self):\n        return 2\n';
    const result = replacementFromText(answer('def m(self):\n    return 9'), nested, { startLine: 2, endLine: 3 });
    expect(result).toEqual({ ok: true, text: nested.replace('return 1', 'return 9') });
  });

  it('picks the block that resembles the selection, not the usage example', () => {
    const text = `Run this:\n\`\`\`bash\nFLASK_DEBUG=off python app.py\n\`\`\`\nThe code:\n${answer(NEW_FUNCTION)}`;
    const result = replacementFromText(text, FILE, SELECTION);
    expect(result.ok && result.text).toContain('"nope", "nah"');
    expect(result.ok && result.text).not.toContain('python app.py');
  });

  it('uses a whole-file answer as the whole file rather than nesting it', () => {
    const whole = FILE.replace('"no"}', '"no", "nope"}');
    const result = replacementFromText(answer(whole.trimEnd()), FILE, SELECTION);
    expect(result).toEqual({ ok: true, text: whole });
  });

  it.each([
    ['no code block', 'I cannot do that.', /no code block/],
    ['a diff', answer('-    x\n+    y', 'diff'), /only a diff/],
    ['an unmarked diff', answer('-    return 1\n+    return 2', ''), /only a diff/],
    ['unrelated code', answer('print("hello world")'), /resembles/],
  ])('refuses %s', (_name, text, reason) => {
    const result = replacementFromText(text, FILE, SELECTION);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(reason);
  });
});

describe('mentions', () => {
  it('needs the prefix, so an email address is not a mention', () => {
    expect(parseMentions('see @file:src/a.py and @symbol:get_flag. Mail me@file.com or @other')).toEqual([
      { kind: 'file', name: 'src/a.py' },
      { kind: 'symbol', name: 'get_flag' },
    ]);
    expect(parseMentions('@file:a.py @file:a.py')).toHaveLength(1);
  });

  describe('against a workspace', () => {
    let dir: string;
    let port: NodeEditorPort;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'forgelens mentions '));
      writeFileSync(path.join(dir, 'a.py'), 'def alpha():\n    return 1\n\nclass Beta:\n    pass\n');
      writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MENTION_MAX_CHARS + 500));
      port = new NodeEditorPort(dir);
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('resolves files and symbols, caps size and reports what is missing', async () => {
      const [file, symbol, big, missing] = await resolveMentions(port, [
        { kind: 'file', name: 'a.py' },
        { kind: 'symbol', name: 'alpha' },
        { kind: 'file', name: 'big.txt' },
        { kind: 'file', name: 'nope.py' },
      ]);
      expect(file).toMatchObject({ found: true, label: 'file a.py' });
      expect(file?.text).toContain('def alpha');
      expect(symbol?.text).toContain('a.py');
      expect(big?.text.length).toBeLessThan(MENTION_MAX_CHARS + 100);
      expect(big?.text).toContain('[shortened');
      expect(missing).toMatchObject({ found: false });
    });

    it('offers files and top-level symbols to the picker', async () => {
      const candidates = await mentionCandidates(port);
      expect(candidates).toContainEqual({ kind: 'file', name: 'a.py', detail: '' });
      expect(candidates).toContainEqual({ kind: 'symbol', name: 'alpha', detail: 'a.py:1' });
      expect(candidates).toContainEqual({ kind: 'symbol', name: 'Beta', detail: 'a.py:4' });
    });
  });
});

describe('finishInlineEdit', () => {
  let dir: string;
  let flow: ReviewFlow;
  let logged: string[];
  const file = 'src/h.py';
  const target: InlineTarget = { path: file, ...SELECTION, language: 'python', instruction: 'x' };
  const onDisk = (): string => readFileSync(path.join(dir, file), 'utf8');
  const run = (output: string, signal = new AbortController().signal, reviewsAtStart = 0): Promise<string | undefined> =>
    finishInlineEdit({ flow, target, output, reviewsAtStart, signal, log: (message) => logged.push(message) });
  const codeAnswer = `\`\`\`python\n${NEW_FUNCTION}\n\`\`\``;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'forgelens finish '));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, file), FILE);
    flow = new ReviewFlow(new NodeEditorPort(dir));
    logged = [];
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does nothing when the agent already went through a review', async () => {
    await expect(run(codeAnswer, undefined, -1)).resolves.toBeUndefined();
    expect(flow.isReviewing).toBe(false);
    expect(logged).toEqual([]);
  });

  it('a plain-text answer opens the same review, says so, and applies only on accept', async () => {
    const finishing = run(codeAnswer);
    await vi.waitFor(() => expect(flow.isReviewing).toBe(true));
    expect(onDisk()).toBe(FILE);
    expect(logged[0]).toContain('Inline fallback used');
    flow.setAll('accepted');
    await flow.applyDecisions();
    await expect(finishing).resolves.toBeUndefined();
    expect(onDisk()).toContain('"nope", "nah"');
    expect(flow.canUndo).toBe(true);
    await flow.undoLast();
    expect(onDisk()).toBe(FILE);
  });

  it('a rejected fallback writes nothing', async () => {
    const finishing = run(codeAnswer);
    await vi.waitFor(() => expect(flow.isReviewing).toBe(true));
    flow.setAll('rejected');
    await flow.applyDecisions();
    await finishing;
    expect(onDisk()).toBe(FILE);
  });

  it('a model that staged but never applied still reaches the review', async () => {
    await stageEditTool(flow.changeset, dir, { path: file, edits: [{ old_text: 'import os', new_text: 'import os  # used' }] });
    const finishing = run('All done!');
    await vi.waitFor(() => expect(flow.isReviewing).toBe(true));
    expect(logged[0]).toContain('stopped before asking for review');
    flow.setAll('accepted');
    await flow.applyDecisions();
    await finishing;
    expect(onDisk()).toContain('# used');
  });

  it('explains when there is nothing to propose', async () => {
    await expect(run('I would rather not.')).resolves.toContain('no code block');
    expect(flow.isReviewing).toBe(false);
    expect(onDisk()).toBe(FILE);
  });

  it('says so when the code came back unchanged', async () => {
    const same = `\`\`\`python\n${readSelection(FILE, SELECTION).selected}\`\`\``;
    await expect(run(same)).resolves.toContain('unchanged');
  });

  it('Stop during the fallback review discards it and writes nothing', async () => {
    const stop = new AbortController();
    const finishing = run(codeAnswer, stop.signal);
    await vi.waitFor(() => expect(flow.isReviewing).toBe(true));
    flow.setAll('accepted');
    stop.abort();
    await finishing;
    expect(flow.isReviewing).toBe(false);
    expect(flow.changeset.isEmpty).toBe(true);
    expect(onDisk()).toBe(FILE);
  });

  it('does nothing if already stopped', async () => {
    const stop = new AbortController();
    stop.abort();
    await run(codeAnswer, stop.signal);
    expect(flow.isReviewing).toBe(false);
  });
});
