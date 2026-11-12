# ForgeLens

A VS Code coding agent whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's
open-source agent harness, in local mode.

> Nothing touches disk until a human accepts a hunk, and the agent always shows what it read and why.

**Starting point:** from scratch (see [THIRD_PARTY.md](THIRD_PARTY.md) for the packages it depends on).
**Licence:** [MIT](LICENSE).

ForgeLens is a TrueForge client. Sessions and turns go through the TrueForge HTTP API and SDK, and models are
configured in TrueForge: the extension never calls a model provider and holds no API keys. Its editor capabilities
(read a file, search, stage an edit, apply reviewed changes, run a command) are MCP tools served by the extension
itself on `127.0.0.1`, and the agent decides which to call. The agent definitions it uses are in
[`agents/`](agents).

What it does:

- **Agent mode** in the ForgeLens panel: ask a question, or describe a change that may span several files.
- **Inline edit**: select code, press **Ctrl+Alt+K** or **Ctrl+Alt+E** (Cmd+Alt+K or Cmd+Alt+E on a Mac), or right-click and choose **ForgeLens: Edit selection**, and say what should change.
- **Per-hunk review**: every change opens as a diff with Accept hunk and Reject hunk above each hunk. Only accepted
  hunks are written, in one atomic edit, and **Undo** restores them.
- **Context you can see**: a Context Pack card says which files were chosen for a request and why, and a Plan card
  shows what the agent will change before it changes anything.
- **Automatic fallback** to the next configured model when one fails, with a banner that says why.

## Requirements

- **Node.js 22.14 or newer** (for TrueForge and the build). npm comes with it.
- **VS Code 1.90 or newer.**
- **Git.** On Windows, Git for Windows, which includes Git Bash.
- **Python 3.10 or newer**, only for the demo repository used by the three fixed tasks.
- An API key for a model provider TrueForge supports. The settings below assume Google Gemini.

## Quick start

