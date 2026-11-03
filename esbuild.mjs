import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = { bundle: true, sourcemap: true, logLevel: 'info' };

const builds = [
  {
    ...shared,
    entryPoints: ['src/vscode/extension.ts'],
    outfile: 'out/extension.js',
    platform: 'node',
    target: 'node20', // Extension host Node version for VS Code ^1.90.
    format: 'cjs',
    // `vscode` is provided by the extension host at runtime.
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: { webview: 'src/vscode/webview/main.ts' },
    outdir: 'out',
    entryNames: '[name]',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  },
  {
    ...shared,
    entryPoints: { webview: 'src/vscode/webview/panel.css' },
    outdir: 'out',
    entryNames: '[name]',
    sourcemap: false,
  },
  {
    ...shared,
    entryPoints: ['test/e2e/run.ts'],
    outfile: 'out/e2e/run.js',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
  },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
