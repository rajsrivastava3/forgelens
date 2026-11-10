# Model notes

Raw results from `npm run spike`, for the write-up's "Model setup" section. Measured on 3 November 2026
with TrueForge 0.183.0 on Windows, from India. These are one day's small samples, not benchmarks.

All models were configured in TrueForge. The extension and scripts never call a provider directly.
Cost so far: $0 (free-tier keys).

## Results

"Tool call" means our MCP `read_file` ran, seen in both the TrueForge stream and our server's log.
"Correct" means the answer named the true line, 28.

| TrueForge model name | Tool call | Correct | Subagent called our tool | Approval gate | First token / turn (read test) | Errors seen |
|---|---|---|---|---|---|---|
| `google-gemini/gemini-flash-lite-latest` | yes | yes | yes | all paths pass | 1.4 s / 4.1 s (best); 1.9 s / 9.1 s | none, over about 47 model messages |
| `google-gemini/gemini-3-1-flash-lite` | yes | yes | not tested | not tested | 1.9 s / 20.2 s | none |
| `google-gemini/gemini-3-6-flash` | yes | yes | see note 1 | allow passed; deny not completed | 4.9 s / 18.0 s; 30.4 s / 33.4 s | 503, 429 |
| `google-gemini/gemini-3-5-flash` | yes | yes | not tested | not tested | 10.8 s / 21.1 s | 429, passed on retry |
| `google-gemini/gemini-3-8-flash` | not proven | - | not proven | not proven | no response | 503, then 429 daily quota |
| `google-gemini/gemini-flash-latest` | not proven | - | not proven | not proven | no response | 503, then 429 on the 3.8 quota |
| `google-gemini/gemini-3-7-flash` | not proven | - | not tested | not tested | no response | 429 |
| `google-gemini/gemma-4-31b-it` | no | - | not tested | not tested | 57.5 s to first token | 500, high-demand error |
| `groq/gpt-oss-120b` | **fails** | - | not tested | not tested | 0.7 s, then 400 | see Groq below |
| `groq/llama-3-3-70b-versatile` | **fails** | - | not reached | not reached | 404 in under 1 s | shut down by Groq, see below |

Note 1: `gemini-3-6-flash` created a subagent thread and our server logged the read, but the run hit my
time limit before the per-thread attribution was written, and the subagent turn took 96 s.

Approval paths tested on `gemini-flash-lite-latest`: preloaded, preloaded through `call_tool`, deferred
through `call_tool`, and from a subagent. Each with allow (tool ran once) and deny (tool never ran).

## Free-tier limits observed on Gemini

Quoted from the provider's 429 messages:

- `gemini-3.8-flash`: **20 requests per day** and 5 per minute.
- `gemini-3.6-flash`: 5 requests per minute.
- `gemini-flash-latest` draws on the `gemini-3.8-flash` quota, so it is not a separate allowance.

Across the day's failed turns, the TrueForge log shows 30 turns ending in 429, 6 in 503 and 1 in 500 at
the time of counting, most of them from retrying `gemini-3.8-flash` after its daily quota ran out.

One 503 took 139 s to surface as a failed turn, which supports a first-token timeout in ModelChain.

## Multi-file bake-off

`scripts/bakeoff.ts` gives a model the same task on a throwaway copy of Flask: add `env_flag` to the
helpers, export it from the package and add a test, without being told the file names. The script then
runs the code itself: a behaviour check and `pytest tests/test_helpers.py`. Spent: 30 requests in 259 s.

| Model | Result | Found the files itself | Edits | Requests | Time | Tokens in / out |
|---|---|---|---|---|---|---|
| `gemini-flash-lite-latest` | **pass**: behaviour correct, 48 tests pass, 14 of them new | yes, all 3 | 3 applied, 0 failed | 22 | 92 s, including a 49 s rate-limit wait | 119,355 / 1,419 |
| `gemini-3-6-flash` | quota-blocked (per-day limit) | no | none | 4 | 86 s | 2,132 / 460 |
| `gemini-3-5-flash` | quota-blocked (per-day limit) | no | none | 3 | 75 s | none reported |
| `groq/llama-3-3-70b-versatile` | failed: 404 | no | none | 1 | 1 s | none |
| `gemini-3-8-flash` | not run: per-day quota still exhausted | - | - | - | - | - |

