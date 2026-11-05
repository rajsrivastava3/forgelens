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

## What this means

- The extension cannot assume a named model is usable on a given day, so ModelChain needs to treat 429
  and 503 as normal events.
- `gemini-flash-lite-latest` is the most dependable model tested on this free tier. It did hit its
  per-minute limit once in the bake-off. Its daily limit was not reached and is not known.
- Task B needs many requests per turn. A 20-per-day model cannot rehearse it, so budget quota for
  recording day or use a paid key.
