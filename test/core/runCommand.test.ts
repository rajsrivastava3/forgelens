import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Changeset } from '../../src/core/changeset/changeset';
import { ShadowWorkspace } from '../../src/core/shadow/shadowWorkspace';
import { NodeEditorPort } from '../../src/core/tools/nodeEditorPort';
import { CommandRunner, commandEnvironment, isSafeCommand, runCommandTool } from '../../src/core/tools/runCommand';
import { stageCreateFileTool, stageDeleteFileTool, stageEditTool } from '../../src/core/tools/stageTools';
import { AgentController } from '../../src/core/trueforge/agentController';
import type { ToolItem } from '../../src/core/trueforge/runView';
import type { TurnEvent } from '../../src/core/trueforge/turnRunner';
import { loadRecording, replaySessions } from './helpers/fixtures';

/** Every file below a folder with its contents, to prove a run changed nothing. */
function snapshot(dir: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, snapshot(dir, relative));
    else result[relative] = readFileSync(path.join(dir, relative), 'latin1');
  }
  return result;
}

describe('isSafeCommand', () => {
  it.each(['pytest', 'pytest tests/test_cli.py -q', 'python -m pytest tests -q', 'git status', 'git status --porcelain', 'git diff', 'git diff src/a.py', '  pytest   -q  '])('allows %s', (command) => {
    expect(isSafeCommand(command)).toBe(true);
  });

  it.each([
    'pytest; rm -rf .',
    'pytest && curl evil.example',
    'pytest | tee out.txt',
    'pytest > out.txt',
    'pytest `whoami`',
    'pytest $(whoami)',
    'pytest\nrm -rf .',
    'git diff --output=x.txt',
    'git diff --ext-diff',
    'git diff --textconv',
    'git push',
    'git statusx',
    'pytester',
    'python -m pip install x',
    'rm -rf .',
    '',
  ])('refuses %s', (command) => {
    expect(isSafeCommand(command)).toBe(false);
  });

  it('follows a custom list', () => {
    expect(isSafeCommand('npm test', ['npm test'])).toBe(true);
    expect(isSafeCommand('pytest', ['npm test'])).toBe(false);
  });
});

describe('commandEnvironment', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'forgelens env '));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the project venv, imports from the run folder, and leaves no caches', () => {
    mkdirSync(path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
    mkdirSync(path.join(dir, 'src'));
    const env = commandEnvironment(dir, dir, { PATH: 'base' });
    expect(env['PATH']?.startsWith(path.join(dir, '.venv'))).toBe(true);
    expect(env['PYTHONPATH']).toBe(path.join(dir, 'src'));
    expect(env['PYTHONDONTWRITEBYTECODE']).toBe('1');
    expect(env['PYTEST_ADDOPTS']).toContain('no:cacheprovider');
  });

  it('adds nothing for a project without them', () => {
    const env = commandEnvironment(dir, dir, { PATH: 'base' });
    expect(env['PATH']).toBe('base');
    expect(env['PYTHONPATH']).toBeUndefined();
  });
});