The two blocked Gemini models had already spent their daily quota on earlier tests today, so they were
**not compared on quality**. One pass on one task is also not proof that a model can do Task B.

Cost: `turn.done` reported $0 for every run. That reflects free-tier keys or no price data, so it says
nothing about what a paid key would cost. Use the token counts for that estimate.

The check on `gemini-3-8-flash` at 21:56 IST returned this body, so quota had not reset:

```
[Model Error] Request failed (429): You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.
* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash, description: Generate content requests per day limit exceeded on Free Tier. See https://ai.google.dev/gemini-api/docs/rate-limits.
Please retry in 15h33m42.391686148s.
```

## Groq

**`openai/gpt-oss-120b` does not work through TrueForge 0.183.0.** The model is live and makes the first
tool call. The next request then fails every time:

```
[Model Error] Request failed (400): 'messages.2' : for 'role:assistant' the following must be
satisfied[('messages.2' : property 'reasoning_content' is unsupported)]
```

Cause, from the TrueForge source: the OpenAI-compatible adapter replays model reasoning as
`reasoning_content`, and Groq rejects that field. Groq's docs offer `include_reasoning: false` for
GPT-OSS models, but TrueForge only forwards an allowlist of body fields to compatible endpoints, and
this is not on it. We tried it and got the same error. This looks like an upstream TrueForge issue for
providers that reject replayed reasoning, and may be worth reporting.

**`llama-3.3-70b-versatile` no longer exists.** Groq returns "does not exist or you do not have access
to it". Groq's deprecations page lists its shutdown as 16 August 2026, although its models page still
lists it. Check the deprecations page when choosing a Groq model.

**Next candidate, not yet tested: `qwen/qwen3.8-27b`.** Groq documents tool use for it, and says it returns
no reasoning tokens at its default effort, which should avoid the error above. It is a preview model, and
Groq says those may be discontinued at short notice.

## Recommendation

- **Primary: `google-gemini/gemini-flash-lite-latest`.** It is the only model with evidence for every
  behaviour: tool calls, a subagent, approval on every path, and the multi-file task.
- **Fallback: not decided.** No second model has passed yet. `groq/qwen3-8-27b` is the candidate, because
  a different provider also survives a Gemini outage. `gemini-3-1-flash-lite` passed the read test and could
  stand in, but it uses the same key and may share quota with the primary.

## Throttling seen during panel testing

Later the same evening, `gemini-flash-lite-latest` slowed sharply. The same question took 7 to 9 s early on
and 127 s later, with each model step taking about 45 s and no error reported. Sometimes it returned a 429
per-minute error instead. The cause is not confirmed; heavy use that day and provider rate limiting are the
likely explanations. Rehearsals on a free key can therefore be much slower than a single good run suggests.

## P2 live review run

On 4 November `gemini-flash-lite-latest` staged edits in two files and reached the review on the first try: 95 s
in total including the scripted review, 8,340 tokens, no 429. It called `stage_edit` and `apply_changes`
directly this time, not through `call_tool`. Session: `01m6hr3n5fa3m3kgwcedvcnj5t`.

## Prepaid billing removes the free tier

On 5 November the Gemini project showed tier "Paid 1" with a prepaid balance of zero. Every model on the key then failed the same way, free ones included, in about half a second and with no tokens used:

```
[Model Error] Request failed (402): Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.
```

Tested: gemini-3-8-flash, gemini-flash-lite-latest, gemini-3-1-flash-lite, gemini-3-5-flash-lite. So moving a project to prepaid ends its free rotation until credit arrives, and a fallback on the same key does not survive this. A second provider would.

## 6 November: paid primary, free fallback

