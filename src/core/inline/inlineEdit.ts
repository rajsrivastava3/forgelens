import { dominantEol, splitKeepingEol } from '../changeset/hunks';
import type { ReviewFlow } from '../changeset/reviewFlow';
import type { ResolvedMention } from './mentions';

export const CONTEXT_LINES = 20;
/** Below this overlap with the selection, a code block is about something else, such as a shell command. */
const MIN_SIMILARITY = 0.2;

export interface InlineTarget {
  /** Workspace-relative, forward slashes. */
  path: string;
  /** 1-based, inclusive. Whole lines: a partial selection is widened to its lines. */
  startLine: number;
  endLine: number;
  /** Language id or file extension, used to label code blocks. */
  language: string;
  instruction: string;
}

export interface SelectionText {
  selected: string;
  before: string;
  after: string;
}

export function readSelection(fileText: string, target: Pick<InlineTarget, 'startLine' | 'endLine'>): SelectionText {
  const lines = splitKeepingEol(fileText);
  const first = target.startLine - 1;
  return {
    selected: lines.slice(first, target.endLine).join(''),
    before: lines.slice(Math.max(0, first - CONTEXT_LINES), first).join(''),
    after: lines.slice(target.endLine, target.endLine + CONTEXT_LINES).join(''),
  };
}

const fence = (language: string, code: string): string => `\`\`\`${language}\n${code.replace(/\r\n/g, '\n').replace(/\n$/, '')}\n\`\`\``;

/** What the panel shows for this request. The full prompt goes only to the agent. */
export function inlineDisplayText(target: InlineTarget): string {
  return `Edit ${target.path}, lines ${target.startLine}-${target.endLine}: ${target.instruction}`;
}

export function buildInlinePrompt(target: InlineTarget, selection: SelectionText, mentions: readonly ResolvedMention[] = []): string {
  const parts = [
    `File: ${target.path}`,
    `Selected lines: ${target.startLine}-${target.endLine}`,
    `Instruction: ${target.instruction}`,
    `Selected code. Copy old_text for stage_edit exactly from here:\n${fence(target.language, selection.selected)}`,
  ];
  if (selection.before.trim()) parts.push(`Lines just before the selection, for context only:\n${fence(target.language, selection.before)}`);
  if (selection.after.trim()) parts.push(`Lines just after the selection, for context only:\n${fence(target.language, selection.after)}`);
  for (const mention of mentions) {
    parts.push(`Mentioned by you, ${mention.label}:\n${mention.found ? fence('', mention.text) : mention.text}`);
  }
  parts.push('Now call stage_edit for this change, then call apply_changes.');
  return parts.join('\n\n');
}

interface CodeBlock {
  language: string;
  code: string;
}

export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const pattern = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const code = (match[3] ?? '').replace(/\r\n/g, '\n');
    if (code.trim()) blocks.push({ language: (match[2] ?? '').toLowerCase(), code });
  }
  return blocks;
}

const wordsOf = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);

/** How much of the selection's vocabulary appears in the block. */
function overlap(selection: string, code: string): number {
  const wanted = wordsOf(selection);
  if (wanted.size === 0) return 0;
  const have = wordsOf(code);
  let shared = 0;
  for (const word of wanted) if (have.has(word)) shared += 1;
  return shared / wanted.size;
}

function looksLikeDiff(block: CodeBlock): boolean {
  if (block.language === 'diff' || block.language === 'patch') return true;
  const lines = block.code.split('\n').filter((line) => line.trim());
  const marked = lines.filter((line) => /^[+-]/.test(line) || line.startsWith('@@ ')).length;
  return lines.length > 0 && marked === lines.length;
}

function leadingWhitespace(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? '';
  return /^[ \t]*/.exec(firstLine)?.[0] ?? '';
}

/** Moves the block to the selection's indentation, for models that dedent what they quote. */
function matchIndentation(code: string, selected: string): string {
  const from = leadingWhitespace(code);
  const to = leadingWhitespace(selected);
  if (from === to) return code;
  return code
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      return line.startsWith(from) ? `${to}${line.slice(from.length)}` : line;
    })
    .join('\n');
}

