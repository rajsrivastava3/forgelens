import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditorPort } from '../../src/core/tools/editorPort';
import { NodeEditorPort, retryWhileLocked } from '../../src/core/tools/nodeEditorPort';
import { capText, globToRegExp, MAX_TOOL_OUTPUT_CHARS } from '../../src/core/tools/output';
import { ContextEngine } from '../../src/core/context/engine';
import { retrieveContextTool } from '../../src/core/tools/retrieveContext';
import { searchCodeTool } from '../../src/core/tools/searchCode';
import { extractSymbols, findReferencesTool, findSymbolTool } from '../../src/core/tools/symbols';
import { getDiagnosticsTool, listDirTool, repoMapTool } from '../../src/core/tools/workspaceViews';

const FILES: Record<string, string> = {
  'src/app/helpers.py': [
    'DEBUG_VALUES = ("0", "off")',
    '',
    'def get_flag(',
    '    name: str,',
    ') -> bool:',
    '    """Read a flag.',
    '',
    '    More detail.',
    '    """',
    '    def inner():',
    '        return get_flag',
    '    return name not in DEBUG_VALUES',
    '',
    'class Loader:',
    '    """Loads things."""',
    '',
    '    def load(self):',
    '        return get_flag("x")',
    '',
    'def after_class():',
    '    return Loader()',
    '',
  ].join('\n'),
  'src/app/cli.py': 'from .helpers import get_flag\n\ndef command():\n    return get_flag("cli")\n',
  'tests/test_helpers.py': 'def test_get_flag():\n    assert GET_FLAG_MARKER\n',
  'docs/cli.rst': 'Built-in commands\n=================\n',
  'logo.png': 'not really an image',
};

const port: EditorPort = {
  workspaceRoot: '/ws',
  readTextFile: (p) => {
    const text = FILES[p];
    return text === undefined ? Promise.reject(new Error(`missing ${p}`)) : Promise.resolve(text);
  },
  listFiles: () => Promise.resolve(Object.keys(FILES)),
  getDiagnostics: (p) =>
    Promise.resolve(
      p === 'clean.py' ? [] : [{ path: 'src/app/cli.py', line: 3, severity: 'error', message: 'bad', source: 'pylance' }],
    ),
};

describe('capText', () => {
  it('leaves short text alone and truncates long text with a hint', () => {
    expect(capText('short', 'hint')).toBe('short');
    const capped = capText(`${'x\n'.repeat(MAX_TOOL_OUTPUT_CHARS)}`, 'Try less.');
    expect(capped.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 100);
    expect(capped).toContain('Try less.');
  });
});

describe('globToRegExp', () => {
  it.each([
    ['tests/**/*.py', 'tests/test_a.py', true],
    ['tests/**/*.py', 'tests/sub/deep/test_a.py', true],
    ['tests/**/*.py', 'src/a.py', false],
    ['*.py', 'a.py', true],
    ['*.py', 'src/a.py', false],
    ['src/?.py', 'src/a.py', true],
  ])('%s against %s is %s', (glob, file, expected) => {
    expect(globToRegExp(glob).test(file)).toBe(expected);
  });
});

describe('searchCodeTool', () => {
  it('returns path:line matches and skips binary files', async () => {
    const out = await searchCodeTool(port, { query: 'get_flag' });
    expect(out).toContain('src/app/cli.py:1: from .helpers import get_flag');
    expect(out).not.toContain('logo.png');
  });

  it('uses smart case', async () => {
    expect(await searchCodeTool(port, { query: 'get_flag_marker' })).toContain('tests/test_helpers.py:2');
    expect(await searchCodeTool(port, { query: 'Get_Flag_Marker' })).toContain('No matches');
  });

  it('honours regex, path_glob and max_results', async () => {
    const regex = await searchCodeTool(port, { query: 'def \\w+\\(', regex: true, path_glob: 'src/app/cli.py' });
    expect(regex).toContain('1 match(es)');
    const limited = await searchCodeTool(port, { query: 'get_flag', max_results: 2 });
    expect(limited).toContain('[limited to 2 results');
  });

  it('explains an invalid regex', async () => {
    await expect(searchCodeTool(port, { query: '(', regex: true })).rejects.toThrow(/Invalid regular expression/);
  });
});

describe('extractSymbols', () => {
  const symbols = extractSymbols('src/app/helpers.py', FILES['src/app/helpers.py'] ?? '');

  it('finds top-level functions, classes, methods and constants', () => {
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'variable:DEBUG_VALUES',
      'function:get_flag',
      'class:Loader',
      'method:load',
      'function:after_class',
    ]);
  });

  it('joins a multi-line signature and reads the docstring', () => {
    const fn = symbols.find((s) => s.name === 'get_flag');
    expect(fn?.line).toBe(3);
    expect(fn?.signature).toBe('def get_flag( name: str, ) -> bool');
    expect(fn?.doc).toBe('Read a flag.');
  });

  it('handles TypeScript declarations', () => {
    const ts = extractSymbols('a.ts', 'export async function go() {}\nclass A {}\nexport const f = () => 1;\nconst N = 2;\n');
    expect(ts.map((s) => `${s.kind}:${s.name}`)).toEqual(['function:go', 'class:A', 'function:f', 'variable:N']);
  });
});