**Primary `google-gemini/gemini-3-8-flash` (paid, prepay).** Exact Task A, live, after one fix to the inline agent's
instructions: 4 of 4 passed, each 3 requests, 23 to 35 s from instruction to diff, about Rs 1.45 to 1.76 each (corrected formula). Before
the fix, 3 of 3 failed: the model spent all 15 steps searching for docstring conventions and never staged an edit
(about Rs 4.40 each).

**Task B, one live run: no result, about Rs 31 (first estimated at Rs 123).** 1,663,659 input tokens in one turn, 1,442,672 of them cache reads. The explorer subagent made
about 30 reads, the main agent re-read most of them, and it never staged an edit before trying out code with
`run_command`, which needs approval. The instructions then bounded the explorer and kept `run_command` for tests. The runs below
followed.

**Reasoning effort `low` (7 November IST), the default since.** `model.params.reasoning_effort` goes to the
saved agents and to fallback sessions (`forgelens.reasoningEffort`). Low passed on the first try, so medium was not
needed.

| Run | Effort | Result | To diff | Total | Requests | Input tokens (cache reads) | Output | Cost |
|---|---|---|---|---|---|---|---|---|
| Task A, earlier (4 runs) | default | 4 pass | 23 to 35 s | | 3 | about 13,500 | about 2,900 | Rs 1.45 to 1.76 |
| Task A | low | pass | 5.9 s | 8.3 s | 3 | 8,509 | 337 | Rs 0.69 |
| Task B, earlier (2 runs) | default | 2 pass | | 154 to 181 s | 15 to 20 | 262,792 to 392,948 | 7,648 to 10,834 | Rs 7.37 to 10.01 |
| Task B 1 | low | pass, 3 files, 4 hunks | 62.6 s | 66.1 s | 16 | 177,061 (131,147) | 2,641 | Rs 4.88 |
| Task B 2 | low | pass, 3 files, 4 hunks | 58.6 s | 62.8 s | 14 | 153,367 (109,812) | 2,424 | Rs 4.50 |

Timeline of Task B run 2, from sending the instruction: Context Pack card at once, explorer thread from about 4 s,
Plan card at 21.5 s, first staged edit at 39.4 s, staged pytest and the review open at 58.6 s. Both low runs used
the explorer subagent in the plan turn (3 tool calls), staged once per file, ran pytest on the staged copy, and
applied once. Sessions 01m6qwngp44thhmerc492devyd and 01m6qwsd0kt6hxbr4kdpwdkzkr; Task A 01m6qwmb70y0takcs5rd1ervvy.
The Context Pack stays at 6k: it is under 10% of a request's input and saves the reads it replaces.

**Task A on a second model, `google-gemini/gemini-3-6-flash` at the default reasoning effort (10 November): pass.** One
run, to check the inline instructions are not tuned to one model: 67.9 s total, 4 requests, about Rs 1.88, every
Task A check passed. The first attempt produced no output within the 45 s first-token timeout (the model thinks
longer at its default effort), so ForgeLens cancelled it and retried the same model in a fresh session, which
answered in 22 s: stage_edit, apply_changes, one sentence. Sessions 01m730fb4rm7wh35chxanr7e5r (timed out) and
01m730gr1kkpby86qbgxps3sxk. At effort low the same task takes 6 to 9 s, so low stays the default.

**Inline edit with models that misbehave (scripted, no model, in a real VS Code window, 10 November).** Each ends
in a reviewable diff or a clear message, never a half state: a model that answers with a code block instead of
calling tools (the block is staged and reviewed, the card says so); one that edits outside the selection too (both
hunks show, the stray one is rejected, only the selection lands: "Applied 1/2 hunks in 1 file"); one that stages
and stops without apply_changes (ForgeLens opens the review and says why); one that sends malformed tool
arguments, then an edit that matches nothing, then gives up (both calls show as errors on their cards, the run ends
with "The model did not propose a change", nothing staged, git clean). Scenarios inline-fallback and inline-robust
in test/e2e/run.ts; screenshots p7-3 and p7-4. Stop after something is staged discards it and the panel says
"Cancelled, workspace unchanged" (scenario stop-staging, screenshot p7-2).

