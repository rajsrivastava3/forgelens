// Runs test/e2e/run.ts inside a real VS Code Extension Development Host window, on a throwaway clone of
// the target repo and a throwaway profile. Usage: node test/e2e/launch.mjs <workDir> [scenario,scenario]
// The review scenarios write to disk, so the real flask folder is never opened here.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = path.resolve(process.argv[2] ?? path.join(root, 'out/e2e-work'));
const profile = path.join(work, 'profile');
const workspace = path.join(work, 'flask-copy');

rmSync(workspace, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
execFileSync('git', ['clone', '--quiet', '-c', 'core.autocrlf=false', path.resolve(root, '../flask'), workspace]);

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
  FORGELENS_E2E: '1',
  FORGELENS_E2E_ROOT: root,
  FORGELENS_E2E_WORKSPACE: workspace,
  FORGELENS_E2E_SCENARIOS: process.argv[3] ?? 'review,reject,stop-review,stop-staging,drift,crlf',
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
child.on('exit', (code) => {
  const closeMarker = path.join(root, 'out/e2e-close-cancel.txt');
  if ((process.argv[3] ?? '').includes('close-scripted')) {
    console.log(`[e2e] after close: ${existsSync(closeMarker) ? readFileSync(closeMarker, 'utf8') : 'cancel was NOT sent'}`);
  }
  console.log(`[e2e] git status of the copy: "${execFileSync('git', ['-C', workspace, 'status', '--porcelain']).toString().trim()}"`);
  rmSync(workspace, { recursive: true, force: true });
  process.exit(code ?? 1);
});
