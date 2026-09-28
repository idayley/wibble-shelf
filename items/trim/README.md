# Trim

Trim quietly drops old tool output — file reads, command results, search hits — that your agent doesn't need anymore, before your next request goes out. There's nothing to configure and nothing to look at day to day: it works from the moment it's on, and its own pill in the top slot shows what it's actually saved. Hover (or focus) that pill and it opens a small card with the working behind the number. If something it dropped turns out to still matter, the agent just reads it again — that re-read, and the extra request it takes, are charged back against the savings, so the number you see is never a bluff.

## What it actually saves

A cut isn't free: once something is dropped, everything after it in the conversation has to be written into the model's cache again on the next request, instead of being read cheaply from it. So Trim only cuts something when the money that saves over the rest of the conversation is expected to beat the cost of that one rewrite — see "How it decides what to cut" below. Every number here is what that rule actually earned, not a guess.

To check it, this was replayed on one person's real Claude Code history from 27 Sep 2026 — about 133,700 requests across roughly 7,700 conversations — pricing every one of those requests at the real, current per-model prices (not a rough multiplier). As a sanity check, a "no trimming at all" version of the same replay landed within 1% of what those requests actually billed, which is what says the cost model behind these numbers is trustworthy in the first place.

- **No trimming:** $12,385.49.
- **The previous version** (drop anything more than 5 calls old, no payback check): saved $1,226.72 — **9.9%**. 107,842 cuts, 1,802 of them re-read later at a cost of $158.39.
- **This version** (the payback rule below): saved $1,588.88 — **12.8%**. 36,134 cuts, 692 of them free (the chat had already gone quiet long enough for the cache to expire on its own, so the cut rode along for nothing — see below), and 431 re-reads costing back $27.48.

Two honest caveats on that 12.8%:

- It's the same replay this version was tuned on. How far ahead Trim bets on a conversation still running (see below) was picked by trying a few settings against this exact data and taking the best one. The runners-up — a bit more aggressive, a bit less, and one much more aggressive setting — were close behind, so it wasn't a knife-edge choice, but it hasn't been checked against history Trim hadn't already seen.
- Every re-read above is charged whenever a later call touches a cut item again — even on the (common) occasions where the agent would have re-read it anyway, cut or not. Leaving that charge out entirely (crediting Trim for those instead) puts the previous version at 11.2% and this one at 13.1%. The truth is somewhere between the number quoted and that one.

(An older version of this doc quoted 25%. That came from a smaller, earlier replay that priced everything with fixed read/write multipliers instead of each model's real prices, run over one project's history rather than everything on the machine — this is the number that replaces it.)

## How it decides what to cut

A tool output becomes a candidate once it's more than 5 calls old, and Trim looks at that thread's candidates every 20 calls — same as before. What's new is the question it asks about each one: not just "is this still needed", but "does dropping it actually pay for itself".

**Why a cut can lose money.** Cutting something removes it from every later request in that chat — but the request that makes the cut has to rewrite the model's cache from that point on, which is pricier than reading it. Cut something near the very end of a long prompt, or near the start when the chat is about to wrap up, and that one rewrite can cost more than the cut ever saves.

**Guessing how much longer a chat has left.** To weigh that trade-off, Trim needs a rough sense of how many more requests are still coming. It gets that from this same person's own past work: looking at about 1,400 real past Claude Code conversations (93,641 requests in total), once a conversation has reached 20 calls, half the time it runs at least ~105 calls further, and 85% of the time it runs at least 20 further. Trim then leans into that a bit harder — betting on twice that number, not the number itself — because the small number of very long chats carry most of the actual money at stake, and underestimating them costs more than overestimating a short one does.

**The payback rule itself.** Every 20 calls, for each old candidate, Trim weighs what keeping it costs from here (a small amount, paid again on every future request, for as long as the chat above is expected to keep going) against what a wrong cut would cost (rewriting it back in, plus the one extra request that forces). It only cuts the ones where the first number wins — and among those, it picks the single cut point that pays back the most, since one cut point pays for the whole rewrite regardless of how many things are removed at once.