**TrueForge context-engineering features in the session (B4 evidence).** All in one passing Task B run (low effort,
70.9 s, 15 requests, Rs 4.69, 3 files, 5 hunks, 57 tests pass): session 01m6r1qcx0s4pp2eqjdyce5tav, at
http://localhost:8790/sessions/01m6r1qcx0s4pp2eqjdyce5tav. Times are from the start of the first turn.

| Feature | What to point at | Event types |
|---|---|---|
| Subagent | 4.4 s: the main agent calls `create_sub_agent`; a thread named explorer runs until 16.6 s and returns file:line targets; the plan follows at 20.6 s | `model.message` with tool `create_sub_agent` (`truefoundry-system`), `thread.created`, messages with the explorer's `thread_id`, `thread.done` |
| Deferred tool loading | 6.9 s: the explorer calls `get_tool_info` for `search_code`, which is not preloaded; 8.9, 11.2 and 13.5 s: it calls `call_tool` with `tool_name: search_code`. 5 tools are preloaded, 9 deferred; each request's `input_tokens_breakdown.tool_definitions` is about 880 tokens instead of about 2,100 | `model.message` with tools `get_tool_info` and `call_tool` (`truefoundry-system`), each followed by `tool.response` |
| Tool approval drives the review | The staged pytest (`run_command`, answered from the safe list) and `apply_changes`, whose approval opens the hunk review | `tool.approval_required`, then a turn whose input is `user.tool_approval` |
| Two turns, one session | Turn 1 ends with the plan (`turn.done` at 20.6 s); turn 2, the implementation, starts at once in the same session | `turn.created`, `turn.done` |
| Compaction | Configured at 75,000 input tokens (`context_management.compaction`); the panel shows its notice (scripted e2e). It does not fire in a normal Task B run | `thread.context_compaction_started`, `thread.context_compaction_finished` |

Compaction was not moved down to about 30k, on purpose. The largest request in a low-effort Task B run is about
17k input tokens, so a 30k trigger would never fire. A trigger low enough to fire would replace the history with a
summary in the middle of the implement turn, which is where the agent needs the exact text it read for
`stage_edit`'s `old_text`, and it would break the prompt cache, which already serves about 70% to 80% of input
at a tenth of the price. It would cost a summary request and save little. It stays at 75k, as a guard for long
conversations.

**Task B with plan, then implement (7 November IST): 2 of 2 passed on `google-gemini/gemini-3-8-flash`.**

| Run | Plan turn | Implement turn | Requests | Input tokens (cache reads) | Output | Cost | Time | Files, hunks | Staged pytest |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 3 searches, 2 requests | 9th read refused by the limit, then staged | 20 | 392,948 (332,065) | 10,834 | Rs 10.01 | 181 s | 4 files, 7 hunks | yes, auto-approved |
| 2 | 1 read, 2 searches, 2 requests | 9th read refused by the limit, then staged | 15 | 262,792 (213,169) | 7,648 | Rs 7.37 | 154 s | 4 files, 6 hunks | yes, auto-approved |

Both plans named `src/flask/cli.py` (the command, registered in `FlaskGroup.__init__`), `tests/test_cli.py`,
`docs/cli.rst` and `CHANGES.rst`, each with a reason. After accepting: `pytest tests/test_cli.py -q` gives 57
passed, `flask --help` lists config, and `flask config` prints JSON with SECRET_KEY, DATABASE_PASSWORD, API_TOKEN
and SIGNING_KEY as "***" and NORMAL_SETTING visible. Sessions 01m6qtrkdr3yyhbharrp9f7ba6 and
01m6qtzfw2xk64mtp70q74c8nt. A Task B take costs about Rs 7 to 10.

