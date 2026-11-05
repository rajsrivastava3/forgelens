// Runs test/e2e/run.ts inside a real VS Code Extension Development Host window, on a throwaway clone of
// the target repo and a throwaway profile. Usage: node test/e2e/launch.mjs <workDir> [scenario,scenario]
// The review scenarios write to disk, so the real flask folder is never opened here.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// A test window and a clone need room, and running out of disk cuts commands off midway.
const MIN_FREE_GB = 2;
const MIN_FREE_RAM_MB = 1300;
const freeRamMb = Math.round(os.freemem() / 1024 ** 2);
if (freeRamMb < MIN_FREE_RAM_MB) {
  console.error(`[e2e] Stopped: ${freeRamMb} MB of RAM free, and a test window needs ${MIN_FREE_RAM_MB} MB.`);
  process.exit(3);
}
const systemDrive = process.env.SystemDrive ? `${process.env.SystemDrive}\\` : '/';
for (const drive of new Set([systemDrive, path.parse(path.resolve(process.argv[2] ?? root)).root])) {
  const { bavail, bsize } = statfsSync(drive);
  const freeGb = (Number(bavail) * Number(bsize)) / 1024 ** 3;
  if (freeGb < MIN_FREE_GB) {
    console.error(`[e2e] Stopped: ${drive} has ${freeGb.toFixed(1)} GB free, and this needs ${MIN_FREE_GB} GB. Free some space first.`);
    process.exit(3);
  }
}

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
      'window.dialogStyle': 'custom',
      // A window capture cannot see what the graphics card draws, so the terminal would come out blank.
      'terminal.integrated.gpuAcceleration': 'off',
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

// A clone has no .venv of its own, so staged test runs need to find the project's Python on the path.
const venvScripts = path.resolve(root, '../flask/.venv/Scripts');
const env = {
  ...process.env,
  PATH: `${venvScripts}${path.delimiter}${process.env.PATH ?? ''}`,
  FORGELENS_E2E: '1',
  FORGELENS_E2E_ROOT: root,
  FORGELENS_E2E_WORKSPACE: workspace,
  FORGELENS_E2E_SCENARIOS: process.argv[3] ?? 'review,reject,stop-review,stop-staging,drift,crlf,create-delete,ctrl-z,keybindings,inline,inline-fallback,inline-cancel,inline-mentions,agent-flow,command-asks,panel-mentions,fallback-banner',
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
