const STOP_WORDS = new Set(
  'a an and any are as at be been but by can could do does each every for from had has have how i if in into is it its may me must my no not of on or our should so some than that the their them then there these they this those to too up us was we were what when where which while who why will with would you your also add adds added new make makes made use uses used using get gets need needs want wants like just only it\'s'.split(
    ' ',
  ),
);

/** Same idea, different word. Kept short: this is for code vocabulary, not English in general. */
const ALIASES = new Map<string, string>([
  ['configuration', 'config'],
  ['configurations', 'config'],
  ['configure', 'config'],
  ['configured', 'config'],
  ['documentation', 'doc'],
  ['documented', 'doc'],
  ['document', 'doc'],
  ['documents', 'doc'],
  ['docs', 'doc'],
  ['tests', 'test'],
  ['testing', 'test'],
  ['tested', 'test'],
  ['args', 'arg'],
  ['arguments', 'arg'],
  ['argument', 'arg'],
  ['authentication', 'auth'],
  ['authorization', 'auth'],
]);

/** Light suffix removal, so "commands" finds "command" and "masking" finds "mask". */
export function stem(word: string): string {
  const alias = ALIASES.get(word);
  if (alias) return alias;
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed') && !word.endsWith('eed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Splits get_debug_flag, FlaskGroup, HTTPServer and kebab-case into lowercase words. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/** Each word in the text once per occurrence: the parts of an identifier, plus the identifier itself. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? []) {
    const parts = splitIdentifier(raw);
    for (const part of parts) {
      if (part.length > 1 && !STOP_WORDS.has(part)) tokens.push(stem(part));
    }
    if (parts.length > 1) tokens.push(raw.toLowerCase());
  }
  return tokens;
}

export function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

/** The words a path contributes, without its extension: src/flask/test_cli.py gives src, flask, test, cli. */
export function pathTokens(path: string): string[] {
  return tokenize(path.replace(/\.[A-Za-z0-9]+$/, ''));
}
