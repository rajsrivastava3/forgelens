import { parseMentions } from '../inline/mentions';
import type { AgentController } from '../trueforge/agentController';
import type { ContextEngine } from './engine';
import { DEFAULT_BUDGET_TOKENS, formatPack, type PackMode, type PackResult } from './packer';
import { IMPLEMENT_MESSAGE, parsePlan, PLAN_RULE } from './plan';

export interface ContextCardItem {
  path: string;
  reason: string;
  mode: PackMode;
  tokens: number;
  mentioned: boolean;
}

/** What the panel shows: which files were chosen, why, and what that cost. */
export interface ContextCard {
  files: number;
  usedTokens: number;
  budgetTokens: number;
  items: ContextCardItem[];
  dropped: { path: string; why: string }[];
  /** Mentions that match nothing in the workspace. */
  notFound: string[];
}

export interface AgentPromptOptions {
  budgetTokens?: number;
  activeFile?: string | undefined;
  openFiles?: readonly string[];
}

export interface AgentPrompt {
  prompt: string;
  card: ContextCard;
}

export function contextCard(pack: PackResult, notFound: readonly string[] = []): ContextCard {
  return {
    files: pack.items.length,
    usedTokens: pack.usedTokens,
    budgetTokens: pack.budgetTokens,
    items: pack.items.map(({ path, reason, mode, tokens, mentioned }) => ({ path, reason, mode, tokens, mentioned })),
    dropped: pack.dropped,
    notFound: [...notFound],
  };
}

/** The Context Pack goes ahead of the user's words, so the model reads what was found before what to do. */
export async function buildAgentPrompt(engine: ContextEngine, text: string, options: AgentPromptOptions = {}): Promise<AgentPrompt> {
  await engine.ensureBuilt();
  const mentionedFiles: string[] = [];
  const notFound: string[] = [];
  for (const mention of parseMentions(text)) {
    if (mention.kind === 'file') {
      if (engine.index.files.has(mention.name)) mentionedFiles.push(mention.name);
      else notFound.push(mention.name);
      continue;
    }
    const owner = [...engine.index.files].find(([, file]) => file.symbols.some((symbol) => symbol.name === mention.name))?.[0];
    if (owner) mentionedFiles.push(owner);
    else notFound.push(mention.name);
  }
  const query = text.replace(/(^|\s)@(file|symbol):[^\s,;]+/g, ' ');
  const pack = await engine.pack(query, {
    budgetTokens: options.budgetTokens ?? DEFAULT_BUDGET_TOKENS,
    mentionedFiles: [...new Set(mentionedFiles)],
    activeFile: options.activeFile,
    openFiles: options.openFiles ?? [],
  });
  const missing = notFound.length > 0 ? `\n\nMentioned but not found in the workspace: ${notFound.join(', ')}.` : '';
  return {
    prompt: `${formatPack(pack)}${missing}\n\n## Request\n${text}\n\n${PLAN_RULE}`,
    card: contextCard(pack, notFound),
  };
}

/** One request in agent mode: the Context Pack goes first, and the panel shows only what was typed. */
export function sendAgentRequest(
  controller: AgentController,
  engine: ContextEngine,
  text: string,
  options: () => AgentPromptOptions,
  log: (message: string) => void,
): Promise<void> {
  return controller.send(text, {
    prepare: async (message) => {
      try {
        return await buildAgentPrompt(engine, message, options());
      } catch (error) {
        // The agent can still search for itself, so a failed pack should not stop the request.
        log(`Context Pack failed: ${String(error)}`);
        return { prompt: `${message}\n\n${PLAN_RULE}` };
      }
    },
    // A first turn that ends with a plan is followed, in the same session, by the turn that carries it out.
    followUp: (output) => {
      const plan = parsePlan(output);
      return plan ? { prompt: IMPLEMENT_MESSAGE, plan } : undefined;
    },
  });
}
