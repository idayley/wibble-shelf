# Trim — an extension that quietly saves you money

**Date:** 2026-09-26
**Status:** Draft for review
**Needs from Wibble:** `context.trim` and `net.fetch`, specified in
`wibble/docs/superpowers/specs/2026-09-26-context-trim-capability-design.md`.
Trim cannot be installed on a Wibble without them.

**One sentence:** *Old tool output leaves the conversation before it costs
you again, and you only notice the number going up.*

---

## 1. What it does

Every request an agent makes re-sends everything so far, including tool
output it read twenty steps ago and will never look at again. Trim tells
Wibble which of those old results to leave out. It works in the main chat
and inside subagents, in the middle of a turn, on every engine Wibble can
route (Claude Code first).

A replay of the wibble project's own sessions put this at about 25% off
input cost overall (about $950 of $3,870), with re-reads of dropped files
charged back. That is the bar the live numbers are checked against.

## 2. The rule it follows

Three parts, each there for a measured reason:

1. **Never make a request wait.** Wibble asks Trim before each request and
   waits at most 20 ms. Trim answers from decisions it already made; it
   never calls a model while a request is waiting. (yoshi, a similar proxy
   that judged on the request path, made tasks 4–5x slower.)
2. **Cut in batches.** A cut makes the prompt cache rewrite everything
   after it, so Trim releases new cuts for an agent only every **20 calls**,
   and only for tool results more than **5 calls old**. That pair was the
   best in the replay.
3. **Once cut, stay cut.** Wibble enforces this too (sticky drops), so the
   cached part of the conversation stays identical request to request.

## 3. Deciding what's stale

In the background, as each tool result ages past 5 calls, Trim asks a judge
whether the agent will still need it.

- **Local OpenJev (default).** A Jev-compatible `/v1/systemone` service on
  `127.0.0.1:8791`, running the 4-bit Qwen3.5-4B OpenJev model on the Mac
  (about 5.4 GB peak memory, 0.2–2 s per decision, all off the request
  path). On past tasks it ranked which files mattered with AUC 0.77 against
  0.59 for keyword matching (0.5 is a coin flip; 690 files over 76 tasks).
  The service is a small script in this folder, `openjev-serve.py`, that
  the operator starts once; Wibble never runs it.
- **Each question is small.** The judge sees the operator's latest request,
  the last few assistant messages, and the one tool result's name, target
  and first lines — never the whole history. Jev's own docs say it does
  worse on large states full of irrelevant detail.
- **Keep when unsure.** A result is cut only when the judge says "not
  needed" with p ≥ 0.7 (to be tuned on the replay set before shipping).
- **Fallback: the age rule.** If the judge isn't running, answers slowly,
  or has not reached an item yet, anything more than 5 calls old is cut at
  the next batch. That is the rule the 25% figure was measured with, so
  the fallback is still a saving; the judge's job is fewer re-reads.
- **The hosted Jev API** becomes a third option once Wibble has `secrets`
  to hold its key. The code path is the same request to a different host.

## 4. The pill and the number

**Pill: off by default,** switchable in Trim's panel. When on, it shows the
percentage saved, e.g. `−24%`. Hover shows dollars and tokens cut, today
and this week.

**How the saving is worked out,** per request, from what Wibble reports
(`trim.applied`) and the usage event (which carries cache tokens on every
engine):

- *Would have cost:* the removed tokens, priced as they would have been
  billed on that request (cache read if they sat before the cache break,
  write otherwise).
- *Minus the cut's cost:* at a batch, everything after `firstCut` is
  rewritten to the cache at the write price instead of read — charged in
  full.
- *Minus re-reads:* when a later tool call touches a file whose output was
  cut, that call's result is charged against the saving.
- *Percentage* = saving ÷ (actual cost + saving). True on any plan.
- *Dollars* use each model's API price. On a subscription the hover says
  "what these tokens cost on the API" — the operator isn't billed per
  token, and the percentage is roughly how much further their limit goes.

## 5. Settings (Trim's panel)

- On / off.
- Judge: local OpenJev (with a live "running / not found" line) or age rule
  only; hosted Jev appears once available.
- Show the pill.
- One line: *Saved $41 this week (−24%).*

Nothing else. Thresholds are not settings.

## 6. Files

```
items/trim/
  wibble.json        capabilities: stream.read, storage, panel.render,
                     context.trim, net.fetch; hosts: ["127.0.0.1:8791"]
  main.js            the rule, the judge queue, the saving
  openjev-serve.py   the local judge, run by the operator
  README.md          what it does, how to start the judge, what it can't do
```

## 7. Testing

- The rule, offline: feed recorded sessions through `main.js`'s decision
  code and check the replay's cost within a few percent of the scratch
  simulation (56% main thread at 5/20).
- Deadline: `onDecide` answers in under 2 ms with 500 items pending.
- The saving: a hand-worked three-batch session gives the same number the
  pill shows.
- Live: one real session in a dev build with the pill on; compare its
  `cache_read`/`cache_creation` totals against the same kind of session
  with Trim off.

## 8. Not in v1

- Trimming anything other than tool output (long assistant text, images
  already seen).
- A Claude Code plugin for people without Wibble.
- Per-project thresholds.
