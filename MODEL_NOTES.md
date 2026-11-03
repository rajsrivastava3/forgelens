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

## Groq: `openai/gpt-oss-120b` does not work through TrueForge 0.183.0

The model is live and makes the first tool call. The next request then fails every time:

```
[Model Error] Request failed (400): 'messages.2' : for 'role:assistant' the following must be
satisfied[('messages.2' : property 'reasoning_content' is unsupported)]
```

Cause, from the TrueForge source: the OpenAI-compatible adapter replays model reasoning as
`reasoning_content`, and Groq rejects that field. Groq's docs offer `include_reasoning: false` for
GPT-OSS models, but TrueForge only forwards an allowlist of body fields to compatible endpoints, and
this is not on it. We tried it and got the same error.

This looks like an upstream TrueForge issue for providers that reject replayed reasoning, and may be
worth reporting.

Replacement chosen for testing: `llama-3.3-70b-versatile`. Groq documents tool use for it. Whether it
avoids the error is **not yet verified**.

## What this means

- The extension cannot assume a named model is usable on a given day, so ModelChain needs to treat 429
  and 503 as normal events.
- `gemini-flash-lite-latest` is the most dependable model tested on this free tier. Its daily limit was
  not reached and is not known.
- Task B needs many requests per turn. A 20-per-day model cannot rehearse it, so budget quota for
  recording day or use a paid key.
