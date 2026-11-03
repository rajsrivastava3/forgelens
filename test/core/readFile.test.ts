import { describe, expect, it } from 'vitest';
import type { EditorPort } from '../../src/core/tools/editorPort';
import { resolveInsideWorkspace } from '../../src/core/tools/nodeEditorPort';
import { READ_FILE_MAX_LINES, readFileTool } from '../../src/core/tools/readFile';

const portWith = (text: string): EditorPort => ({
  workspaceRoot: '/ws',
  readTextFile: () => Promise.resolve(text),
  listFiles: () => Promise.resolve([]),
  getDiagnostics: () => Promise.resolve([]),
});

describe('readFileTool', () => {
  it('numbers lines, handling CRLF and a final newline', async () => {
    const out = await readFileTool(portWith('a\r\nb\r\n'), { path: 'x.py' });
    expect(out).toBe('x.py (lines 1-2 of 2)\n1: a\n2: b');
  });

  it('honours a line range', async () => {
    const out = await readFileTool(portWith('a\nb\nc\nd\n'), {
      path: 'x.py',
      start_line: 2,
      end_line: 3,
    });
    expect(out).toBe('x.py (lines 2-3 of 4)\n2: b\n3: c');
  });

  it('caps long files and says how to continue', async () => {
    const text = Array.from({ length: READ_FILE_MAX_LINES + 5 }, (_, i) => `l${i}`).join('\n');
    const out = await readFileTool(portWith(text), { path: 'x.py' });
    expect(out).toContain(`[truncated: call again with start_line=${READ_FILE_MAX_LINES + 1}`);
  });

  it('caps a file of very long lines by characters', async () => {
    const text = Array.from({ length: 50 }, () => 'x'.repeat(2000)).join('\n');
    const out = await readFileTool(portWith(text), { path: 'x.py' });
    expect(out.length).toBeLessThan(25_000);
    expect(out).toContain('[truncated: output exceeded');
  });
});

describe('resolveInsideWorkspace', () => {
  it('allows paths inside the workspace', () => {
    expect(resolveInsideWorkspace('/ws', 'src/a.py')).toContain('a.py');
  });

  it.each(['../secret', 'src/../../secret', '/etc/passwd'])('rejects %s', (p) => {
    expect(() => resolveInsideWorkspace('/ws', p)).toThrow(/outside the workspace/);
  });
});
