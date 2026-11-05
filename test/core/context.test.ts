import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentPrompt } from '../../src/core/context/agentPrompt';
import { chunkFile } from '../../src/core/context/chunker';
import { ContextEngine, ContextIndex, indexFile, type IndexStore } from '../../src/core/context/engine';
import { buildPack, formatPack } from '../../src/core/context/packer';
import { buildModuleMap, isChangelog, isDocFile, isTestFile, moduleStem, pairedFiles, parsePythonImports, resolveImports } from '../../src/core/context/relations';
import { retrieve } from '../../src/core/context/retrieve';
import { pathTokens, splitIdentifier, stem, tokenize } from '../../src/core/context/tokenize';
import { NodeEditorPort } from '../../src/core/tools/nodeEditorPort';
import { repoMapTool } from '../../src/core/tools/workspaceViews';

const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
const FLASK = path.resolve(__dirname, '../../../flask');
const hasFlask = (() => {
  try {
    return statSync(path.join(FLASK, 'src/flask/cli.py')).isFile();
  } catch {
    return false;
  }
})();

const STAT = { mtimeMs: 1, size: 1 };

async function indexOf(files: Record<string, string>): Promise<ContextIndex> {
  const index = new ContextIndex();
  for (const [file, text] of Object.entries(files)) index.files.set(file, indexFile(file, text, STAT));
  await index.rebuildSearch();
  return index;
}

describe('identifier splitting', () => {
  it.each([
    ['get_debug_flag', ['get', 'debug', 'flag']],
    ['FlaskGroup', ['flask', 'group']],
    ['HTTPServer', ['http', 'server']],
    ['parseURL2Path', ['parse', 'url2', 'path']],
    ['kebab-case-name', ['kebab', 'case', 'name']],
    ['SECRET_KEY', ['secret', 'key']],
  ])('splits %s', (input, expected) => {
    expect(splitIdentifier(input)).toEqual(expected);
  });

  it('keeps the whole identifier as well as its parts, and drops stop words', () => {
    const tokens = tokenize('The get_debug_flag function');
    expect(tokens).toContain('debug');
    expect(tokens).toContain('flag');
    expect(tokens).toContain('get_debug_flag');
    expect(tokens).not.toContain('the');
  });

  it('treats forms of a word as one word', () => {
    expect(stem('commands')).toBe('command');
    expect(stem('masking')).toBe('mask');
    expect(stem('configuration')).toBe('config');
    expect(stem('documented')).toBe('doc');
    expect(stem('class')).toBe('class');
    expect(stem('status')).toBe('status');
  });

  it('reads words from paths, without the extension', () => {
    expect(pathTokens('src/flask/test_cli.py')).toEqual(expect.arrayContaining(['src', 'flask', 'test', 'cli']));
    expect(pathTokens('src/flask/test_cli.py')).not.toContain('py');
  });
});

describe('chunking', () => {
  const python = [
    '"""Module docs."""',
    'import os',
    '',
    'LIMIT = 3',
    '',
    '',
    '@decorator',
    'def first(',
    '    a,',
    '):',
    '    return a',
    '',
    '',
    'class Thing:',
    '    """A thing."""',
    '    size = 1',
    '',
    '    def one(self):',
    '        return 1',
    '',
    '    @property',
    '    async def two(self):',
    '        return 2',
    '',
    '',
    'AFTER = 4',
  ].join('\n');

  it('splits Python into module code, functions, a class and its methods', () => {
    expect(chunkFile('a.py', python)).toEqual([
      { startLine: 1, endLine: 4, kind: 'module' },
      { startLine: 7, endLine: 11, kind: 'function', name: 'first' },
      { startLine: 14, endLine: 16, kind: 'class', name: 'Thing' },
      { startLine: 18, endLine: 19, kind: 'method', name: 'Thing.one' },
      { startLine: 21, endLine: 23, kind: 'method', name: 'Thing.two' },
      { startLine: 26, endLine: 26, kind: 'module' },
    ]);
  });

  it('keeps a class with no methods whole', () => {
    expect(chunkFile('a.py', 'class A:\n    x = 1\n    y = 2\n')).toEqual([{ startLine: 1, endLine: 3, kind: 'class', name: 'A' }]);
  });

  it('uses overlapping windows for other files, and skips blank ones', () => {
    const text = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkFile('a.rst', text);
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([[1, 60], [51, 110], [101, 120]]);
    expect(chunkFile('a.txt', '\n\n\n')).toEqual([]);
  });
});

