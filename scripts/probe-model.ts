/**
 * Sends one tiny request to one model through TrueForge and prints the exact result or error.
 * Usage: npx tsx scripts/probe-model.ts <provider/model>
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';

const model = process.argv[2];
if (!model) throw new Error('Name a model, for example google-gemini/gemini-3-8-flash.');
const baseUrl = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const client = new TrueForge({ baseUrl, timeoutInSeconds: 120 });

async function main(): Promise<void> {
  const session = await client.sessions.create({
    agent: { spec: { model: { name: model as string }, instructions: 'Reply with the one word asked for and nothing else.' } },
  });
  const started = Date.now();
  const stream = await client.sessions.createTurnStream(session.data.id, { input: [{ type: 'user.message', content: 'Say OK.' }] });
  for await (const { data: event } of stream.withMetadata()) {
    if (event.type === 'turn.done') {
      console.log(`session: ${baseUrl}/sessions/${session.data.id}`);
      console.log(`seconds: ${((Date.now() - started) / 1000).toFixed(1)}`);
      console.log(`state: ${JSON.stringify(event.state, null, 2)}`);
    }
  }
}

void main().catch((error: unknown) => {
  console.error(`request failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
