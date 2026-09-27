# Trim

Trim quietly drops old tool output — file reads, command results, search hits — that your agent doesn't need anymore, before your next request goes out. There's nothing to configure and nothing to look at: it works from the moment it's on, and its own pill in the top slot shows what it's actually saved. If something it dropped turns out to still matter, the agent just reads it again — that re-read is charged back against the savings, so the number you see is never a bluff.

## The 25% number

Replaying Wibble's own past sessions — dropping any tool output more than 5 calls old, in batches every 20 calls, with every re-read charged back — cost about **$950 instead of $3,870** over that replay: roughly a **25% cut**, on real past work, not a synthetic benchmark.

## How it decides what to cut

A tool output becomes a candidate once it's more than 5 calls old. Every 20 calls, Trim looks at that thread's candidates:

- **Long threads (more than 25 calls):** skip the judge entirely and cut on age alone — at that length, asking isn't worth what asking costs.
- **Shorter threads:** ask a small model running on your own machine (see below) how likely it is the agent still needs that specific output for what the operator just asked. Only a confident "still needed" keeps it. Anything else — a confident "not needed," a weak answer, or no answer at all because the judge is off or hasn't reached it yet — gets cut. The judge can only ever *save* an item; it never adds a cut the age rule wasn't already going to make.

Honestly: the judge isn't great. On 337 real tool outputs from 42 past tasks, each hand-labeled as actually needed or not, it told needed apart from not-needed correctly about 76% of the time (50% would be a coin flip, 100% would be never wrong). That's worth asking, not worth trusting blindly — which is exactly why an item with a shaky or missing verdict still falls back to the age rule instead of being kept indefinitely.

## Turning on the judge

Trim works with just the age rule if you skip this. To get the smarter behavior:

```bash
# 1. a venv for the model runtime (Apple silicon only)
python3 -m venv ~/.venvs/openjev
~/.venvs/openjev/bin/pip install mlx-lm

# 2. a local, quantized copy of a model you already have cached
~/.venvs/openjev/bin/python -m mlx_lm convert \
  --hf-path Qwen/Qwen3.5-4B \
  --mlx-path ~/.cache/openjev/qwen35-4b-q4 \
  --quantize --q-bits 4 --q-group-size 64 --dtype bfloat16

# 3. run it
~/.venvs/openjev/bin/python items/trim/openjev-serve.py \
  --model ~/.cache/openjev/qwen35-4b-q4
```

It listens on `127.0.0.1:8791` only, and holds the model loaded in memory so each question is fast. If it goes down, Trim notices within a minute, falls back to the age rule, and picks the judge back up on its own once it answers again — nothing to restart by hand.

## The pill

The chip in the top slot is Trim's own status, nothing more: a percent saved this week, and next to it a dollar figure (or, if the model isn't one we know the price of, a token count). It's on by default and has no settings of its own — you turn Trim on or off from Wibble's own Settings, the same as any other extension.

## What it can't do

Trim can only remove old tool output from what your agents send. It can't add anything, change anything, or see anything beyond that. It can't reach the internet or your files directly — the only address it's allowed to reach at all is `127.0.0.1:8791`, the judge on your own machine.

## Engines

Whether Trim sees a session at all depends on the engine and how it's signed in (measured 27 Sep 2026):

| Engine | Trimmed? |
|---|---|
| Claude Code (API key or claude.ai login) | Yes |
| Codex, signed in with a ChatGPT login | Yes |
| Codex, with an API key, or a `config.toml` pointing at its own provider | Not yet — runs direct, untrimmed |
| OpenCode, an OpenAI-compatible provider | Yes |
| OpenCode, other provider types | Not yet |

"Not yet" just means the session runs exactly as it would without Trim — nothing breaks, it simply isn't trimmed.