describe('imports and pairing', () => {
  it('parses every import form', () => {
    const raw = parsePythonImports('import os, sys as s\nfrom .globals import a, b as c\nfrom . import app\nfrom ..x.y import (\n    z,\n)\n');
    expect(raw).toEqual(expect.arrayContaining(['os', 'sys', '.globals', '.globals.a', '.', '.app', '..x.y']));
  });

  it('resolves relative and absolute imports to workspace files, and ignores the rest', () => {
    const modules = buildModuleMap(['src/flask/cli.py', 'src/flask/globals.py', 'src/flask/__init__.py', 'tests/test_cli.py']);
    expect(resolveImports('src/flask/cli.py', ['.globals', 'os', 'click'], modules)).toEqual(['src/flask/globals.py']);
    expect(resolveImports('tests/test_cli.py', ['flask.cli', 'flask'], modules).sort()).toEqual(['src/flask/__init__.py', 'src/flask/cli.py']);
    expect(resolveImports('src/flask/__init__.py', ['.cli'], modules)).toEqual(['src/flask/cli.py']);
  });

  it('classifies files', () => {
    expect(isTestFile('tests/test_cli.py')).toBe(true);
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('src/flask/testing.py')).toBe(false);
    expect(isDocFile('docs/cli.rst')).toBe(true);
    expect(isChangelog('CHANGES.rst')).toBe(true);
    expect(moduleStem('tests/test_cli.py')).toBe('cli');
  });

  it('pairs code with its test and doc, in both directions', () => {
    const all = ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst', 'src/flask/app.py', 'CHANGES.rst'];
    expect(pairedFiles('src/flask/cli.py', all)).toEqual([
      { path: 'tests/test_cli.py', relation: 'test' },
      { path: 'docs/cli.rst', relation: 'doc' },
    ]);
    expect(pairedFiles('tests/test_cli.py', all)).toContainEqual({ path: 'src/flask/cli.py', relation: 'code' });
    expect(pairedFiles('src/flask/app.py', all)).toEqual([]);
    expect(pairedFiles('__init__.py', ['__init__.py', 'a/__init__.py'])).toEqual([]);
  });
});

describe('BM25', () => {
  it('prefers rarer words and shorter chunks', async () => {
    const index = await indexOf({
      'a.py': 'def alpha():\n    return common + rare_word\n',
      'b.py': 'def beta():\n    return common\n',
      'c.py': `def gamma():\n    return common\n    ${'filler '.repeat(200)}\n`,
    });
    const scores = index.scoreChunks(tokenize('rare word common'));
    const best = (file: string): number => scores.get(file)?.[0]?.score ?? 0;
    expect(best('a.py')).toBeGreaterThan(best('b.py'));
    expect(best('b.py')).toBeGreaterThan(best('c.py'));
  });

  it('finds a snake_case name from its separate words', async () => {
    const index = await indexOf({ 'a.py': 'def get_debug_flag():\n    pass\n', 'b.py': 'def other():\n    pass\n' });
    expect([...index.scoreChunks(tokenize('debug flag')).keys()]).toEqual(['a.py']);
  });
});

