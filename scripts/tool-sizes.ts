/** Estimates how many tokens each MCP tool's definition costs, preloaded or not. Usage: npx tsx scripts/tool-sizes.ts */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_TOKEN_HEADER, startEditorMcpServer } from '../src/core/mcp/server';
import { NodeEditorPort } from '../src/core/tools/nodeEditorPort';

async function main(): Promise<void> {
  const server = await startEditorMcpServer({ port: new NodeEditorPort(process.cwd()), token: 't' });
  const client = new Client({ name: 'sizes', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { [MCP_TOKEN_HEADER]: 't' } } }));
  const { tools } = await client.listTools();
  const agent = JSON.parse(readFileSync(path.join(__dirname, '..', 'agents', 'forgelens-agent.json'), 'utf8')) as { manifest: { mcp_servers: { preload_tools: string[] }[] } };
  const preload = new Set(agent.manifest.mcp_servers[0]?.preload_tools ?? []);
  let all = 0;
  let loaded = 0;
  for (const tool of tools) {
    const tokens = Math.ceil(JSON.stringify(tool).length / 4);
    all += tokens;
    if (preload.has(tool.name)) loaded += tokens;
    console.log(`${preload.has(tool.name) ? 'preloaded' : 'deferred '} ${tool.name.padEnd(20)} about ${tokens} tokens`);
  }
  console.log(`${tools.length} tools, about ${all} tokens if all were preloaded; ${preload.size} preloaded, about ${loaded}.`);
  await client.close();
  await server.close();
}

void main();