**Free cuts.** Sometimes a candidate would pay off eventually, just not on the very next request — the rewrite it would force right now costs more than it's worth yet. Trim doesn't force it. Instead it hands the item to Wibble to hold, and the moment this chat goes quiet long enough that the model's cache expires on its own (so the whole prompt gets rewritten anyway, cut or not), the cut applies for free. If the judge decides in the meantime that the held item really is still needed, Trim lets go of it before it's ever cut.

**The judge.** A small model running on your own machine (see below) is asked how likely it is the agent still needs each candidate for what the operator just asked. Honestly, it isn't great: on 150 real tool outputs, each hand-labeled as actually needed or not, it told needed apart from not-needed correctly about 76% of the time (50% would be a coin flip, 100% would be never wrong). Trim doesn't take its raw answer at face value — it's been checked against those same 150 labeled examples first, and turned into real odds by the payback math above rather than read off directly. Skip setting it up, or let it go down, and Trim falls back to that same measured base rate for every item, still run through the payback math above. Unlike the previous version, where the judge could only ever save a candidate from being cut, here it can move Trim's decision either way: an unjudged item is priced at that base rate, and a confident "not needed" verdict can make an item worth cutting that the base rate alone wouldn't have. (The figures under "What it actually saves" above are all run with the judge off, to measure what the payback rule alone is worth on its own — turning the judge on is a separate question this doc doesn't measure.)

## Live prices

The payback math above needs real dollar prices, not guesses, so Trim checks openrouter.ai for whatever model you're actually talking to. All it ever sends is a plain `GET` for that one model's name — no body, no headers, no key — and at most once a day per model. A handful of common models (the current Claude and GPT families) are also built in, so pricing works even before the first check succeeds or if it ever fails; a failed check just means Trim keeps using whatever it had.

## The pill

The chip in the top slot is Trim's own status: this week's percent saved and a dollar figure, like `−24% · $41 saved`. It's on by default and has no settings of its own — you turn Trim on or off from Wibble's own Settings, the same as any other extension.

Hover the pill, or reach it with the keyboard, and a small card opens showing the working behind that number:

```
This week
−24% · $41 saved
Removed      3.1M tokens of tool output
Cuts         42 made · 31 free · 9 waiting
Re-reads     6 · $1.20 netted out

This chat
Net          −31% · $3.10 saved
Calls        58

Opus 5.5 · $4/M input · cache read $0.20 · write $5
Updated today from openrouter.ai
Judge on
```

"Waiting" is a candidate that hasn't paid back yet (see "free cuts" above); it isn't lost, it's just parked. If you're signed in with a subscription rather than an API key, the dollar figures read "≈ $41 at API prices" instead of "saved" — Trim still shows you what it would have cost, but a plan doesn't actually charge you per request.

## What it can't do

Trim can only remove old tool output from what your agents send. It can't add anything, change anything, or see anything beyond that. The only addresses it's allowed to reach at all are `127.0.0.1:8791` (the judge on your own machine) and `openrouter.ai` (to check a model's current price, as above) — it can't reach anywhere else on the internet, and it can't open your files directly either way.

## Turning on the judge

Trim works with just the age and payback rules if you skip this. To get the smarter behavior:

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

It listens on `127.0.0.1:8791` only, and holds the model loaded in memory so each question is fast. If it goes down, Trim notices within a minute, falls back to the age and payback rules alone, and picks the judge back up on its own once it answers again — nothing to restart by hand.

## Engines

Whether Trim sees a session at all depends on the engine and how it's signed in (measured 27 Sep 2026):

| Engine | Trimmed? |
|---|---|
| Claude Code | Yes (measured on a claude.ai login; an API key goes through the same setting) |
| Codex, signed in with a ChatGPT login | Yes |
| Codex, with an API key, or a `config.toml` (yours or the project's) pointing at its own provider | Not yet — runs direct, untrimmed |
| OpenCode, an OpenAI-compatible provider | Yes |
| OpenCode, other provider types | Not yet |

"Not yet" just means the session runs exactly as it would without Trim — nothing breaks, it simply isn't trimmed.
