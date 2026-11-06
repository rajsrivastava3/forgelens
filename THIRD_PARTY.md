# Third-party software

ForgeLens was written from scratch. No source code was copied from other projects. It depends on these packages
at run time, each under its own licence, installed from npm and not included in this repository:

| Package | Version | Licence |
|---|---|---|
| `@truefoundry/trueforge-sdk` | 0.183.0 | MIT |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT |
| `diff` | 8.0.4 | BSD-3-Clause |
| `zod` | 4.6.7 | MIT |

Development tools (`typescript`, `esbuild`, `vitest`, `tsx`, `@vscode/test-electron`, type packages) are used only
to build and test, and are not bundled into the extension.

TrueForge itself runs as a separate process (`npx @truefoundry/trueforge@0.183.0`) and is not part of this
repository. The demo repository for the fixed tasks is Flask (BSD-3-Clause), cloned beside this one, never copied
into it.
