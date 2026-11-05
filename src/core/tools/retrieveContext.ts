import type { ContextEngine } from '../context/engine';
import { formatPack } from '../context/packer';
import { uniqueTokens } from '../context/tokenize';
import { capText } from './output';

const DEFAULT_BUDGET_TOKENS = 4_000;
const MAX_BUDGET_TOKENS = 12_000;

/** The agent's own view of the context engine, for refining what the Context Pack already gave it. */
export async function retrieveContextTool(
  engine: ContextEngine,
  args: { query: string; budget_tokens?: number | undefined },
): Promise<string> {
  if (uniqueTokens(args.query).length === 0) return 'The query has no searchable terms. Use identifiers or specific words.';
  const budgetTokens = Math.min(args.budget_tokens ?? DEFAULT_BUDGET_TOKENS, MAX_BUDGET_TOKENS);
  const pack = await engine.pack(args.query, { budgetTokens });
  if (pack.items.length === 0) return `No files match: ${args.query}.`;
  return capText(formatPack(pack), 'Lower budget_tokens or refine the query.');
}
