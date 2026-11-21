import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Changeset } from '../../src/core/changeset/changeset';
import { NodeEditorPort } from '../../src/core/tools/nodeEditorPort';
import { missingImportNote, missingImports } from '../../src/core/tools/pythonImports';
import { stageCreateFileTool, stageEditTool, stageReplaceLinesTool } from '../../src/core/tools/stageTools';

describe('missingImports', () => {
  it('finds a module used but never imported, as in the Task B runs', () => {
    const cli = 'import click\n\n@click.command("config")\ndef config_command():\n    click.echo(json.dumps({}, indent=2))\n';
    expect(missingImports('src/pkg/cli.py', cli)).toEqual(['json']);
    expect(missingImportNote('src/pkg/cli.py', cli)).toBe(
      'Note: src/pkg/cli.py uses json but never imports it, so the tests would fail with a NameError. Stage "import json" with the file\'s other imports before running the tests.',
    );
  });

  it('accepts every way the name can be bound', () => {
    for (const binding of ['import json', 'import json as json', 'from json import loads\nimport json', 'json = make()', 'def f(json):\n    pass', '    import json']) {
      expect(missingImports('a.py', `${binding}\nx = json.dumps(1)\n`)).toEqual([]);
    }
    expect(missingImports('a.py', 'import importlib.metadata\nv = importlib.metadata.version("x")\n')).toEqual([]);
  });

  it('ignores comments, strings, docstrings, attributes and other languages', () => {
    expect(missingImports('a.py', '"""Prints json.dumps of it."""\n# os.path is not used\ns = "re.sub"\n')).toEqual([]);
    expect(missingImports('a.py', 'self.json.dumps(1)\n')).toEqual([]);
    expect(missingImports('a.ts', 'JSON.stringify(json.x)\n')).toEqual([]);
  });

  it('names several at once', () => {
    expect(missingImportNote('t.py', 'def test():\n    os.getcwd()\n    json.loads("1")\n')).toContain('uses json, os but never imports them');
  });
});

describe('stage tools carry the note', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'forgelens imports '));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/cli.py'), 'import click\n\n\ndef main():\n    pass\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stage_edit, stage_create_file and stage_replace_lines', async () => {
    const changeset = new Changeset(new NodeEditorPort(dir));
    const edited = await stageEditTool(changeset, dir, { path: 'src/cli.py', edits: [{ old_text: '    pass\n', new_text: '    click.echo(json.dumps({}))\n' }] });
    expect(edited).toContain('Note: src/cli.py uses json but never imports it');
    const fixed = await stageEditTool(changeset, dir, { path: 'src/cli.py', edits: [{ old_text: 'import click\n', new_text: 'import json\n\nimport click\n' }] });
    expect(fixed).not.toContain('never imports');
    const created = await stageCreateFileTool(changeset, dir, { path: 'tests/test_new.py', content: 'def test_it():\n    assert json.loads("1") == 1\n' });
    expect(created).toContain('Note: tests/test_new.py uses json');
    const replaced = await stageReplaceLinesTool(changeset, dir, { path: 'tests/test_new.py', start_line: 1, end_line: 0, new_text: 'import json\n' });
    expect(replaced).not.toContain('never imports');
  });
});

const FLASK = path.resolve(__dirname, '../../../flask');
const flaskFiles = (() => {
  try {
    return execFileSync('git', ['-C', FLASK, 'ls-files', '*.py'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
})();

describe.skipIf(flaskFiles.length === 0)('on the real flask repo', () => {
  it('flags no file as it is', () => {
    const flagged = flaskFiles.filter((file) => missingImports(file, readFileSync(path.join(FLASK, file), 'utf8')).length > 0);
    expect(flagged).toEqual([]);
  });
});