describe('retrieve', () => {
  const files = {
    'src/pkg/cli.py': 'from .core import run\n\ndef command_list():\n    """List commands."""\n    return run()\n',
    'src/pkg/core.py': 'def run():\n    return 1\n',
    'src/pkg/other.py': 'def unrelated():\n    return 2\n',
    'tests/test_cli.py': 'from pkg.cli import command_list\n\ndef test_it():\n    assert command_list()\n',
    'docs/cli.rst': 'Commands\n========\n\nHow to use it.\n',
    'docs/usage.rst': 'Call command_list from your code.\n',
    'CHANGES.rst': 'Version 1\n---------\n\nFirst release.\n',
  };

  it('finds the file, then its test, its doc and what it imports, each with a reason', async () => {
    const items = retrieve(await indexOf(files), 'the cli command list');
    const byPath = new Map(items.map((item) => [item.path, item]));
    expect(items[0]?.path).toBe('src/pkg/cli.py');
    expect(byPath.get('tests/test_cli.py')?.reason).toContain('test pair of src/pkg/cli.py');
    expect(byPath.get('docs/cli.rst')?.reason).toContain('documents src/pkg/cli.py');
    expect(byPath.get('src/pkg/core.py')?.reason).toContain('imported by src/pkg/cli.py');
    expect(byPath.get('docs/usage.rst')?.reason).toContain('mentions command_list');
    expect(byPath.get('src/pkg/cli.py')?.reason).toContain('defines command_list');
    expect(byPath.has('src/pkg/other.py')).toBe(false);
  });

  it('adds the changelog only for a change, and says why', async () => {
    const index = await indexOf(files);
    expect(retrieve(index, 'how does the cli command list work').map((item) => item.path)).not.toContain('CHANGES.rst');
    const item = retrieve(index, 'add a new cli command').find((candidate) => candidate.path === 'CHANGES.rst');
    expect(item?.reason).toContain('changelog');
  });

  it('forces mentions to the top, even with no matching word', async () => {
    const items = retrieve(await indexOf(files), 'the cli command list', { mentionedFiles: ['src/pkg/other.py'] });
    expect(items[0]).toMatchObject({ path: 'src/pkg/other.py', mentioned: true });
    expect(items[0]?.reason).toContain('mentioned by you');
  });

  it('lifts open editors and says so', async () => {
    const index = await indexOf(files);
    const plain = retrieve(index, 'run').find((item) => item.path === 'src/pkg/core.py')?.score ?? 0;
    const item = retrieve(index, 'run', { activeFile: 'src/pkg/core.py', openFiles: ['src/pkg/core.py'] }).find((candidate) => candidate.path === 'src/pkg/core.py');
    expect(item?.score).toBeGreaterThan(plain);
    expect(item?.reason).toContain('open in the editor');
  });

  it('uses the selection as part of the question', async () => {
    const items = retrieve(await indexOf(files), 'what does this do', { selection: 'def unrelated():' });
    expect(items[0]?.path).toBe('src/pkg/other.py');
  });

  it('returns nothing for a query with no useful words', async () => {
    expect(retrieve(await indexOf(files), 'is the of')).toEqual([]);
  });
});

