# Trim — cut only when it pays, show the math, live prices

**Date:** 2026-09-27
**Status:** Draft for review
**Builds on:** `docs/specs/2026-09-26-trim-design.md` (Trim v1).
**Needs from Wibble:** chip `detail`, item offsets and cold drops, specified in
`wibble/docs/superpowers/specs/2026-09-27-trim-hover-and-cold-drops-design.md`.
Trim keeps working on a Wibble without them (see §5).

**One sentence:** *Every cut is a small bet; Trim now only places the ones
that win, and the pill shows you the working.*

---

## 1. Why

A cut is not free. After it, everything later in the prompt has to be
written to the cache again (1.25x the input price on Claude) instead of read
from it (0.05x–0.1x). Removing the output then saves the read price on every
later request. A cut placed near the end of a chat, or one that removes a
little near the start of a long prompt, loses money. The live check lost 7%
on a short session for exactly this reason.

Measured on this Mac's own Claude Code history (1,408 threads, 93,641
requests): once a thread reaches 20 calls, half run at least ~105 more, and
85% run at least 20 more. So most cuts do pay back — but not all, and the
bad ones are avoidable.

## 2. The decision

### 2.1 Prices

Per model, per million tokens: input, cache read, 5-minute cache write,
1-hour cache write, output. Every cost below is in dollars from these, not
in fixed multipliers (Opus 5.5's cache read is 5% of input, not the 10% v1
assumed).

- Source: OpenRouter's per-model endpoint list,
  `https://openrouter.ai/api/v1/models/<author>/<slug>/endpoints` (public,
  no key, ~12 KB). The full `/api/v1/models` list is ~800 KB, too close to
  `wibble.net.fetch`'s 1 MB cap, and Trim only needs the models it has seen.
  From `data.endpoints`, take those whose `provider_name` is the model's own
  maker (`Anthropic`, `OpenAI`, `DeepSeek`, …), else all of them, and use
  the one with the lowest `pricing.prompt`. Map `prompt`,
  `input_cache_read`, `input_cache_write`, `input_cache_write_1h`,
  `completion` (strings, dollars per token) and `context_length`.
- Model id → slug: lowercase; strip a `[…]` suffix (`[1m]`) and a trailing
  date (`-20251001`); strip a router prefix (`openrouter/`); `claude-*` and
  `gpt-*`/`o*` get `anthropic/` and `openai/`; a version's digits joined by
  `-` become `.` (`claude-opus-5-5` → `anthropic/claude-opus-5.5`). An id
  that already has `author/slug` is used as it is. A 404 or unexpected
  shape → the built-in table, then v1's family fallback, then tokens only.
- Missing cache write on a model (OpenAI, most OpenAI-compatible): writing
  costs the plain input price.
- Fetched once per model per day, at most one fetch in flight, the last good
  answers kept in storage; a failed fetch changes nothing.
- Built-in table (as of 2026-09-27, from OpenRouter) covers Opus 5.5, Opus 5,
  Sonnet 5, Haiku 4.5, GPT-5.5, GPT-5-codex.
- Manifest: `hosts` gains `openrouter.ai`.

### 2.2 How long the thread will keep going

`left(calls)` = the median number of further requests for a thread that has
reached `calls`, from a built-in table measured on real history (§1):

| calls reached | 20 | 40 | 60 | 100 | 200 | 400 |
|---|---|---|---|---|---|---|
| median still to come | 105 | 132 | 127 | 164 | 154 | 231 |

Interpolated between points, flat past the ends. Median, not mean: the mean
is carried by a few 1,000-call threads and would over-cut short ones.
`calibrate.py --lengths` regenerates the table from `~/.claude/projects`.

Capped by compaction: when the prompt is within 15% of the model's context
window, `left` is capped at 10, since the engine is about to compact and
throw the saving away anyway. (Context window from the price list's
`context_length`.)

### 2.3 Which cut point

Wibble now sends each item's offset (`at`, chars from the start of the
request). A batch's candidates are the items v1 would cut (age > 5, judge
says not needed or hasn't answered). Any subset shares one cost: the
rewrite from the **earliest** item cut to the end. So Trim tries each
candidate as the earliest cut point `k` and takes only candidates at or
after it:

```
tokens(x)  = x * r                         (r = tokens per char, as v1)
save(k)    = Σ chars of candidates at or after k
             × r × (cacheRead $) × left(calls)
cost(k)    = (totalChars − at_k) × r × (write $ − cacheRead $)
net(k)     = save(k) − cost(k) − risk(k)
```

