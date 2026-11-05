/** The exact Task A checks, shared by the Task A and Task C rehearsals. */
import * as path from 'node:path';
import { exec, GIT_BASH, PYTHON, verifyEnv } from './harness';

export const TASK_A_INSTRUCTION = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
export const TASK_A_FILE = 'src/flask/helpers.py';
const VERIFY = 'from flask.helpers import get_debug_flag; print(get_debug_flag())';

export function selectGetDebugFlag(text: string): { startLine: number; endLine: number } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('def get_debug_flag'));
  if (start < 0) throw new Error('get_debug_flag is not in this file.');
  let end = start;
  for (let i = start + 1; i < lines.length && (lines[i]?.startsWith(' ') || lines[i]?.trim() === ''); i += 1) {
    if (lines[i]?.trim()) end = i;
  }
  return { startLine: start + 1, endLine: end + 1 };
}

export interface TaskAChecks {
  passed: boolean;
  failures: string[];
  exactCommand: string;
  values: Record<string, string>;
  pytest: string;
  docstring: string;
  onlyThisFile: boolean;
}

export async function verifyTaskA(clone: string): Promise<TaskAChecks> {
  const failures: string[] = [];
  const python = async (args: string[], env: Record<string, string> = {}): Promise<string> =>
    (await exec(PYTHON, args, { cwd: clone, env: verifyEnv(env), timeout: 120_000 })).stdout.trim();

  const from = await python(['-c', 'import flask; print(flask.__file__)']);
  if (!path.resolve(from).toLowerCase().startsWith(path.resolve(clone).toLowerCase())) failures.push(`flask came from outside the clone: ${from}`);

  const exactCommand = (await exec(GIT_BASH, ['-c', `FLASK_DEBUG=off python -c "${VERIFY}"`], { cwd: clone, env: verifyEnv(), timeout: 120_000 })).stdout.trim();
  if (exactCommand !== 'False') failures.push(`the exact command printed ${exactCommand}`);

  const values: Record<string, string> = {};
  const expected: Record<string, string> = { off: 'False', OFF: 'False', Off: 'False', n: 'False', N: 'False', '0': 'False', false: 'False', FALSE: 'False', no: 'False', NO: 'False', '1': 'True', true: 'True', yes: 'True' };
  for (const [value, want] of Object.entries(expected)) {
    values[value] = await python(['-c', VERIFY], { FLASK_DEBUG: value });
    if (values[value] !== want) failures.push(`FLASK_DEBUG=${value} gave ${values[value]}, wanted ${want}`);
  }

  const docstring = await python(['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag.__doc__)']);
  for (const word of ['0', 'false', 'no', 'off', 'n']) {
    if (!new RegExp(`(^|[^a-z0-9])${word}($|[^a-z0-9])`, 'i').test(docstring)) failures.push(`the docstring does not list ${word}`);
  }

  let pytest: string;
  try {
    pytest = (await python(['-m', 'pytest', 'tests/test_helpers.py', '-q', '-p', 'no:cacheprovider'])).split('\n').at(-1) ?? '';
  } catch (error) {
    pytest = `FAILED: ${String((error as { stdout?: string }).stdout ?? error).trim().split('\n').slice(-2).join(' ')}`;
    failures.push(pytest);
  }

  const status = (await exec('git', ['-C', clone, 'status', '--porcelain'])).stdout.trim();
  const onlyThisFile = status === `M ${TASK_A_FILE}`;
  if (!onlyThisFile) failures.push(`changed files: ${status || 'none'}`);
  return { passed: failures.length === 0, failures, exactCommand, values, pytest, docstring, onlyThisFile };
}
