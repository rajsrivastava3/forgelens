# ForgeLens

A VS Code coding agent whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge).

> Nothing touches disk until a human accepts a hunk, and the agent always shows what it read and why.

**Starting point:** from scratch. **Licence:** MIT.

Status: in development. The agent can read, search, answer and propose edits, and you review them hunk by hunk.
Inline edit works the same way, and the context engine chooses what the agent reads first. Model fallback is next.

## How the agent chooses what to read

The strategy is budgeted multi-signal retrieval. ForgeLens indexes the workspace in the background, in small slices
so the editor stays free, and keeps the index in VS Code's extension storage, never in your folder. It updates when
you save. Before each agent request it ranks files by word matches (BM25, with identifiers split so `get_debug_flag`
matches "debug flag"), how much of the request a file covers, file and symbol names, imports, test and doc pairings
such as `cli.py`, `tests/test_cli.py` and `docs/cli.rst`, the changelog for changes, open editors, and anything you
`@` mention, which always goes in.

Then it fills a budget of 12k tokens (`forgelens.context.budgetTokens`): the top files get their best code in full,
the next get signatures only, the rest just a path and a reason, and anything left over is recorded as left out. The
panel shows this as "Context chosen: N files, X / 12k tokens", with the reason for each file. Type `@` in the panel
to add a file or symbol.

## Running tests before review

`run_command` with target `staged` runs in a private copy of the workspace with the staged edits applied, kept in
extension storage, so tests can pass or fail before you review anything. Target `workspace` runs in the real folder.
Commands on `forgelens.commands.autoApprove` (`pytest`, `python -m pytest`, `git status`, `git diff`) are answered
automatically, still through the TrueForge approval, and the card says "auto-approved (safe list)". Anything else
asks you, including any command with shell syntax such as `;` or `|`. Stop ends a running command.

## Inline edit

Select some code and press **Ctrl+Alt+K** (Cmd+Alt+K on a Mac), or right-click and choose **ForgeLens: Edit
selection**. Say what should change. Type `@` to add a file or symbol as context. The agent proposes the change,
and the same hunk review opens. Esc or Stop cancels, and the workspace stays as it was.

If a model answers in plain text instead of calling the tools, ForgeLens takes the code block that best matches
the selection and opens the same review, with a note on the card saying so. A model that stages an edit but never
asks for review gets the review too. Nothing reaches disk unless you accept it.

## How a change reaches disk

The agent stages edits, which write nothing. When it calls `apply_changes`, TrueForge pauses for approval and
ForgeLens opens a review instead of a plain Allow button: one diff per file with **Accept hunk | Reject hunk**
above every hunk, Accept all, Reject all and Apply decisions in the title bar, and a **Changes** tree. Only
accepted hunks are written, in one atomic edit across files. **ForgeLens: Undo last applied change**, or Undo on
the panel's card, restores every touched file. Undecided hunks count as rejected. If a file changed during
review, ForgeLens recomputes the diff and asks again rather than overwriting it. Undo refuses to overwrite edits
made after the apply. Stop discards everything staged.

The undo stack lasts until the window closes.

**Reading a diff on a small screen.** Word wrap is on for diffs, and a review shows them inline
(`forgelens.review.inlineDiff`, on by default), so nothing needs horizontal scrolling. VS Code has no per-tab option
for this, so ForgeLens changes your `diffEditor.renderSideBySide` setting during a review and puts it back afterwards.

**Ctrl+Z after an apply.** In an editor showing one of the edited files, it reverts every edited file in that apply
and saves them, and the card shows the revert. In the agent panel it does the same as the Undo button. With no
editor open and focus elsewhere, it does nothing, as usual. New and deleted files are not covered by Ctrl+Z in an
editor, so use Undo for an apply that includes them.

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
model requests. For a real agent run, pass `live` or `task-a-live` as the scenario:
`node test/e2e/launch.mjs <workDir> task-a-live`. It downloads its own copy of VS Code, or set `VSCODE_EXE` to use
another. It stops at the start if the system drive or the work folder's drive has under 2 GB free.

## Rehearsing the tasks without a window

`npm run rehearse:a` and `npm run rehearse:b` run the exact tasks on a throwaway clone of Flask, with no VS Code window, on the same code as the extension. The only stand-in is the person, who accepts every hunk. Each run then checks the result: the exact verification commands, the tests, and for Task B the new command against a small app. Pass `--models a/b,c/d` to try models in order, and `--scripted good` or `--scripted bad` for a dry run with no model, which proves the checks catch a wrong answer. Results go to `out/rehearse-*.json`. A run stops at the start if under 1 GB of RAM or 2 GB of disk is free.

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
