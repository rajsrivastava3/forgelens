/**
 * Scripted answers for the dry runs of the fixed tasks. They would be known answers to the tasks, so they are not
 * kept in this repository: each is a JSON list of ScriptStep in FORGELENS_FIXTURES (default D:\forgelens-e2e\fixtures),
 * named task-a-good.json, task-b-bad.json and so on. A dry run proves the checks; a real run never sees these.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ScriptStep } from './scripted';

export const FIXTURES_DIR = process.env['FORGELENS_FIXTURES'] ?? 'D:\\forgelens-e2e\\fixtures';

export function loadFixture(name: string): ScriptStep[] {
  const file = path.join(FIXTURES_DIR, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(
      `No dry-run answer at ${file}. Answers for the fixed tasks are kept outside the repository; write one there as a JSON list of steps, or set FORGELENS_FIXTURES.`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as ScriptStep[];
}