describe('budget packer', () => {
  const big = (name: string): string => `def ${name}():\n${Array.from({ length: 400 }, (_, i) => `    x${i} = ${name}_${i}`).join('\n')}\n`;
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) files[`src/mod${i}.py`] = `${big(`shared_word_a${i}`)}\n${big(`shared_word_b${i}`)}`;
  const read = (file: string): Promise<string> => (files[file] === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(files[file] as string));

  it('stays within budget, moving from full to skeleton to listed, and records what it dropped', async () => {
    const index = await indexOf(files);
    const ranked = retrieve(index, 'shared word', { limit: 40 });
    const pack = await buildPack(index, ranked, read, { budgetTokens: 6000 });
    expect(pack.usedTokens).toBeLessThanOrEqual(6000);
    const modes = new Set(pack.items.map((item) => item.mode));
    expect(modes.has('full')).toBe(true);
    expect(modes.has('skeleton')).toBe(true);
    expect(modes.has('listed')).toBe(true);
    expect(pack.dropped.length).toBeGreaterThan(0);
    expect(pack.dropped[0]?.why).toBe('over budget');
    const order = pack.items.map((item) => item.mode);
    expect(order.indexOf('full')).toBeLessThan(order.indexOf('skeleton'));
    expect(order.indexOf('skeleton')).toBeLessThan(order.indexOf('listed'));
    expect(pack.items.find((item) => item.mode === 'listed')?.content).toBe('');
  });

  it('one file cannot take over the pack', async () => {
    const index = await indexOf(files);
    const pack = await buildPack(index, retrieve(index, 'shared word'), read, { budgetTokens: 6000 });
    for (const item of pack.items) expect(item.tokens).toBeLessThanOrEqual(6000 * 0.35 + 100);
  });

  it('never drops a mention, and cuts a huge one to the cap', async () => {
    const index = await indexOf(files);
    const ranked = retrieve(index, 'shared word', { mentionedFiles: ['src/mod7.py'] });
    const pack = await buildPack(index, ranked, read, { budgetTokens: 500 });
    expect(pack.items[0]).toMatchObject({ path: 'src/mod7.py', mentioned: true, mode: 'full' });
    expect(pack.items[0]?.content).toContain('[shortened');
    expect(pack.items[0]?.tokens).toBeLessThan(2200);
  });

  it('reports a mention it cannot read', async () => {
    const index = await indexOf(files);
    const pack = await buildPack(index, [{ path: 'gone.py', score: 1, reason: 'mentioned by you', mentioned: true, chunks: [] }], read);
    expect(pack.dropped).toEqual([{ path: 'gone.py', why: 'mentioned, but the file could not be read' }]);
  });

  it('formats a table the agent and a person can read, with line numbers for full text', async () => {
    const index = await indexOf(files);
    const pack = await buildPack(index, retrieve(index, 'shared word'), read, { budgetTokens: 3000 });
    const text = formatPack(pack);
    expect(text).toContain(`## Context Pack: ${pack.items.length} files, ${pack.usedTokens} of 3000 tokens`);
    expect(text).toContain('| File | Why | Tokens | Shown as |');
    expect(text).toMatch(/\| src\/mod\d+\.py \| .* \| \d+ \| full \|/);
    expect(text).toMatch(/1: def shared_word/);
    expect(text).toContain('Left out:');
  });

  it('escapes a table separator in a reason', async () => {
    const pack = { items: [{ path: 'a|b.py', reason: 'x | y', mode: 'listed' as const, mentioned: false, tokens: 3, content: '' }], dropped: [], usedTokens: 3, budgetTokens: 10 };
    expect(formatPack(pack)).toContain('| a\\|b.py | x \\| y | 3 | listed |');
  });
});