1. **Get the code and build it.**

   ```bash
   git clone https://github.com/rajsrivastava3/forgelens.git
   cd forgelens
   npm ci
   npm run build
   ```

   With npm 11 or newer, `npm ci` may warn that install scripts were not run (esbuild's). The build works without
   them; nothing else is needed.

2. **Start TrueForge locally**, in a terminal of its own, from the `forgelens` folder:

   ```powershell
   # PowerShell
   .\scripts\start-trueforge.ps1
   ```

   ```bash
   # Git Bash, Linux, macOS
   ./scripts/start-trueforge.sh
   ```

   This runs TrueForge **0.183.0** (the same version as the SDK in `package.json`) at <http://localhost:8790> in
   local mode: one process and SQLite, no accounts. The scripts set
   `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`, because TrueForge blocks loopback URLs by default
   and ForgeLens's tools server runs on `127.0.0.1`. To start it by hand instead:

   ```powershell
   # PowerShell: the quotes around the package name are required
   $env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'; npx.cmd "@truefoundry/trueforge@0.183.0"
   ```

   ```bash
   OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@0.183.0
   ```

3. **Add a model in TrueForge.** Open <http://localhost:8790>, go to **Settings > Models**, choose the **Google
   Gemini** provider, paste your API key, and add the models you want. The names ForgeLens uses by default are
   `google-gemini/gemini-3-8-flash` (model ID `gemini-3.8-flash`) and `google-gemini/gemini-3-6-flash` (model ID
   `gemini-3.6-flash`). Any provider TrueForge supports works; then list its model names in `forgelens.models`
   (step 5). The key stays in TrueForge.

4. **Run the extension.** Open the `forgelens` folder in VS Code and press **F5** ("Run ForgeLens"). A second window
   opens, the Extension Development Host. In it, open the folder you want to work on, then the **ForgeLens** icon in
   the activity bar.

5. **Choose models** (optional). In the Extension Development Host's settings, set `forgelens.models` to the
   TrueForge model names to use, primary first. [`config/models.example.json`](config/models.example.json) shows the
   recommended settings. If you set nothing, ForgeLens uses the first two defaults that TrueForge has, or else the
   first model TrueForge lists. Click the model in the status bar to switch.

The "Run ForgeLens" configuration starts that window with your other extensions turned off (`--disable-extensions`),
because installed extensions can take the same shortcut: two common ones (an AI chat extension and a code
runner) both bind **Ctrl+Alt+K**, and the one installed last wins. The second configuration, "Run ForgeLens with your other extensions", keeps them; there,
use **Ctrl+Alt+E** or the right-click menu if Ctrl+Alt+K does something else.

### Loading the agent definitions

ForgeLens loads its agents by itself. On start, and before each request, it registers its MCP server with TrueForge
(`forgelens-editor`) and saves the two agents from [`agents/`](agents) (`forgelens-agent` for agent mode,
`forgelens-inline` for inline edit) with the primary model filled in. Run **ForgeLens: Set up TrueForge** from the
Command Palette to repeat it. Without VS Code, `npm run setup:agents -- google-gemini/gemini-3-8-flash` saves the same
agents. The agent files say `${FORGELENS_MODEL}` instead of a model name, so no agent is tied to one provider.

Only one window at a time can host the tools, because they use a fixed local port (`forgelens.mcpPort`, default 8799).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `forgelens.models` | `["google-gemini/gemini-3-8-flash", "google-gemini/gemini-3-6-flash"]` | TrueForge model names, primary first, fallbacks after |
| `forgelens.reasoningEffort` | `low` | Sent as `model.params.reasoning_effort` (`default` sends nothing). `low` made Task A 4 to 6 times faster and Task B 2.5 times faster, and both still passed |
| `forgelens.context.budgetTokens` | `6000` | Size of the Context Pack added to each agent request |
| `forgelens.firstTokenTimeoutSeconds` | `20` | A model with no output by then is retried, then replaced. Raise it for a higher reasoning effort |
| `forgelens.commands.autoApprove` | `pytest`, `python -m pytest`, `git status`, `git diff` | Commands answered without asking, still through TrueForge's approval |
| `forgelens.review.inlineDiff` | `true` | Show review diffs inline rather than side by side |
| `forgelens.trueforgeUrl` | `http://localhost:8790` | Where TrueForge runs |

## The three fixed tasks

The tasks run on Flask 3.1.3. Clone it **beside** this repository (as `../flask`), with line endings left alone so
`git status` stays clean:

```bash
cd ..
git clone -c core.autocrlf=false --branch 3.1.3 https://github.com/pallets/flask.git flask
cd flask
python -m venv .venv
# Windows: .venv\Scripts\activate    Linux, macOS: source .venv/bin/activate
pip install -e . pytest asgiref -c ../forgelens/scripts/flask-test-constraints.txt
echo .venv >> .git/info/exclude
python -m pytest -q
```

The constraints pin pytest 9.0.2: newer pytest fails to collect `tests/test_cli.py` on Flask 3.1.3, and
`asgiref` is needed by one test in `tests/test_helpers.py`. Open the `flask` folder in the Extension Development
Host. To reset it between tries: `git checkout -- . && git clean -fd -e .venv`.

**Task A, inline edit.** Open `src/flask/helpers.py`, select the whole function `get_debug_flag`, press
**Ctrl+Alt+K** and enter:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value
> that is treated as false.

Review the hunks, accept, and apply. Check it in Git Bash:
`FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False`.

**Task B, agent mode.** In the ForgeLens panel, enter:

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking
> the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be
> covered by a test, and be documented alongside the other built-in commands.

The panel shows the Context Pack card, the explorer subagent's thread, the Plan card, the staged test run and then
the review. Accept and apply, then check: `python -m pytest tests/test_cli.py -q` passes, `flask --help` lists
`config`, and `flask --app <any app> config` prints masked JSON. **Open session in TrueForge** in the panel shows
the same session, with its turns, threads and tool calls.

**Task C, resilience.** Task A again, with a broken primary model. See [Recording Task C](#recording-task-c).

Before each take, `.\scripts\demo-prep.ps1` checks that TrueForge is up (and starts it if not), resets the `flask`
folder, shows the models and reasoning effort ForgeLens will use, checks that `broken-primary` exists but is not the
primary, shows free RAM and disk, and prints READY. After Task C, `.\scripts\demo-prep.ps1 -AfterTaskC` puts the real
primary back first in `forgelens.models`.

## How the agent chooses what to read

The strategy is budgeted multi-signal retrieval. ForgeLens indexes the workspace in the background, in small slices
so the editor stays free, and keeps the index in VS Code's extension storage, never in your folder. It updates when
you save. Before each agent request it ranks files by word matches (BM25, with identifiers split so `get_debug_flag`
matches "debug flag"), how much of the request a file covers, file and symbol names, imports, test and doc pairings
such as `cli.py`, `tests/test_cli.py` and `docs/cli.rst`, the changelog for changes, open editors, and anything you
`@` mention, which always goes in.

Then it fills a budget of 6k tokens (`forgelens.context.budgetTokens`): the top files get their best functions in
full, with the place in the same file that uses them (such as the list that registers a command) and a short outline
of the rest (definitions named like the shown code first, or a doc's section titles). The next files get signatures
only, the rest just a path and a reason, and anything left over is recorded as left out. A file whose own match is
weak stays only with a strong link to one of the two best hits. The panel shows this as "Context chosen: N files,
X / 6k tokens", with the reason for each file. Type `@` in the panel to add a file or symbol.
`npx tsx scripts/show-pack.ts <repo> "<request>"` prints the pack for a request.

## Plan, then implement

A change in agent mode runs as two turns of one TrueForge session. The first carries the Context Pack and the
request, and asks for a plan. The agent hands its lookups to an explorer subagent (`create_sub_agent`), which may make
3 reads or searches in all, enforced by ForgeLens's tools server, and returns file:line targets with reasons. The
agent then writes one line per file, naming the functions or lines to change and why. The panel shows it as a Plan
card. ForgeLens then sends the second turn, in the same session: implement the plan, stage in as few calls as
possible, run the tests once on the staged copy, apply once. A question gets a plain answer and no second turn.

This is a design decision, not a second agent loop. The agent still decides what to read and what to change;
ForgeLens only splits the turn, so the plan is on screen before any edit, and the edits follow it. Without the split,
the model kept researching edge cases and never staged (three paid runs, none reached a diff). With it, every Task B
run since has passed. If the second turn fails over to the fallback model, the new session gets the request, the plan
and the step together.

Reads are also capped. After 8 reads or searches in a turn with nothing staged, `read_file`, `search_code`,
`find_symbol`, `find_references`, `retrieve_context` and `repo_map` answer "Read limit reached. Stage your
edits with stage_edit now; reads unlock after the next stage_edit." Any staging attempt or a new turn unlocks them.

Only `retrieve_context`, `read_file`, `stage_edit`, `stage_replace_lines`, `apply_changes` and `run_command` are loaded up front. The other
ten tools are deferred: the agent finds them through TrueForge's `list_tools` and `get_tool_info` when it needs
them, which saves about 1,100 tokens of tool definitions on every request (`npx tsx scripts/tool-sizes.ts`).

## How edits are matched

`stage_edit` takes search and replace pairs. Each `old_text` is looked for as given, then with whitespace
differences ignored, then with blank lines ignored, then as a block whose first and last lines match and whose
middle is close (at most a third of the lines different, and only one such place in the file). The last two are
reported as approximate, with the number of lines that differed, and the diff in the result shows exactly what was
replaced, so the model can see whether it meant that. An edit whose `new_text` is already in the file once is
skipped as already applied. One whose `old_text` is not found is not an error: the result says where its first
and last lines are, the nearest places, and how to go on. `stage_replace_lines` then edits by the line numbers
`read_file` shows, with no text matching at all, and `unstage_file` drops what is staged for one file so the model
can start that file again from disk. Both agents are told never to resend a missed `old_text` from memory.

## Running tests before review

`run_command` with target `staged` runs in a private copy of the workspace with the staged edits applied, kept in
extension storage, so tests can pass or fail before you review anything. Target `workspace` runs in the real folder.
Commands on `forgelens.commands.autoApprove` (`pytest`, `python -m pytest`, `git status`, `git diff`) are answered
automatically, still through the TrueForge approval, and the card says "auto-approved (safe list)". Anything else
asks you, including any command with shell syntax such as `;` or `|`. Stop ends a running command.

## Inline edit

Select some code and press **Ctrl+Alt+K** or **Ctrl+Alt+E** (Cmd+Alt+K or Cmd+Alt+E on a Mac), or right-click and choose **ForgeLens: Edit
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

## Models and automatic fallback

`forgelens.models` is an ordered list of TrueForge model names: the first one TrueForge has is the primary, and
the rest are fallbacks. Click the model in the status bar to choose another primary from everything TrueForge
lists; the rest keep their order.

Every request, in agent mode and inline edit, goes through the same chain:

- A billing refusal (402), a bad key (401, 403, or a 400 that says so), an unknown model (404) or a request the
  provider will not take (400) moves to the next model at once.
- A quota limit (429), an overloaded provider (5xx), an unreachable provider, or no output within
  `forgelens.firstTokenTimeoutSeconds` (20 s, before the first output only) is retried twice, after about 1 s and
  3 s with some randomness, and then moves to the next model.
- The next model gets a new session with the same agent and only the model swapped, and the same request with the
  same Context Pack. Anything the failed attempt staged is dropped, so nothing from it can reach disk.
- The panel says so: "Primary model failed: invalid API key (401). Switched to gemini-3-8-flash automatically."
  The status bar shows the model with "(fallback)".
- If every model fails, one message says why, with a **Switch model** button. If TrueForge itself is down, the
  message says how to start it.

## Recording Task C

Task C needs a primary that fails. Keep the real providers as they are and add a broken one beside them:

1. Open <http://localhost:8790>, **Settings > Models > Add custom provider**, and fill in:
   name `broken-primary`, base URL `https://generativelanguage.googleapis.com/v1beta/openai/`, API key
   `not-a-real-key`, model ID `gemini-3.8-flash`, model name `gemini-3-8-flash`, context length `1048576`, max output
   `65536`. (`npm run rehearse:c` creates the same entry for you.)
2. In VS Code, click the model in the status bar and choose `broken-primary/gemini-3-8-flash`. Your previous
   primary moves to second place and becomes the fallback.
3. Record Task A as usual. The banner appears within about a second ("Primary model failed: request rejected
   (400), possibly an invalid key. Switched to gemini-3-8-flash automatically."), the fallback finishes the edit, and
   the review opens as normal. Afterwards `git status` shows only `src/flask/helpers.py`, from the accepted edit.
4. To restore: click the model in the status bar and choose your real primary again. Delete `broken-primary` under
   **Settings > Models** if you no longer need it.

For an unreachable endpoint instead, give `broken-primary` the base URL `http://127.0.0.1:59999/v1`. That shows two
quick retries before the switch.

## Tests

- `npm test` runs the unit tests (vitest). They use no model and no network; a few replay events recorded from real
  TrueForge sessions. The tests that rank files in the real Flask repository run when `../flask` exists (or
  `FORGELENS_FLASK` points to a checkout), and are skipped otherwise.
- `npm run test:e2e` drives the real panel and review in an Extension Development Host, on a throwaway clone of
  `../flask`, and saves screenshots to `docs/screenshots/`. Its default scenarios use scripted events and no model.
  For a real agent run, pass `task-a-live`: `node test/e2e/launch.mjs <workDir> task-a-live`. It downloads its own
  copy of VS Code, or set `VSCODE_EXE` to use another. It stops at the start if a drive it uses has under 2 GB free.

### Rehearsing the tasks without a window

`npm run rehearse:a`, `npm run rehearse:b` and `npm run rehearse:c` run the exact tasks on a throwaway clone of
Flask, with no VS Code window, on the same code as the extension. The only stand-in is the person, who accepts every
hunk. Each run then checks the result: the exact verification commands, the tests, and for Task B the new command
against a small app. Pass `--models a/b,c/d` to choose models. Each run prints its requests, tokens, an estimated
cost, and a timeline (plan card, first staged edit, review open). `npx tsx scripts/spend-report.ts` prices every
session TrueForge has kept.

`--scripted good` or `--scripted bad` replays a scripted answer with no model, which proves the checks catch a wrong
one. Answers to the fixed tasks are not kept in this repository: those dry runs read them from JSON files in
`FORGELENS_FIXTURES`.
