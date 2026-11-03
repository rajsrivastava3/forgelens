# ForgeLens

A VS Code coding agent whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge).

> Nothing touches disk until a human accepts a hunk, and the agent always shows what it read and why.

**Starting point:** from scratch. **Licence:** MIT.

Status: in development. The agent can read, search, answer and propose edits, and you review them hunk by hunk.
Inline edit, the context engine and model fallback are next.

## How a change reaches disk

The agent stages edits, which write nothing. When it calls `apply_changes`, TrueForge pauses for approval and
ForgeLens opens a review instead of a plain Allow button: one diff per file with **Accept hunk | Reject hunk**
above every hunk, Accept all, Reject all and Apply decisions in the title bar, and a **Changes** tree. Only
accepted hunks are written, in one atomic edit across files. **ForgeLens: Undo last applied change**, or Undo on
the panel's card, restores every touched file. Undecided hunks count as rejected. If a file changed during
review, ForgeLens recomputes the diff and asks again rather than overwriting it. Undo refuses to overwrite edits
made after the apply. Stop discards everything staged.

The undo stack lasts until the window closes.

## Try it

1. Start TrueForge (below), then add a model under **Settings > Models** at <http://localhost:8790>.
2. In this folder run `npm install` and `npm run build`, open the folder in VS Code and press **F5**.
3. In the new window, open the **ForgeLens** icon in the activity bar and ask a question about the repository.

ForgeLens sets up TrueForge by itself when it starts: it registers its tools server and saves the agents in
`agents/`. Run **ForgeLens: Set up TrueForge** to repeat that. To choose a model, set `forgelens.models`; see
`config/models.example.json`. The agent files contain `${FORGELENS_MODEL}` rather than a model name, and setup
fills that in, so no agent is tied to one provider.

Only one VS Code window at a time can host the tools, because they use a fixed local port
(`forgelens.mcpPort`, default 8799).

## Tests

`npm test` runs the unit tests, which replay events recorded from real TrueForge sessions and use no model
requests. `npm run test:e2e` drives the real panel and review in an Extension Development Host, on a throwaway
clone of Flask, and saves screenshots to `docs/screenshots/`. Its default scenarios use scripted events and no
model requests; pass `live` as a scenario for a real agent run:
`node test/e2e/launch.mjs <workDir> live`. It downloads its own copy of VS Code, or set `VSCODE_EXE` to use another.

## Start TrueForge locally

ForgeLens hosts its MCP server on `127.0.0.1`, and TrueForge blocks loopback URLs by default, so
TrueForge has to start with an allowlist. These scripts set it:

```powershell
# PowerShell
.\scripts\start-trueforge.ps1
```

```bash
# Git Bash, Linux, macOS
./scripts/start-trueforge.sh
```

Then open <http://localhost:8790>. Requires Node 22.14 or newer.

The scripts pin TrueForge to **0.183.0**, the same version as `@truefoundry/trueforge-sdk` in
`package.json`. Change both together, and rerun `npm run spike` if you do. To start it by hand:

```powershell
# PowerShell: the quotes around the package name are required
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'; npx.cmd "@truefoundry/trueforge@0.183.0"
```

```bash
# bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@0.183.0
```