describe('ContextEngine', () => {
  let dir: string;
  let stored: string | undefined;
  let writes: number;
  const store: IndexStore = {
    read: () => Promise.resolve(stored),
    write: (text) => {
      stored = text;
      writes += 1;
      return Promise.resolve();
    },
  };
  const port = (): NodeEditorPort => new NodeEditorPort(dir);
  const write = (file: string, text: string): void => writeFileSync(path.join(dir, file), text);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'forgelens engine '));
    mkdirSync(path.join(dir, 'src'));
    write('src/alpha.py', 'def alpha_thing():\n    return 1\n');
    write('src/beta.py', 'def beta_thing():\n    return 2\n');
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
    write('huge.txt', `alpha_thing ${'x'.repeat(1_100_000)}`);
    write('uv.lock', 'alpha_thing');
    stored = undefined;
    writes = 0;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('skips binary, huge and lock files, and logs what it did', async () => {
    const logged: string[] = [];
    const engine = new ContextEngine(port(), { log: (message) => logged.push(message) });
    const stats = await engine.ensureBuilt();
    expect(engine.index.paths.sort()).toEqual(['src/alpha.py', 'src/beta.py']);
    expect(stats.files).toBe(2);
    expect(logged[0]).toMatch(/Indexed 2 files, \d+ chunks, 2 symbols in \d+ ms \(\d+ KB, 0 files reused\)/);
  });

  it('builds once, however many ask at the same time', async () => {
    const engine = new ContextEngine(port());
    const [first, second] = await Promise.all([engine.ensureBuilt(), engine.ensureBuilt()]);
    expect(first).toBe(second);
  });

  it('writes the index only to its store, never into the workspace', async () => {
    const before = (await port().listFiles()).sort();
    const engine = new ContextEngine(port(), { store });
    await engine.ensureBuilt();
    expect(writes).toBe(1);
    expect(stored).toContain('alpha_thing');
    expect((await port().listFiles()).sort()).toEqual(before);
  });

  it('reuses stored files whose size and time match, and re-reads the rest', async () => {
    await new ContextEngine(port(), { store }).ensureBuilt();
    const again = await new ContextEngine(port(), { store }).ensureBuilt();
    expect(again.reused).toBe(2);
    write('src/beta.py', 'def beta_changed_now():\n    return 22\n');
    const engine = new ContextEngine(port(), { store });
    const third = await engine.ensureBuilt();
    expect(third.reused).toBe(1);
    expect(engine.index.files.get('src/beta.py')?.symbols[0]?.name).toBe('beta_changed_now');
  });

  it('survives a damaged or old index by rebuilding', async () => {
    stored = 'not json';
    expect((await new ContextEngine(port(), { store }).ensureBuilt()).files).toBe(2);
    stored = JSON.stringify({ version: -1, files: [] });
    expect((await new ContextEngine(port(), { store }).ensureBuilt()).reused).toBe(0);
  });

  it('updates on save, including new and deleted files', async () => {
    const engine = new ContextEngine(port());
    await engine.ensureBuilt();
    write('src/alpha.py', 'def gamma_replacement():\n    return 3\n');
    write('src/delta.py', 'def delta_thing():\n    return 4\n');
    await engine.noteFileChanged('src/alpha.py');
    await engine.noteFileChanged('src/delta.py');
    expect((await engine.retrieve('gamma replacement'))[0]?.path).toBe('src/alpha.py');
    expect((await engine.retrieve('delta thing'))[0]?.path).toBe('src/delta.py');
    expect(engine.index.files.get('src/alpha.py')?.symbols.map((symbol) => symbol.name)).toEqual(['gamma_replacement']);
    expect(engine.index.postings.has('alpha_thing')).toBe(false);
    rmSync(path.join(dir, 'src/delta.py'));
    await engine.noteFileChanged('src/delta.py');
    expect((await engine.retrieve('delta thing')).map((item) => item.path)).not.toContain('src/delta.py');
  });

  it('ignores saves before the first build', async () => {
    const engine = new ContextEngine(port());
    await engine.noteFileChanged('src/alpha.py');
    expect(engine.index.paths).toEqual([]);
  });

  it('yields while building, so the editor is not blocked', async () => {
    for (let i = 0; i < 150; i += 1) write(`src/gen${i}.py`, `def gen_${i}():\n${'    x = 1\n'.repeat(300)}`);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    await new ContextEngine(port()).ensureBuilt();
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasFlask)('on the real flask repo, read-only', () => {
  const engine = new ContextEngine(new NodeEditorPort(FLASK));

  it('indexes it', async () => {
    const stats = await engine.ensureBuilt();
    expect(stats.files).toBeGreaterThan(100);
    expect(engine.index.files.get('src/flask/helpers.py')?.symbols.some((symbol) => symbol.name === 'get_debug_flag')).toBe(true);
    expect(engine.index.imports.get('src/flask/cli.py')).toContain('src/flask/globals.py');
    expect([...engine.index.paths].some((file) => file.startsWith('.venv/'))).toBe(false);
  });

  it('ranks cli.py, test_cli.py and docs/cli.rst in the top 5 for the exact Task B instruction', async () => {
    const items = await engine.retrieve(TASK_B);
    const top5 = items.slice(0, 5).map((item) => item.path);
    expect(top5).toEqual(expect.arrayContaining(['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']));
  });

  it('packs Task B within the 6k default, with cli.py shown in full and a reason for every file', async () => {
    const pack = await engine.pack(TASK_B);
    expect(pack.budgetTokens).toBe(6_000);
    expect(pack.usedTokens).toBeLessThanOrEqual(6_000);
    expect(pack.items.find((item) => item.path === 'src/flask/cli.py')?.mode).toBe('full');
    for (const expected of ['tests/test_cli.py', 'docs/cli.rst']) expect(pack.items.map((item) => item.path)).toContain(expected);
    for (const item of pack.items) expect(item.reason.length).toBeGreaterThan(5);
    expect(formatPack(pack)).toContain('routes_command');
  });

  it('brings the place that registers the shown command into the Task B pack', async () => {
    const text = formatPack(await engine.pack(TASK_B));
    expect(text).toMatch(/\d+: +self\.add_command\(routes_command\)/);
  });

  it('keeps docs held only by a side hit off the card for a question about get_debug_flag', async () => {
    const paths = (await engine.retrieve('where is get_debug_flag defined')).map((item) => item.path);
    expect(paths[0]).toBe('src/flask/helpers.py');
    expect(paths).toContain('tests/test_helpers.py');
    expect(paths).not.toContain('docs/cli.rst');
  });

  it('finds helpers.py first for the Task A question', async () => {
    expect((await engine.retrieve('where is get_debug_flag defined'))[0]?.path).toBe('src/flask/helpers.py');
  });
});

describe('buildAgentPrompt', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'forgelens prompt '));
    writeFileSync(path.join(dir, 'alpha.py'), 'def alpha_handler():\n    return 1\n');
    writeFileSync(path.join(dir, 'beta.py'), 'def beta_handler():\n    return 2\n');
    writeFileSync(path.join(dir, 'gamma.py'), 'def gamma_other():\n    return 3\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('puts the pack ahead of the request and fills the card', async () => {
    const { prompt, card } = await buildAgentPrompt(new ContextEngine(new NodeEditorPort(dir)), 'change alpha handler', { budgetTokens: 2000 });
    expect(prompt.indexOf('## Context Pack')).toBeLessThan(prompt.indexOf('## Request'));
    expect(prompt.endsWith('## Request\nchange alpha handler')).toBe(true);
    expect(card.budgetTokens).toBe(2000);
    expect(card.items[0]).toMatchObject({ path: 'alpha.py', mode: 'full', mentioned: false });
    expect(card.items[0]?.reason.length).toBeGreaterThan(5);
    expect(card.files).toBe(card.items.length);
  });

  it('forces @file and @symbol in, labels them, and reports what it cannot find', async () => {
    const { prompt, card } = await buildAgentPrompt(new ContextEngine(new NodeEditorPort(dir)), 'change alpha handler @file:gamma.py @symbol:beta_handler @file:nope.py @symbol:nothing');
    const mentioned = card.items.filter((item) => item.mentioned);
    expect(mentioned.map((item) => item.path).sort()).toEqual(['beta.py', 'gamma.py']);
    expect(mentioned[0]?.reason).toContain('mentioned by you');
    expect(card.notFound).toEqual(['nope.py', 'nothing']);
    expect(prompt).toContain('Mentioned but not found in the workspace: nope.py, nothing.');
    expect(prompt).toContain('def gamma_other');
  });
});

