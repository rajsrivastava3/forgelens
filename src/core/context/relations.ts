/** Python imports and file pairings: how one file points at another without either saying so in a query. */

export function isTestFile(path: string): boolean {
  return /(^|\/)tests?\//.test(path) || /(^|\/)test_[^/]+$/.test(path) || /_test\.[^/.]+$/.test(path) || /\.(test|spec)\.[^/.]+$/.test(path);
}

export function isDocFile(path: string): boolean {
  return /(^|\/)docs?\//.test(path) || /\.(rst|md|mdx)$/i.test(path);
}

export function isChangelog(path: string): boolean {
  return /(^|\/)(CHANGES|CHANGELOG|HISTORY|NEWS)(\.[a-z]+)?$/i.test(path);
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Fixtures and data files repeat a request's words without being where the work happens. */
export function isDataFile(path: string): boolean {
  return /(^|\/)(static|fixtures?|testdata|test_apps|snapshots?)\/|\.(json|toml|ya?ml|ini|cfg|txt|csv|html|css)$/i.test(path);
}

/** cli from src/flask/cli.py, tests/test_cli.py or docs/cli.rst. */
export function moduleStem(path: string): string {
  return baseName(path)
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/^test_/, '')
    .replace(/(_test|\.test|\.spec)$/, '');
}

/** The raw modules a Python file imports. Relative ones keep their leading dots. */
export function parsePythonImports(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.*)$/.exec(line);
    if (from) {
      const module = from[1] ?? '';
      found.add(module);
      // "from . import app" and "from flask import cli" may name submodules.
      for (const name of (from[2] ?? '').replace(/[()]/g, '').split(',')) {
        const clean = name.trim().split(/\s+/)[0] ?? '';
        if (/^\w+$/.test(clean)) found.add(`${module}${module.endsWith('.') ? '' : '.'}${clean}`);
      }
      continue;
    }
    const plain = /^\s*import\s+(.+)$/.exec(line);
    if (plain) {
      for (const part of (plain[1] ?? '').split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (name && /^[\w.]+$/.test(name)) found.add(name);
      }
    }
  }
  return [...found];
}

/** Every dotted name a file can be imported by: flask.cli and src.flask.cli for src/flask/cli.py. */
function moduleNames(path: string): string[] {
  const noExtension = path.replace(/\.py$/, '').replace(/\/__init__$/, '');
  const dotted = noExtension.replace(/\//g, '.');
  const names = [dotted];
  const inSource = /^(src|lib|python)\.(.+)$/.exec(dotted);
  if (inSource?.[2]) names.push(inSource[2]);
  return names;
}

export function buildModuleMap(paths: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const path of paths) {
    if (path.endsWith('.py')) for (const name of moduleNames(path)) map.set(name, path);
  }
  return map;
}

/** Resolves what a file imports to workspace files. Third-party modules resolve to nothing. */
export function resolveImports(path: string, raw: readonly string[], modules: ReadonlyMap<string, string>): string[] {
  const resolved = new Set<string>();
  const isPackage = path.endsWith('/__init__.py');
  const ownParts = path.replace(/\.py$/, '').split('/');
  const packageParts = isPackage ? ownParts.slice(0, -1) : ownParts.slice(0, -1);
  for (const module of raw) {
    const dots = /^\.+/.exec(module)?.[0].length ?? 0;
    let name = module;
    if (dots > 0) {
      const base = packageParts.slice(0, packageParts.length - (dots - 1));
      name = [...base, module.slice(dots)].filter(Boolean).join('.');
    }
    const target = modules.get(name) ?? modules.get(name.replace(/^(src|lib|python)\./, ''));
    if (target && target !== path) resolved.add(target);
  }
  return [...resolved];
}

export interface PairedFile {
  path: string;
  relation: 'test' | 'code' | 'doc';
}

/** src/pkg/X.py with tests/test_X.py and docs/X.rst, in either direction. Names only; mentions are checked elsewhere. */
export function pairedFiles(path: string, allPaths: readonly string[]): PairedFile[] {
  const stem = moduleStem(path);
  if (!stem || stem === '__init__' || isChangelog(path)) return [];
  const pairs: PairedFile[] = [];
  const self = path;
  for (const other of allPaths) {
    if (other === self || moduleStem(other) !== stem || isChangelog(other) || isDataFile(other)) continue;
    const otherIsTest = isTestFile(other);
    const otherIsDoc = !otherIsTest && isDocFile(other);
    if (otherIsTest && !isTestFile(self) && !isDocFile(self)) pairs.push({ path: other, relation: 'test' });
    else if (otherIsDoc && !isDocFile(self) && !isTestFile(self)) pairs.push({ path: other, relation: 'doc' });
    else if (!otherIsTest && !otherIsDoc && (isTestFile(self) || isDocFile(self))) pairs.push({ path: other, relation: 'code' });
  }
  return pairs;
}