describe('findSymbolTool and findReferencesTool', () => {
  it('gives the definition with file and line', async () => {
    expect(await findSymbolTool(port, { name: 'get_flag' })).toContain('src/app/helpers.py:3 [function]');
  });

  it('offers similar names when there is no exact match', async () => {
    const out = await findSymbolTool(port, { name: 'flag' });
    expect(out).toContain('No exact match');
    expect(out).toContain('get_flag');
  });

  it('matches whole words, case-sensitively', async () => {
    const out = await findReferencesTool(port, { name: 'get_flag' });
    expect(out).toContain('src/app/cli.py:4');
    expect(out).not.toContain('GET_FLAG_MARKER');
    expect(out).not.toContain('test_get_flag');
  });
});

describe('workspace views', () => {
  it('lists a directory with counts', async () => {
    const out = await listDirTool(port, {});
    expect(out).toContain('src/ (2 files)');
    expect(out).toContain('logo.png');
    expect(await listDirTool(port, { path: 'nope' })).toContain('No files');
  });

  it('expands to the requested depth', async () => {
    expect(await listDirTool(port, { path: 'src', depth: 2 })).toContain('app/helpers.py');
  });

  it('stays inside the repo map budget and accounts for what it left out', async () => {
    const full = await repoMapTool(port, {});
    expect(full).toContain('def get_flag');
    const tiny = await repoMapTool(port, { budget_tokens: 12 });
    expect(tiny).toMatch(/~\d+ of 12 tokens/);
    expect(tiny).not.toContain('def get_flag');
    expect(tiny).toContain('omitted: over budget');
  });

  it('formats diagnostics', async () => {
    expect(await getDiagnosticsTool(port, {})).toBe('src/app/cli.py:3 error: bad (pylance)');
    expect(await getDiagnosticsTool(port, { path: 'clean.py' })).toBe('No diagnostics for clean.py.');
  });
});

describe('retrieveContextTool', () => {
  const engine = new ContextEngine(port);

  it('ranks by the index, with a reason per file and its usage against the budget', async () => {
    const out = await retrieveContextTool(engine, { query: 'where is the get_flag helper for config' });
    expect(out).toMatch(/Context Pack: \d+ files, \d+ of 4000 tokens/);
    expect(out).toContain('| File | Why | Tokens | Shown as |');
    expect(out).toContain('get_flag');
  });

  it('honours a small budget and caps a large one', async () => {
    expect(await retrieveContextTool(engine, { query: 'get_flag', budget_tokens: 150 })).toMatch(/of 150 tokens/);
    expect(await retrieveContextTool(engine, { query: 'get_flag', budget_tokens: 999_999 })).toMatch(/of 12000 tokens/);
  });

  it('says when a query has nothing to search for', async () => {
    expect(await retrieveContextTool(engine, { query: 'is the of' })).toContain('no searchable');
    expect(await retrieveContextTool(engine, { query: 'zzzqqq' })).toContain('No files match');
  });
});

const FLASK = path.resolve(__dirname, '../../../flask');
const hasFlask = (() => {
  try {
    return execFileSync('git', ['-C', FLASK, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).startsWith('22d92470');
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFlask)('on the real flask repo', () => {
  const flask = new NodeEditorPort(FLASK);

  it('excludes the virtual environment from listings', async () => {
    const files = await flask.listFiles();
    expect(files).toContain('src/flask/helpers.py');
    expect(files.some((f) => f.startsWith('.venv/'))).toBe(false);
  });

  it('finds get_debug_flag at line 28', async () => {
    expect(await findSymbolTool(flask, { name: 'get_debug_flag' })).toContain('src/flask/helpers.py:28 [function]');
  });

  it('keeps a repo map within budget', async () => {
    const out = await repoMapTool(flask, { budget_tokens: 1000 });
    expect(out).toMatch(/~\d+ of 1000 tokens/);
    expect(out.length).toBeLessThan(5000);
  });
});

describe('retryWhileLocked', () => {
  it('retries a brief Windows file lock, then succeeds', async () => {
    let calls = 0;
    const result = await retryWhileLocked(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error("EBUSY: resource busy or locked, open 'x'")) : Promise.resolve('done');
    }, [1, 1, 1]);
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('gives up on a lock that stays', async () => {
    await expect(retryWhileLocked(() => Promise.reject(new Error('EBUSY')), [1, 1])).rejects.toThrow('EBUSY');
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await expect(
      retryWhileLocked(() => {
        calls += 1;
        return Promise.reject(new Error('ENOENT'));
      }, [1, 1]),
    ).rejects.toThrow('ENOENT');
    expect(calls).toBe(1);
  });
});
