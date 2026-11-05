/** Prints the Context Pack ForgeLens would send for a request. Usage: npx tsx scripts/show-pack.ts <repo> "<request>" */
import * as path from 'node:path';
import { ContextEngine } from '../src/core/context/engine';
import { formatPack } from '../src/core/context/packer';
import { NodeEditorPort } from '../src/core/tools/nodeEditorPort';

async function main(): Promise<void> {
  const [repo, request] = process.argv.slice(2);
  if (!repo || !request) throw new Error('Usage: show-pack.ts <repo> "<request>"');
  const engine = new ContextEngine(new NodeEditorPort(path.resolve(repo)));
  await engine.ensureBuilt();
  console.log(formatPack(await engine.pack(request)));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
