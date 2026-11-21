/**
 * Modules a model often uses without importing: common standard library ones, and pytest and click. A staged
 * Python file that calls one of them but never names it anywhere else (no import, no assignment, no parameter)
 * fails with a NameError the moment the tests reach it, which costs a whole test run to find. Saying so at stage
 * time lets the model fix it first.
 */
const COMMON_MODULES = [
  'json', 'os', 're', 'sys', 'typing', 'pathlib', 'datetime', 'collections', 'itertools', 'functools', 'subprocess',
  'shutil', 'tempfile', 'textwrap', 'inspect', 'importlib', 'logging', 'math', 'time', 'uuid', 'base64', 'hashlib',
  'io', 'copy', 'dataclasses', 'enum', 'warnings', 'contextlib', 'traceback', 'platform', 'string', 'random',
  'decimal', 'ast', 'types', 'operator', 'csv', 'glob', 'fnmatch', 'threading', 'asyncio', 'socket', 'struct',
  'pickle', 'secrets', 'pprint', 'argparse', 'unittest', 'pytest', 'click',
];

/** The code with comments and string literals blanked, so a module named in a docstring is not a use of it. */
function codeOnly(text: string): string {
  return text
    .replace(/("""|''')[\s\S]*?\1/g, ' ')
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/#[^\n]*/g, '');
}

/** Modules the file uses as `name.attr` and never binds. Only for Python files. */
export function missingImports(path: string, text: string): string[] {
  if (!/\.pyi?$/i.test(path)) return [];
  const code = codeOnly(text);
  return COMMON_MODULES.filter((name) => {
    const used = new RegExp(`(?<![\\w.])${name}\\s*\\.\\s*[A-Za-z_]`).test(code);
    if (!used) return false;
    // Any bare mention binds it or brings it in: `import json`, `json = ...`, `def f(json)`. So does any import
    // line that names it, `import importlib.metadata` included. When unsure, say nothing.
    const bare = new RegExp(`(?<![\\w.])${name}(?!\\w)(?!\\s*\\.)`).test(code);
    const imported = new RegExp(`^\\s*(?:import|from)\\s[^\\n]*(?<![\\w.])${name}(?!\\w)`, 'm').test(code);
    return !bare && !imported;
  });
}

/** The note a stage result carries, or nothing. */
export function missingImportNote(path: string, text: string): string | undefined {
  const missing = missingImports(path, text);
  if (missing.length === 0) return undefined;
  const lines = missing.map((name) => `import ${name}`).join('", "');
  return `Note: ${path} uses ${missing.join(', ')} but never imports ${missing.length === 1 ? 'it' : 'them'}, so the tests would fail with a NameError. Stage "${lines}" with the file's other imports before running the tests.`;
}
