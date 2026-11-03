// Runs test/e2e/run.ts inside a real VS Code Extension Development Host window, with the target repo
// open and a throwaway profile. Usage: node test/e2e/launch.mjs <profileDir> [scenario,scenario]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = path.resolve(process.argv[2] ?? path.join(root, 'out/e2e-profile'));
const workspace = path.resolve(root, '../flask');

// A separate copy of VS Code, so a test never depends on or disturbs the installed one.
const executable = process.env.VSCODE_EXE ?? (await downloadAndUnzipVSCode('stable'));

mkdirSync(path.join(profile, 'data/User'), { recursive: true });
mkdirSync(path.join(profile, 'extensions'), { recursive: true });
writeFileSync(
  path.join(profile, 'data/User/settings.json'),
  JSON.stringify(
    {
      'forgelens.models': (process.env.FORGELENS_E2E_MODELS ?? 'google-gemini/gemini-flash-lite-latest').split(','),
      'security.workspace.trust.enabled': false,
      'workbench.startupEditor': 'none',
      'chat.commandCenter.enabled': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'extensions.autoCheckUpdates': false,
    },
    null,
    2,
  ),
);

const env = {
  ...process.env,
  FORGELENS_E2E_GATED_TOOL: '1',
  FORGELENS_E2E_ROOT: root,
  FORGELENS_E2E_WORKSPACE: workspace,
  FORGELENS_E2E_SCENARIOS: process.argv[3] ?? 'ask,stream,stop,approval,offline',
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  executable,
  [
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'out/e2e/run.js')}`,
    `--user-data-dir=${path.join(profile, 'data')}`,
    `--extensions-dir=${path.join(profile, 'extensions')}`,
    '--new-window',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    workspace,
  ],
  { env, stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