export type ParsedReplacement = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Turns a model's plain-text answer into the file with that answer in place of the selection. Only blocks
 * that resemble the selection count, and a whole-file answer is used as the whole file.
 */
export function replacementFromText(output: string, fileText: string, target: Pick<InlineTarget, 'startLine' | 'endLine'>): ParsedReplacement {
  const { selected } = readSelection(fileText, target);
  const blocks = extractCodeBlocks(output);
  if (blocks.length === 0) return { ok: false, reason: 'its answer had no code block' };
  const usable = blocks.filter((block) => !looksLikeDiff(block));
  if (usable.length === 0) return { ok: false, reason: 'its answer had only a diff, which cannot be applied safely' };

  const ranked = usable
    .map((block) => ({ block, score: overlap(selected, block.code) }))
    .sort((a, b) => b.score - a.score || b.block.code.length - a.block.code.length);
  const best = ranked[0];
  if (!best || best.score < MIN_SIMILARITY) return { ok: false, reason: 'no code block in its answer resembles the selected code' };

  const eol = dominantEol(selected.includes('\n') ? selected : fileText);
  const fileLines = fileText.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const blockLines = best.block.code.trimEnd().split('\n');
  const firstLine = fileLines.find((line) => line.trim());
  const isWholeFile = target.startLine > 1 && blockLines.length >= fileLines.length * 0.8 && blockLines.find((line) => line.trim()) === firstLine;
  const finish = (text: string): string => (eol === '\n' ? text : text.replace(/\n/g, eol));

  if (isWholeFile) {
    const endsWithNewline = /\n$/.test(fileText);
    return { ok: true, text: finish(`${best.block.code.trimEnd()}${endsWithNewline ? '\n' : ''}`) };
  }

  const lines = splitKeepingEol(fileText);
  const first = target.startLine - 1;
  const lastSelected = lines[target.endLine - 1] ?? '';
  const keepsNewline = /\n$/.test(lastSelected);
  const code = matchIndentation(best.block.code.replace(/\n+$/, ''), selected.replace(/\r\n/g, '\n'));
  const replacement = finish(`${code}${keepsNewline ? '\n' : ''}`);
  return { ok: true, text: [...lines.slice(0, first), replacement, ...lines.slice(target.endLine)].join('') };
}

export interface FinishInlineOptions {
  flow: ReviewFlow;
  target: InlineTarget;
  /** The agent's final text. */
  output: string;
  /** ReviewFlow.reviewsStarted when this request began, to tell whether the agent reached a review. */
  reviewsAtStart: number;
  signal: AbortSignal;
  log: (message: string) => void;
}

/**
 * Runs when the agent's turn ended. Normally the review already happened and there is nothing to do. A weak
 * model may stop after staging, or answer in plain text; either way the same review opens, and nothing reaches
 * disk unless a person accepts it. Returns a message for the user when nothing can be proposed.
 */
export async function finishInlineEdit(options: FinishInlineOptions): Promise<string | undefined> {
  const { flow, target, output, signal, log } = options;
  if (flow.reviewsStarted > options.reviewsAtStart || signal.aborted) return undefined;

  let note: string;
  if (!flow.changeset.isEmpty) {
    note = 'The model stopped before asking for review, so ForgeLens opened it.';
  } else {
    const fileText = await flow.changeset.currentText(target.path);
    const parsed = replacementFromText(output, fileText, target);
    if (!parsed.ok) {
      log(`Inline fallback not used: ${parsed.reason}.`);
      return `The model did not propose a change: ${parsed.reason}. Nothing was changed.`;
    }
    if (parsed.text === fileText) return 'The model answered with the code unchanged, so there is nothing to review.';
    await flow.changeset.stageText(target.path, parsed.text);
    note = 'The model answered in plain text instead of calling the tools, so ForgeLens staged its code block for review.';
  }
  log(`Inline fallback used: ${note}`);

  const decision = await flow.requestReview(signal, note);
  if (decision.allow) await flow.applyApproved(`Inline edit of ${target.path}, lines ${target.startLine}-${target.endLine}`);
  return undefined;
}
