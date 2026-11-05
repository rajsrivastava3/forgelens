import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { ShadowWorkspace } from '../shadow/shadowWorkspace';
import { resolveInsideWorkspace } from './nodeEditorPort';

export const RUN_COMMAND_TOOL = 'run_command';
export const DEFAULT_SAFE_COMMANDS: readonly string[] = ['pytest', 'python -m pytest', 'git status', 'git diff'];

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
/** Test output matters most at its end, where the summary is. */
const MAX_OUTPUT_CHARS = 16_000;
const SHELL_SYNTAX = /[;&|<>`$\n\r]|\$\(/;
/** Options that would write files or run other programs from an otherwise read-only git command. */
const UNSAFE_GIT_OPTIONS = /(^|\s)(--output|--ext-diff|--textconv|-o)(=|\s|$)/;

/**
 * True only for one plain command from the list. Anything that could chain another program disqualifies it, so
 * "pytest; rm -rf ." is never treated as pytest. Such a command still works, after a person approves it.
 */
export function isSafeCommand(command: string, safeList: readonly string[] = DEFAULT_SAFE_COMMANDS): boolean {
  // Checked before spaces are tidied: tidying would turn a line break, which starts a second command, into a space.
  if (SHELL_SYNTAX.test(command.trim())) return false;
  const trimmed = command.trim().replace(/\s+/g, ' ');
  if (!trimmed) return false;
  if (/^git /.test(trimmed) && UNSAFE_GIT_OPTIONS.test(trimmed)) return false;
  return safeList.some((safe) => trimmed === safe || trimmed.startsWith(`${safe} `));
}

export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  durationMs: number;
}

function keepTail(text: string): string {
  return text.length > MAX_OUTPUT_CHARS * 2 ? text.slice(-MAX_OUTPUT_CHARS * 2) : text;
}

function capTail(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `[start of output cut: it exceeded ${MAX_OUTPUT_CHARS} characters]\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** Finds the project's own Python, and keeps a run from leaving caches behind in the folder it ran in. */
export function commandEnvironment(runRoot: string, workspaceRoot: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PYTHONDONTWRITEBYTECODE: '1', PYTEST_ADDOPTS: `${base['PYTEST_ADDOPTS'] ?? ''} -p no:cacheprovider`.trim() };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  for (const venv of ['.venv', 'venv']) {
    const bin = path.join(workspaceRoot, venv, process.platform === 'win32' ? 'Scripts' : 'bin');
    if (existsSync(bin)) {
      env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
      break;
    }
  }
  // An editable install points at the real folder, and a src layout would import from there instead of this copy.
  if (existsSync(path.join(runRoot, 'src'))) {
    env['PYTHONPATH'] = [path.join(runRoot, 'src'), base['PYTHONPATH']].filter(Boolean).join(path.delimiter);
  }
  return env;
}

/** Runs commands and can stop them all, because a Stop must not wait for a long test run. */
export class CommandRunner {
  private readonly running = new Set<ChildProcess>();
  private readonly cancelledChildren = new WeakSet<ChildProcess>();

  run(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutS: number): Promise<CommandResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
      this.running.add(child);
      let output = '';
      let timedOut = false;
      const append = (chunk: Buffer): void => {
        output = keepTail(output + chunk.toString('utf8'));
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutS * 1000);
      child.on('error', (error) => {
        clearTimeout(timer);
        this.running.delete(child);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.running.delete(child);
        resolve({ exitCode: code, timedOut, cancelled: this.cancelledChildren.has(child), output: capTail(output), durationMs: Date.now() - started });
      });
    });
  }

  cancelAll(): void {
    for (const child of this.running) {
      this.cancelledChildren.add(child);
      killTree(child);
    }
  }
}

export interface RunCommandDeps {
  workspaceRoot: () => string;
  shadow: ShadowWorkspace;
  runner: CommandRunner;
}

export interface RunCommandArgs {
  command: string;
  cwd?: string | undefined;
  target?: 'staged' | 'workspace' | undefined;
  timeout_s?: number | undefined;
}

export async function runCommandTool(deps: RunCommandDeps, args: RunCommandArgs): Promise<string> {
  const target = args.target ?? 'staged';
  const workspaceRoot = deps.workspaceRoot();
  const timeoutS = Math.min(Math.max(1, args.timeout_s ?? DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S);
  if (target === 'staged' && /^\s*git\s/.test(args.command)) {
    throw new Error('The staged copy is not a git repository. Use get_staged_changes to see staged edits, or target "workspace" for git commands.');
  }

  let runRoot = workspaceRoot;
  let where = 'Ran in the real workspace.';
  if (target === 'staged') {
    const { root, overlaid } = await deps.shadow.sync();
    runRoot = root;
    where = `Ran in a private copy of the workspace with ${overlaid} staged file${overlaid === 1 ? '' : 's'} applied. The real workspace was not touched.`;
  }
  // VS Code reports d:\\folder while the system says D:\\Folder. Code that compares paths, as some tests do, needs one spelling.
  const realRoot = realpathSync.native(runRoot);
  const cwd = args.cwd ? resolveInsideWorkspace(realRoot, args.cwd) : realRoot;
  const result = await deps.runner.run(args.command, cwd, commandEnvironment(realRoot, workspaceRoot), timeoutS);

  const status = result.cancelled
    ? 'Stopped by the user.'
    : result.timedOut
      ? `Stopped after the ${timeoutS} s time limit.`
      : `Exit code: ${String(result.exitCode)}`;
  return `${where}\n$ ${args.command}\n${status} (${(result.durationMs / 1000).toFixed(1)} s)\n${result.output.trimEnd() || '(no output)'}`;
}