It releases the `k` with the highest `net`, or nothing if none is above
zero. Candidates before `k` stay candidates for the next batch. `write $` is
the 1-hour write price when the thread's last result wrote the 1-hour cache,
else the 5-minute price.

### 2.4 The judge's line, from prices

`risk(k)` is the expected cost of cutting something still needed: for each
cut item, `(1 − notNeeded) × reread$`, where `reread$` = the item written
back (`chars × r × write $`) plus the extra request reading the whole prompt
(`promptTokens × cacheRead $`). An item with no verdict uses the base rate:
the share of labeled items that were truly not needed (see below).

The fixed `cutLine` 0.87 / 0.82 goes. An item is a candidate when cutting it
wins in expectation:

```
notNeeded' × keep$  ≥  (1 − notNeeded') × reread$
keep$ = chars × r × cacheRead $ × left(calls)
```

where `notNeeded'` is the judge's score mapped to a real probability. The
judge's raw scores are not probabilities (it separates needed from not
needed 76% of the time); `calibrate.py` already holds 337 labeled, scored
items and gains `--curve`, which fits the mapping (isotonic, 10 bins) and
writes it into `main.js` as a constant. The same file gives the base rate
for unjudged items.

### 2.5 Free cuts when the cache has gone cold

The provider forgets a cached prompt after 5 minutes of quiet (1 hour when
the engine asked for the long cache). The next request rewrites the whole
prompt anyway, so a cut on that request costs nothing (`cost(k) = 0`).

Trim cannot see a pause coming, and never makes a request wait. Instead,
every candidate that failed §2.3 only because of `cost(k)` is handed to
Wibble as a **cold drop**: Wibble holds it and applies it on the first
request after the cache has expired, then it is an ordinary sticky drop.
Trim withdraws a cold drop when the judge later marks it needed. (Only 2%
of requests follow a 5-minute pause, so this is a bonus, not the plan.)

### 2.6 Accounting

`saving()` uses the dollar prices from §2.1 instead of 0.1 / 1.25 / 2, and
a cut that Wibble reports as applied on a cold request is charged nothing
(`trim.result` gains `cold: boolean`). Totals keep dollars and tokens, and
also count cuts made, cuts made free, candidates skipped, re-reads and
their cost — per week and per chat.

## 3. The pill and its hover

The chip stays `−24% · $41 saved`. Its `detail`:

```
This week  −24% · $41 saved

This chat       −31% · $3.10 saved · 58 calls
Removed         3.1M tokens of old tool output
Cuts            42 made · 31 free (after a pause) · 9 skipped (wouldn't pay back yet)
Re-reads        6, cost $1.20 (already subtracted)
Prices          Opus 5.5: $4/M input · cache read $0.20 · cache write $5
                updated today from openrouter.ai
Judge           on  |  off — using the age rule
```

- "This chat" is the chat whose request Trim saw most recently.
- Prices show the model of that chat; "updated" says built-in when no fetch
  has succeeded.
- A session Wibble reports as `billing: "plan"` (Claude on a claude.ai
  login, Codex on a ChatGPT login) saves plan usage, not money: its dollar
  lines read `≈ $3.10 at API prices`, and so does the chip when most of the
  week was on a plan.
- Without `detail` support (older Wibble) the chip is unchanged and the
  hover is simply absent.

## 4. What stays the same

Batches every 20 calls, age > 5, sticky drops, the judge only ever keeps,
never-wait, local judge on `127.0.0.1:8791`, no settings.

## 5. On an older Wibble

No `at` → treat every candidate as sitting at the earliest candidate's
position (v1 behavior, but still skipping a batch whose `net` ≤ 0, with the
earliest aged item's position estimated from `firstCutChars` history, else
the whole prompt). No cold drops → skipped candidates just wait for the
next batch. No `cold` flag → cuts are charged as v1.

## 6. Testing

- Unit: price parsing and model matching (Opus 5.5 with `[1m]`, GPT-5.5,
  unknown model, missing cache-write field, malformed/oversized body);
  `left()` interpolation and the compaction cap; cut-point choice on
  hand-worked cases (best `k` in the middle; nothing released when every
  `net` ≤ 0; cold drops are exactly the cost-only failures); calibrated
  line; `saving()` in dollars with a cold cut charged zero.
- Replay: re-run the v1 replay with the new rule and live prices, report
  savings next to v1's 25%. Ship only if it is not lower.
- Live: one long Claude chat in a dev build — hover shows sane numbers,
  one pause over 5 minutes produces a free cut.