**Task B after cutting cost (6 November): 3 live runs, 0 passed.** Changes before
them: a 6k Context Pack with use sites and outlines, read_file capped at 150 lines, an iteration limit of 25, and
instructions to plan once, stage in few calls, test once and apply once. Each run was stopped before staging:

| Run | Requests | Input tokens (cache reads) | Estimate | What the agent did |
|---|---|---|---|---|
| 1 | 25 | 372,455 (304,684) | Rs 8.95 | One call per message: 2 to find run_command, then 23 small searches and reads. Hit the iteration limit. The cost guard did not fire: it read usage from the empty message shell, not the delta that carries it. Fixed. |
| 2 | 16 | 252,136 (200,540) | Rs 7.82 | Batched 4 searches once, then 9 requests on how config values serialise to JSON. Stopped by the cost guard. |
| 3 | 14 | 263,480 (216,251) | Rs 8.17 | Wrote a plan and made 5 reads in its first message, as now instructed, and 2 in the next. Then 11 one-call requests on JSON serialisation and the changelog layout, ignoring a note on each result that it had enough to stage. Its last two messages had 3.6k and 2.6k output tokens, likely the edit, when the cost guard stopped it. |

A probe showed gemini-3-8-flash makes several tool calls in one message when asked (2 requests for 2 reads).
Each request carries the whole conversation (9k tokens at the start, 28k by request 14), so the request count is
what costs. About 80% of input tokens were cache reads. The costs in these tables use the corrected formula below.

**Task C (6 November), both modes pass, fallback `google-gemini/gemini-3-8-flash`.** Invalid key: the custom
provider answers with a bare 400, the banner says "request rejected (400), possibly an invalid key", the fallback
finishes the edit in 36 s and 4 requests (about Rs 2.50). Unreachable endpoint: two retries (1 s, 3 s), then the
fallback finishes in 25 s and 6 requests (about Rs 1.45). Both: `git status` empty at the switch, every Task A check
passes after accepting, only `src/flask/helpers.py` changed.

**`gemini-free/gemma-4-31b-it` (custom provider, free key), 6 November: one tool round trip fails.** read_file ran
once, then the turn failed with "Response stream ended without a finish reason" after 4 requests and 84 s, and the
answer held raw `<thought>` text. Removed from the provider and not used as a fallback.

TrueForge reports no cost for these models, so cost is worked out from tokens at Google's paid prices
(aistudio.google.com/docs/pricing, checked 7 November): for 3.8 Flash and 3.6 Flash, $0.75 per million input tokens,
$0.075 per million cache reads and $3.75 per million output tokens, thinking included, to 31 December 2026; for
3.1 Pro Preview, $2.00, $0.20 and $12.00 for prompts up to 200k tokens. TrueForge's input count includes cache reads,
and its output count includes thinking. Rs 90 to the dollar. An earlier formula priced cache reads at the input rate
and added thinking twice, which made estimates about 3x too high. `scripts/spend-report.ts` re-prices every kept
session with the corrected formula: Rs 83.43 for the sessions up to 6 November, against Rs 85.02 on the AI Studio
spend page.

**Fallback `gemini-free/gemini-flash-lite-latest` (custom OpenAI-compatible provider, free key).** A plain request
works. Tool calls fail on the second request with `400: Bad Request`. The native `google-gemini` provider stores
Gemini's `thought_signature` with each tool call (`provider_specific_fields`) and sends it back. The custom
provider's stored calls have no such field, and the newer Gemini models expect it back. TrueForge allows only one
provider per built-in type, so a second native Gemini provider for the free key is not possible. This fallback cannot
complete an edit as configured.

## What this means

- The extension cannot assume a named model is usable on a given day, so ModelChain needs to treat 429
  and 503 as normal events.
- `gemini-flash-lite-latest` is the most dependable model tested on this free tier. It did hit its
  per-minute limit once in the bake-off. Its daily limit was not reached and is not known.
- Task B needs many requests per turn. A 20-per-day model cannot rehearse it, so budget quota for
  recording day or use a paid key.