describe('run_command and the shadow workspace', () => {
  let base: string;
  let workspace: string;
  let shadowRoot: string;
  let changeset: Changeset;
  let runner: CommandRunner;
  let shadow: ShadowWorkspace;

  const run = (args: Parameters<typeof runCommandTool>[1]): Promise<string> =>
    runCommandTool({ workspaceRoot: () => workspace, shadow, runner }, args);
  const nodeRead = (file: string): string => `node -e "process.stdout.write(require('fs').readFileSync('${file}','utf8'))"`;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'forgelens shadow '));
    workspace = path.join(base, 'my workspace');
    shadowRoot = path.join(base, 'storage', 'shadow');
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(path.join(workspace, 'src/a.txt'), 'original a\n');
    writeFileSync(path.join(workspace, 'src/b.txt'), 'original b\n');
    const port = new NodeEditorPort(workspace);
    changeset = new Changeset(port);
    runner = new CommandRunner();
    shadow = new ShadowWorkspace(() => workspace, shadowRoot, () => port.listFiles(), changeset);
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('staged runs see staged edits, new files and deletions, and the real workspace is untouched', async () => {
    const before = snapshot(workspace);
    await stageEditTool(changeset, workspace, { path: 'src/a.txt', edits: [{ old_text: 'original a', new_text: 'staged a' }] });
    await stageCreateFileTool(changeset, workspace, { path: 'src/new.txt', content: 'brand new\n' });
    await stageDeleteFileTool(changeset, workspace, { path: 'src/b.txt' });

    const out = await run({ command: nodeRead('src/a.txt') });
    expect(out).toContain('staged a');
    expect(out).toContain('with 3 staged files applied');
    expect(out).toContain('The real workspace was not touched');
    expect(out).toContain('Exit code: 0');
    expect(readFileSync(path.join(shadowRoot, 'src/new.txt'), 'utf8')).toBe('brand new\n');
    expect(existsSync(path.join(shadowRoot, 'src/b.txt'))).toBe(false);
    expect(snapshot(workspace)).toEqual(before);
  });

  it('a write in the copy stays in the copy', async () => {
    const before = snapshot(workspace);
    await run({ command: `node -e "require('fs').writeFileSync('src/a.txt','overwritten');require('fs').writeFileSync('junk.txt','x')"` });
    expect(snapshot(workspace)).toEqual(before);
  });

  it('later syncs drop what is no longer staged and restore what was', async () => {
    await stageEditTool(changeset, workspace, { path: 'src/a.txt', edits: [{ old_text: 'original a', new_text: 'staged a' }] });
    await stageCreateFileTool(changeset, workspace, { path: 'src/new.txt', content: 'x\n' });
    await stageDeleteFileTool(changeset, workspace, { path: 'src/b.txt' });
    await shadow.sync();
    changeset.clear();
    const second = await shadow.sync();
    expect(second.overlaid).toBe(0);
    expect(readFileSync(path.join(shadowRoot, 'src/a.txt'), 'utf8')).toBe('original a\n');
    expect(readFileSync(path.join(shadowRoot, 'src/b.txt'), 'utf8')).toBe('original b\n');
    expect(existsSync(path.join(shadowRoot, 'src/new.txt'))).toBe(false);
  });

  it('copies only what changed on a later sync, and picks up real changes', async () => {
    expect((await shadow.sync()).copied).toBe(2);
    expect((await shadow.sync()).copied).toBe(0);
    writeFileSync(path.join(workspace, 'src/a.txt'), 'edited by the user, longer\n');
    expect((await shadow.sync()).copied).toBe(1);
    expect(readFileSync(path.join(shadowRoot, 'src/a.txt'), 'utf8')).toContain('edited by the user');
  });

  it('starts clean each session', async () => {
    mkdirSync(shadowRoot, { recursive: true });
    writeFileSync(path.join(shadowRoot, 'left-over.txt'), 'old');
    await shadow.sync();
    expect(existsSync(path.join(shadowRoot, 'left-over.txt'))).toBe(false);
  });

  it('refuses a shadow folder inside the workspace, or holding it', async () => {
    const port = new NodeEditorPort(workspace);
    const inside = new ShadowWorkspace(() => workspace, path.join(workspace, 'shadow'), () => port.listFiles(), changeset);
    await expect(inside.sync()).rejects.toThrow(/outside the workspace/);
    expect(existsSync(path.join(workspace, 'src/a.txt'))).toBe(true);
    const holding = new ShadowWorkspace(() => workspace, base, () => port.listFiles(), changeset);
    await expect(holding.sync()).rejects.toThrow(/outside the workspace/);
    expect(existsSync(path.join(workspace, 'src/a.txt'))).toBe(true);
  });

  it('keeps the CRLF of a staged file', async () => {
    writeFileSync(path.join(workspace, 'src/a.txt'), 'one\r\ntwo\r\n');
    await stageEditTool(changeset, workspace, { path: 'src/a.txt', edits: [{ old_text: 'one', new_text: 'ONE' }] });
    await shadow.sync();
    expect(readFileSync(path.join(shadowRoot, 'src/a.txt'), 'utf8')).toBe('ONE\r\ntwo\r\n');
  });

  it('workspace runs use the real folder', async () => {
    const out = await run({ command: nodeRead('src/a.txt'), target: 'workspace' });
    expect(out).toContain('Ran in the real workspace');
    expect(out).toContain('original a');
    expect(existsSync(shadowRoot)).toBe(false);
  });

  it('points git commands away from the copy', async () => {
    await expect(run({ command: 'git status' })).rejects.toThrow(/not a git repository/);
  });

  it('reports a failing exit code', async () => {
    expect(await run({ command: 'node -e "console.log(1); process.exit(3)"' })).toContain('Exit code: 3');
  });

  it('runs in a subfolder, and refuses one outside', async () => {
    expect(await run({ command: 'node -e "console.log(process.cwd())"', cwd: 'src' })).toMatch(/src\s*$/);
    await expect(run({ command: 'node -v', cwd: '../..' })).rejects.toThrow(/outside the workspace/);
  });

  it('keeps the end of long output, where a test summary is', async () => {
    const out = await run({ command: `node -e "for(let i=0;i<30000;i++)console.log('line '+i);console.log('SUMMARY 5 passed')"` });
    expect(out).toContain('SUMMARY 5 passed');
    expect(out).toContain('start of output cut');
    expect(out.length).toBeLessThan(17_000);
  });

  it('stops a command at its time limit', async () => {
    const out = await run({ command: 'node -e "setTimeout(()=>{},60000)"', timeout_s: 1 });
    expect(out).toContain('Stopped after the 1 s time limit');
  }, 20_000);

  it('Stop ends a running command right away', async () => {
    const running = run({ command: 'node -e "setTimeout(()=>{},60000)"', timeout_s: 60 });
    await vi.waitFor(() => expect(existsSync(shadowRoot)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    runner.cancelAll();
    expect(await running).toContain('Stopped by the user');
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);
});

describe('auto-approval through the TrueForge round trip', () => {
  /** A real recording, with its gated call turned into a run_command. */
  function recordedCommand(command: string): TurnEvent[][] {
    const { turns } = loadRecording('preloaded-allow');
    const copy = JSON.parse(JSON.stringify(turns)) as TurnEvent[][];
    for (const event of copy.flat()) {
      if (event.type !== 'model.message') continue;
      for (const call of event.toolCalls ?? []) {
        if (call.toolInfo?.type === 'mcp') call.toolInfo.name = 'run_command';
        if (call.function) call.function.arguments = JSON.stringify({ command });
      }
    }
    return copy;
  }

  const tools = (controller: AgentController): ToolItem[] => controller.view.items.filter((item): item is ToolItem => item.kind === 'tool');

  function build(command: string): { controller: AgentController; sessions: ReturnType<typeof replaySessions> } {
    const sessions = replaySessions(recordedCommand(command));
    const controller = new AgentController({
      baseUrl: () => 'http://tf.test',
      agentName: 'forgelens-agent',
      sessions: () => sessions,
      createSession: () => Promise.resolve('s'),
      ensureReady: () => Promise.resolve('p/m'),
      onChange: () => undefined,
      autoApprove: (approval) => approval.call.name === 'run_command' && isSafeCommand(String(approval.call.args['command'] ?? '')),
    });
    return { controller, sessions };
  }

  it('sends allow for a safe command, with no person involved, and marks the card', async () => {
    const { controller, sessions } = build('python -m pytest tests/test_cli.py -q');
    await controller.send('run the tests');
    expect(sessions.inputs[1]?.[0]).toMatchObject({ type: 'user.tool_approval', approval: { status: 'allow' } });
    expect(tools(controller)[0]).toMatchObject({ name: 'run_command', autoApproved: true });
    expect(controller.view.status).toBe('done');
  });

  it('waits for a person on anything else', async () => {
    const { controller, sessions } = build('pytest; rm -rf .');
    const sending = controller.send('run the tests');
    await vi.waitFor(() => expect(controller.view.status).toBe('awaiting-approval'));
    expect(sessions.inputs).toHaveLength(1);
    expect(tools(controller)[0]?.autoApproved).toBeFalsy();
    await controller.stop();
    await sending;
  });
});

describe('a real test run in the copy', () => {
  const python = (() => {
    try {
      execFileSync('python', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!python)('imports from the copy rather than the workspace, in a src layout', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'forgelens py '));
    try {
      const workspace = path.join(base, 'ws');
      mkdirSync(path.join(workspace, 'src/pkg'), { recursive: true });
      writeFileSync(path.join(workspace, 'src/pkg/__init__.py'), 'VALUE = 1\n');
      const port = new NodeEditorPort(workspace);
      const changeset = new Changeset(port);
      const shadow = new ShadowWorkspace(() => workspace, path.join(base, 'shadow'), () => port.listFiles(), changeset);
      await stageEditTool(changeset, workspace, { path: 'src/pkg/__init__.py', edits: [{ old_text: 'VALUE = 1', new_text: 'VALUE = 2' }] });
      const out = await runCommandTool(
        { workspaceRoot: () => workspace, shadow, runner: new CommandRunner() },
        { command: 'python -c "import pkg; print(pkg.VALUE)"' },
      );
      expect(out).toMatch(/\n2\s*$/);
      expect(statSync(path.join(workspace, 'src/pkg/__init__.py')).size).toBe('VALUE = 1\n'.length);
      expect(existsSync(path.join(workspace, 'src/pkg/__pycache__'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
