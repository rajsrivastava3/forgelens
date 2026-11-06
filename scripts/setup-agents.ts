/**
 * Saves both agents on a chosen primary model and registers the MCP server, the same setup the extension runs on
 * activation. A rehearsal with a broken primary leaves the saved agents on it; this puts them back. The MCP URL it
 * registers points at a server that closes when this ends; the extension registers its own when it starts.
 * Usage: npx tsx scripts/setup-agents.ts google-gemini/gemini-3-8-flash [fallback ...]
 */
import { randomBytes } from 'node:crypto';
import { startEditorMcpServer } from '../src/core/mcp/server';
import { setUpTrueForge } from '../src/core/trueforge/setup';
import { NodeEditorPort } from '../src/core/tools/nodeEditorPort';
import { BASE_URL, loadAgents, REASONING_EFFORT } from './rehearse/harness';

async function main(): Promise<void> {
  const chain = process.argv.slice(2);
  if (chain.length === 0) throw new Error('Name the primary model, then any fallbacks.');
  const token = randomBytes(24).toString('hex');
  const mcp = await startEditorMcpServer({ port: new NodeEditorPort(process.cwd()), token });
  try {
    const result = await setUpTrueForge({ baseUrl: BASE_URL, mcp: { url: mcp.url, token }, configuredModels: chain, agents: loadAgents(), reasoningEffort: REASONING_EFFORT });
    console.log(`Primary: ${result.model}. Chain: ${result.chain.join(', ')}. Agents: ${JSON.stringify(result.agents)}`);
  } finally {
    await mcp.close();
  }
  const response = await fetch(`${BASE_URL}/api/v1/agents`);
  const agents = ((await response.json()) as { data: { name: string; manifest: { model: { name: string } } }[] }).data;
  for (const agent of agents) console.log(`${agent.name}: ${agent.manifest.model.name}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