describe('syncFileList', () => {
  it('finds created files and forgets deleted ones', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forgelens list '));
    try {
      writeFileSync(path.join(dir, 'one.py'), 'def one():\n    pass\n');
      writeFileSync(path.join(dir, 'two.py'), 'def two():\n    pass\n');
      const engine = new ContextEngine(new NodeEditorPort(dir));
      await engine.ensureBuilt();
      rmSync(path.join(dir, 'one.py'));
      writeFileSync(path.join(dir, 'three.py'), 'def three():\n    pass\n');
      await engine.syncFileList();
      expect(engine.index.paths.sort()).toEqual(['three.py', 'two.py']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('repo map from the index', () => {
  it('uses the symbols it is given rather than reading files', async () => {
    let reads = 0;
    const port = {
      workspaceRoot: '/ws',
      readTextFile: () => {
        reads += 1;
        return Promise.resolve('');
      },
      listFiles: () => Promise.resolve(['a.py']),
      getDiagnostics: () => Promise.resolve([]),
    };
    const out = await repoMapTool(port, {}, new Map([['a.py', [{ kind: 'function', line: 3, signature: 'def alpha()' }]]]));
    expect(out).toContain('3: def alpha()');
    expect(reads).toBe(0);
  });
});

describe('reason text', () => {
  it('names what code defines, and does not repeat a file', async () => {
    const index = await indexOf({
      'src/pkg/cli.py': 'from .core import run\n\ndef command_list():\n    return run()\n',
      'src/pkg/core.py': 'def run():\n    return 1\n',
      'tests/test_cli.py': 'from pkg.cli import command_list\n\ndef test_command_list_works():\n    assert command_list()\n',
      'docs/cli.rst': 'Commands\n========\n\nCall command_list from your code.\n',
    });
    const items = new Map(retrieve(index, 'the cli command list').map((item) => [item.path, item.reason]));
    expect(items.get('src/pkg/cli.py')).toContain('defines command_list');
    expect(items.get('src/pkg/cli.py')).not.toContain('the code');
    expect(items.get('tests/test_cli.py')).toContain('test pair of src/pkg/cli.py');
    expect(items.get('tests/test_cli.py')).not.toContain('imports src/pkg/cli.py');
    expect(items.get('tests/test_cli.py')).not.toContain('test_command_list_works');
    expect(items.get('docs/cli.rst')).toContain('documents src/pkg/cli.py');
    expect(items.get('docs/cli.rst')).not.toContain('mentions');
  });
});

describe('weak links', () => {
  it('drops a doc held only by a weak mention, and keeps one with a strong link or its own match', async () => {
    const index = await indexOf({
      'src/pkg/helpers.py': 'def get_debug_flag():\n    return debug_flag_value\n',
      'src/pkg/app.py': 'from .helpers import get_debug_flag\n\ndef register_blueprint_here():\n    return get_debug_flag()\n',
      'docs/cli.rst': 'Command Line\n============\n\nUse register_blueprint_here to add commands.\n',
      'docs/helpers.rst': 'Helpers\n=======\n\nget_debug_flag reads the flag.\n',
      'docs/debugging.rst': 'Debugging\n=========\n\nThe debug flag turns on the debugger. Debug mode shows a flag.\n',
    });
    const paths = retrieve(index, 'where is the debug flag defined').map((item) => item.path);
    expect(paths).toContain('src/pkg/helpers.py');
    expect(paths).toContain('docs/helpers.rst');
    expect(paths).toContain('docs/debugging.rst');
    expect(paths).not.toContain('docs/cli.rst');
  });
});

describe('pack defaults', () => {
  it('uses 6k tokens by default and keeps the outline short', async () => {
    const big = Array.from({ length: 40 }, (_, i) => `def helper_${i}():\n    return shared_word\n\n`).join('');
    const index = await indexOf({ 'src/many.py': big });
    const pack = await buildPack(index, retrieve(index, 'shared word'), () => Promise.resolve(big));
    expect(pack.budgetTokens).toBe(6000);
    const content = pack.items[0]?.content ?? '';
    expect(content).toMatch(/\[\d+ more definitions\]/);
    expect(content.split('\n').filter((line) => /^\d+: def helper_/.test(line)).length).toBeLessThan(25);
  });
});
