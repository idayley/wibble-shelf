# Trim v2 — Payback-Aware Cuts, Hover Card, Live Prices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Trim releases a cut only when it pays back in dollars at live prices, hands cost-only failures to Wibble as cold drops, counts savings in real dollars, and shows the working in a hover card on its pill.

**Architecture:** All logic stays in `items/trim/main.js` as pure named exports (Wibble loads one file; no imports), tested with `node --test`. `activate()` wires prices (fetched per model from OpenRouter), a per-thread planner, cold drops and per-chat stats. `calibrate.py` gains `--curve` (judge score → probability) and `--lengths` (how long threads run). A new `replay.mjs` replays real Claude Code transcripts through v1 and v2 rules as the ship gate.

**Tech Stack:** Plain ES modules (Node ≥ 20 for tests), Python 3 stdlib.

**Spec:** `docs/specs/2026-09-27-trim-payback-design.md` (builds on `docs/specs/2026-09-26-trim-design.md`); Wibble side: `wibble/.claude/worktrees/engine-route/docs/superpowers/specs/2026-09-27-trim-hover-and-cold-drops-design.md`.

## Global Constraints

- Work on `main` in `~/Documents/GitHub/wibble-shelf`. Do not push.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no `Claude-Session:` trailer.
- One file: everything the extension runs lives in `items/trim/main.js`; pure functions are named exports with no side effects; only `activate()` does work.
- Never on the request path; the batch rule (every `BATCH = 20` calls, `AGE = 5`) and sticky drops stay.
- Must keep working on an older Wibble: no `at` on items, no `billing`, no `when`/`withdraw`, no `cold` on results, no chip `detail` (spec §5).
- Hosts: `127.0.0.1:8791` and `openrouter.ai` only. Nothing but the model slug is sent to OpenRouter.
- Prices are dollars per token: `{ input, cacheRead, write5m, write1h, output, context }`. A missing cache write means the input price.
- Tests: `node --test items/trim/` and `node .github/check/shelf-check.mjs` (as `.github/workflows/check.yml` runs it). Reference material (calibration scores, the old replay scripts, the lengths script) is in `.superpowers/sdd/2026-09-27-trim-payback/ref/`.

## Worker API added by Wibble (may be absent)

```ts
seen.items[i].at?: number          // chars from the start of the messages to this result's entry
seen.billing?: "plan" | "api"
wibble.trim.drop(sessionId, ids, opts?: { when: "cold" }): Promise<void>
wibble.trim.withdraw?(sessionId, ids): Promise<void>
result.cold?: boolean; result.coldApplied?: string[]
chip node: { kind: "chip", label, tone?, key?, detail?: Node }   // Node: text{content} heading{content} row{label,value} stack{children} list{children} chip meter bar
```

---

### Task 1: Prices

**Files:** Modify `items/trim/main.js` (replace `PRICE_PER_M`/`dollars`), `items/trim/main.test.mjs`.

**Produces:** `BUILTIN_PRICES`, `slugOf(model)`, `parseEndpoints(body, slug)`, `priceFor(model, fetched)`, `MAKERS`.

- [ ] **Step 1: Failing tests.**
  - `slugOf`: `claude-opus-5-5` → `anthropic/claude-opus-5.5`; `claude-opus-5-5[1m]` → same; `claude-haiku-4-5-20251001` → `anthropic/claude-haiku-4.5`; `gpt-5.5` → `openai/gpt-5.5`; `gpt-5-codex` → `openai/gpt-5-codex`; `openrouter/deepseek/deepseek-v4-pro` → `deepseek/deepseek-v4-pro`; `deepseek/deepseek-v4-pro` unchanged; `mystery` → `null`; `null` → `null`.
  - `parseEndpoints`: given a body shaped like the real one (two `Anthropic` endpoints at prompt `0.000004` and `0.000008`, one `Google` at `0.0000044`) picks the `Anthropic` one at `0.000004` → `{input:4e-6, cacheRead:2e-7, write5m:5e-6, write1h:8e-6, output:2e-5, context:1000000}`; no maker match → cheapest of all; missing `input_cache_write*` → equal to input; malformed JSON, missing `data.endpoints`, a non-numeric price → `null`.
  - `priceFor`: fetched entry wins over built-in; built-in used when not fetched (`source: "built-in"`); unknown → `null`.
- [ ] **Step 2: Implement.**

```js
// Dollars per token, from OpenRouter's endpoint lists on 2026-09-27.
export const BUILTIN_PRICES = {
  "anthropic/claude-opus-5.5": { input: 4e-6, cacheRead: 2e-7, write5m: 5e-6, write1h: 8e-6, output: 2e-5, context: 1000000 },
  "anthropic/claude-opus-5": { input: 5e-6, cacheRead: 5e-7, write5m: 6.25e-6, write1h: 1e-5, output: 2.5e-5, context: 1000000 },
  "anthropic/claude-sonnet-5": { input: 2e-6, cacheRead: 2e-7, write5m: 2.5e-6, write1h: 4e-6, output: 1e-5, context: 1000000 },
  "anthropic/claude-haiku-4.5": { input: 1e-6, cacheRead: 1e-7, write5m: 1.25e-6, write1h: 2e-6, output: 5e-6, context: 200000 },
  "openai/gpt-5.5": { input: 5e-6, cacheRead: 5e-7, write5m: 5e-6, write1h: 5e-6, output: 3e-5, context: 1050000 },
  "openai/gpt-5-codex": { input: 1.25e-6, cacheRead: 1.25e-7, write5m: 1.25e-6, write1h: 1.25e-6, output: 1e-5, context: 400000 },
};

/** OpenRouter author -> the provider_name of the model's own maker. */
export const MAKERS = { anthropic: "Anthropic", openai: "OpenAI", deepseek: "DeepSeek" };

export function slugOf(model) {
  if (!model) return null;
  let m = String(model).toLowerCase().replace(/\[.*\]$/, "").replace(/-\d{8}$/, "").replace(/^openrouter\//, "");
  if (m.includes("/")) return m;
  if (m.startsWith("claude-")) m = "anthropic/" + m;
  else if (/^(gpt-|o\d)/.test(m)) m = "openai/" + m;
  else return null;
  return m.replace(/(\d)-(?=\d)/g, "$1.");
}
```

  `parseEndpoints(body, slug)`: `JSON.parse` in try; endpoints = `data.endpoints`; filter by `provider_name === MAKERS[slug.split("/")[0]]`, fall back to all; each price via `Number(...)`, rejected if not finite and ≥ 0 (`prompt`, `input_cache_read`, `completion` required; writes default to `prompt`; `input_cache_read` missing → `prompt`); choose lowest `input`; `context` = that endpoint's `context_length` or `null`.

  `priceFor(model, fetched)` → `{ slug, prices, source: "fetched" | "built-in" } | null`, where `fetched` is `{ [slug]: { prices, at } }`.
  Verify `gpt-5-codex`'s built-in numbers and context against `https://openrouter.ai/api/v1/models/openai/gpt-5-codex/endpoints` (curl, once) and correct the table if they differ.
- [ ] **Step 3:** `node --test items/trim/`. Commit `feat(trim): prices per token, from OpenRouter or a built-in table`.

### Task 2: How long a thread runs, and the calibrated judge

**Files:** Modify `items/trim/calibrate.py`, `items/trim/main.js`, `items/trim/main.test.mjs`.

**Produces:** `LEFT_TABLE`, `left(calls, promptTokens, context)`, `CALIBRATION = { bins: [[rawUpper, prob], ...], baseRate }`, `probNotNeeded(verdict)`.

- [ ] **Step 1: `calibrate.py --lengths`.** Port `ref/lengths.py`: main-thread (not sidechain) assistant requests per transcript in `~/.claude/projects/*/*.jsonl`, deduped by message id; for `n` in `20 40 60 100 200 400`, the median of `len - n` over threads with `len ≥ n`; print a JS array literal `[[20, 105], ...]`. Run it; paste its output as `LEFT_TABLE` (today's run gave `[[20,105],[40,132],[60,127],[100,164],[200,154],[400,231]]`; use whatever it prints now).
- [ ] **Step 2: `calibrate.py --curve --from <scored.jsonl>`.** From rows with `label` (true = needed) and `notNeeded` (the judge's raw score): sort by score, 10 equal-count bins, each bin's probability = share of `label == false`, then make it non-decreasing (pool adjacent violators). Print `bins` as `[[upperScore, prob], ...]` (last upper = 1) and `baseRate` = overall share not needed. Run it on `.superpowers/sdd/2026-09-27-trim-payback/ref/t5-calib-neutral.jsonl` (the scores for today's question and prompt) and paste as `CALIBRATION`. Docstring gains both modes.
- [ ] **Step 3: Failing tests.** `left(20)` = 105, `left(30)` = 118.5 (linear between 105 and 132), `left(5)` = 105, `left(1000)` = 231; `left(100, 870000, 1000000)` = 10 (≥ 85% full); `left(100, 800000, 1000000)` = 164; `left(100, 870000, null)` = 164. `probNotNeeded(null)` = `baseRate`; a raw score in bin k returns bin k's prob; results are within [0,1] and non-decreasing in score.
- [ ] **Step 4: Implement.**

```js
export function left(calls, promptTokens = 0, context = null) {
  const t = LEFT_TABLE;
  let v;
  if (calls <= t[0][0]) v = t[0][1];
  else if (calls >= t[t.length - 1][0]) v = t[t.length - 1][1];
  else {
    const i = t.findIndex(([c]) => c > calls);
    const [c0, v0] = t[i - 1], [c1, v1] = t[i];
    v = v0 + ((v1 - v0) * (calls - c0)) / (c1 - c0);
  }
  return context && promptTokens >= 0.85 * context ? Math.min(v, 10) : v;
}

export function probNotNeeded(verdict) {
  if (verdict == null) return CALIBRATION.baseRate;
  const bin = CALIBRATION.bins.find(([upper]) => verdict.notNeeded <= upper) || CALIBRATION.bins[CALIBRATION.bins.length - 1];
  return bin[1];
}
```

- [ ] **Step 5:** tests pass; commit `feat(trim): how long threads run, and the judge's scores as real odds`.

### Task 3: The planner

**Files:** Modify `items/trim/main.js` (replace `cutLine` and `release`), `items/trim/main.test.mjs` (replace the `cutLine`/`release` tests; keep every batch/age/sticky behavior test, re-pointed at `plan`).

**Consumes:** `left`, `probNotNeeded`, prices from Task 1.
**Produces:**

```js
/**
 * @param thread  track()'s thread, plus from onResult: r (tokens/char), promptTokens, write1h (bool)
 * @param seen    the onSeen report that triggered this (totalChars, items with optional `at`)
 * @param prices  { input, cacheRead, write5m, write1h, output, context } or null
 * @returns {{ now: string[], cold: string[], withdraw: string[], net: number }}
 */
export function plan(thread, seen, prices)
```

Rules:
- Not due (`calls - lastRelease < BATCH`) → all empty, nothing mutated.
- `prices == null` → v1 behavior with v1's lines (keep a private `v1Line(calls)` = 0.87 up to 25 calls, else 0.82): `now` = what v1 `release` returned; `cold` empty.
- Else: `r = thread.r ?? 0.3`, `P = thread.promptTokens ?? seen.totalChars * r`, `L = left(calls, P, prices.context)`, `write = thread.write1h ? prices.write1h : prices.write5m`.
  - Per aged, undropped item: `p = probNotNeeded(verdict)`; `keep = chars*r*prices.cacheRead*L`; `reread = chars*r*write + P*prices.cacheRead`; it is a **candidate** when `p*keep >= (1-p)*reread`. An item whose verdict makes it not a candidate and that is in `thread.coldPending` goes to `withdraw`.
  - Candidates sorted by `at` (missing `at` → treat all as sitting at the smallest known `at`, else `0`).
  - For each index i: `save = Σ_{j≥i} p_j*keep_j`, `risk = Σ_{j≥i} (1-p_j)*reread_j`, `cost = max(0, totalChars - at_i)*r*(write - prices.cacheRead)`, `net_i = save - risk - cost`. Pick the max `net_i`; if > 0, `now` = candidates[i..].
  - `cold` = the candidates not in `now` that are not already in `thread.coldPending`.
  - Mutations only when due: `lastRelease = calls`; `now` ids join `dropped` / `droppedTargets` (as v1); `cold` ids join `thread.coldPending` (a Set, created by `track`); `withdraw` ids leave it; `thread.stats.skipped += cold.length` (stats object created by `track`: `{ cuts:0, freeCuts:0, skipped:0 }`).
  - `net` = the chosen `net_i` (or 0) in dollars, for the hover and tests.

- [ ] **Step 1: Failing tests, hand-worked in comments.** Use prices `{input:4e-6, cacheRead:2e-7, write5m:5e-6, write1h:8e-6, output:2e-5, context:1e6}`, `r=0.25`, `calls=20` (L=105), `P=50000`, `totalChars=200000`, all verdicts `{notNeeded: 0.99}` mapped through a test-local CALIBRATION override (export a `withCalibration(cal, fn)` helper or pass calibration as an optional 4th arg — choose the 4th arg `cal = CALIBRATION`):
  - one 40,000-char item at `at=10000`: keep = 40000·0.25·2e-7·105 = $0.21; cost = 190000·0.25·(5e-6−2e-7) = $0.228; with p≈1 net < 0 → `now=[]`, `cold=[id]`.
  - same item at `at=160000`: cost = 40000·0.25·4.8e-6 = $0.048 → net > 0 → `now=[id]`.
  - two items, a 2,000-char one at 10,000 and a 40,000-char one at 150,000: best k is the second → `now=[second]`, `cold=[first]`.
  - a candidate in `coldPending` whose new verdict makes it a keeper → in `withdraw`, removed from `coldPending`.
  - `prices=null` → identical to v1 on the old release tests.
  - not due → nothing changes.
  - items without `at` → behaves as if all at the earliest position.
- [ ] **Step 2: Implement; tests pass. Commit** `feat(trim): cut only where it pays back, and park the rest for a cold cache`.

### Task 4: Dollars, cold results and per-chat stats

**Files:** Modify `items/trim/main.js` (`saving`, `cost`, `percent`, day totals, `onSeen`/`onResult`, price fetching), tests in `main.test.mjs` and `main.activate.test.mjs`; `items/trim/wibble.json` (`hosts` adds `openrouter.ai`).

**Produces:** `savingUsd(result, rereadChars, prices) -> { saved, actual, removedTokens, cutCost, rereadCost }` (dollars); keep v1 `saving()` for when prices are unknown. Day totals gain `usd: { saved, actual }`, `planShare` counters (`planActual`, `apiActual`), `cuts`, `freeCuts`, `skipped`, `rereads`, `rereadCost`. Old stored days load with those as 0.

- [ ] **Step 1: Failing tests for `savingUsd`.** Warm request with prices above: `usage={input:10,cacheRead:90000,cacheWrite5m:1000,cacheWrite1h:0,output:500}`, `sentChars=364040`, `totalChars=364040`, `removedChars=40000`, `firstCutChars=null` → r = 91010/364040 = 0.25, gross = 40000·0.25·2e-7 = $0.002; with `firstCutChars=300000` cut = 64040·0.25·4.8e-6 = $0.0768; the same with `cold:true` → cutCost 0 and gross at the write price (cacheRead is 0 on a cold request); re-read charge = P·cacheRead + chars·r·write.
- [ ] **Step 2: Implement `savingUsd`.**
- [ ] **Step 3: Wiring (activate), failing activate tests first** (the existing fake-wibble harness in `main.activate.test.mjs`):
  - price fetch: on the first `onSeen` for a model with no fresh price (none or older than 24 h), one `net.fetch` GET to `https://openrouter.ai/api/v1/models/<slug>/endpoints`, at most one in flight; success stores `{prices, at}` in storage key `prices`; failure changes nothing and is not retried for 1 h; storage copy loaded on start.
  - `onResult` stores on the thread `r`, `promptTokens`, `write1h = cacheWrite1h > cacheWrite5m`; charges with `savingUsd` when prices are known (else v1 `saving` + `dollars` = null); `result.cold` true → counts `freeCuts += result.coldApplied.length`; `newlyRemoved` non-cold → `cuts += newlyRemoved`; re-reads counted.
  - `onSeen` calls `plan`; `now` → `drop(sid, now)`; `cold` → `drop(sid, cold, {when:"cold"})` only if `wibble.trim.withdraw` exists (proxy for a Wibble that knows cold drops), else leave them for the next batch; `withdraw` → `wibble.trim.withdraw(sid, ids)`; on a rejected cold drop remove the ids from `coldPending`.
  - per-chat stats: `chats[sessionId] = { saved, actual, calls, model, billing, lastAt }` (dollars when known), in memory, at most 50 (drop the oldest `lastAt`); `calls` = max `seen.calls` for that session.
  - percent and the chip's dollar figure use `usd` when every day in the week has it, else v1 units.
- [ ] **Step 4:** `wibble.json` `hosts: ["127.0.0.1:8791", "openrouter.ai"]`; shelf check passes. Commit `feat(trim): count savings in dollars at live prices, and free cuts on a cold cache`.

### Task 5: The hover card

**Files:** Modify `items/trim/main.js` (`buildPanelNode` and a new pure `detailNode(view)`), tests.

**Produces:** `detailNode(view)` where `view = { week, chat, prices, priceSource, priceAt, judgeUp, plan }` → a `stack` node.

- [ ] **Step 1: Failing tests.** Given a fixed view, `detailNode` returns exactly (rows are `{kind:"row", label, value}`, heading is `{kind:"heading", content}`):
  - heading `This week  −24% · $41 saved`
  - row `This chat` / `−31% · $3.10 saved · 58 calls`
  - row `Removed` / `3.1M tokens of old tool output`
  - row `Cuts` / `42 made · 31 free (after a pause) · 9 skipped (wouldn't pay back yet)`
  - row `Re-reads` / `6, cost $1.20 (already subtracted)`
  - row `Prices` / `Opus 5.5: $4/M input · cache read $0.20 · cache write $5` and a `text` `updated today from openrouter.ai` (or `built-in prices` / `updated 3 days ago`)
  - row `Judge` / `on` or `off — using the age rule`
  And: plan billing → dollar values read `≈ $3.10 at API prices`; the chip label uses `≈ $41 at API prices` when plan requests make up more than half the week's actual cost; no chat yet → the `This chat` row is omitted; unknown prices → `Prices` row reads `unknown for <model>, counting tokens`.
  Model display name: `anthropic/claude-opus-5.5` → `Opus 5.5`, `openai/gpt-5.5` → `GPT-5.5`, else the slug after `/`.
- [ ] **Step 2: Implement;** `buildPanelNode` adds `detail: detailNode(...)` to the chip. An older Wibble's validator copies only `label`/`tone`/`key` onto a chip and drops anything else, so `detail` is always sent; add a test that the chip is otherwise unchanged.
- [ ] **Step 3:** Commit `feat(trim): the pill's hover card shows the working`.

### Task 6: Replay gate

**Files:** Create `items/trim/replay.mjs` (Node, imports `main.js`'s exports), `items/trim/replay.test.mjs`.

- [ ] **Step 1:** Build per-thread request sequences from `~/.claude/projects/*/*.jsonl` (main thread only; reset at `compact_boundary`): for each assistant request, its timestamp, the tool results present (id, chars, `at` = running char offset in the message list, target = the file path or command the matching `tool_use` named), and the model. Reference: `.superpowers/sdd/2026-09-27-trim-payback/ref/prune_refetch.py` (how v1's replay built items and detected re-reads: a later tool call naming a dropped item's target counts as a re-read).
- [ ] **Step 2:** Simulate each request's cost at `BUILTIN_PRICES` for its model (unknown → Opus 5.5), cache TTL 5 min (1 h when the transcript's usage shows 1-hour writes): prefix up to the first change since the last request is a read, the rest a write; a gap over the TTL makes the whole prompt a write. Three runs: no trimming; v1 (`v1Line`, age rule, no judge verdicts — all unjudged); v2 (`plan` with no verdicts, cold drops applied on the first request after a TTL gap). Re-reads charged as in `savingUsd`.
- [ ] **Step 3:** `replay.test.mjs`: one synthetic three-thread fixture with hand-computed totals (a short thread where v2 skips and v1 loses, a long one where both save, one with a 10-minute pause where v2 cuts free).
- [ ] **Step 4:** Run on real history; print totals (no trimming, v1, v2, saved % each). Record the output in the ledger and in README. **Gate:** v2 saved % ≥ v1 saved %. If not, stop and report the numbers — do not tune constants to pass.
- [ ] **Step 5:** Commit `feat(trim): a replay that compares v1 and v2 on real history`.

### Task 7: README, author docs, marketplace

**Files:** `items/trim/README.md`, `make-an-extension.md`, `wibble-marketplace.json`, `items/trim/wibble.json` (version `1.1.0`), `.github/check` bundle if the check requires rebuilding.

- [ ] **Step 1:** README: "How it decides what to cut" rewritten for the payback rule and free cuts (plain words, the 1,408-thread measurement explained); the replay numbers from Task 6; the hover card; live prices (what is sent to openrouter.ai: only a model name); remove the 0.87/0.82 text.
- [ ] **Step 2:** `make-an-extension.md`: chip `detail` (what's allowed inside), `trim.drop` options `{when:"cold"}`, `trim.withdraw`, seen `at` and `billing`, result `cold`/`coldApplied`.
- [ ] **Step 3:** Marketplace entry: bump to the commit that finishes Task 6, history line "1.1.0 — cuts only when they pay back; hover shows the working; live prices".
- [ ] **Step 4:** `node --test items/trim/`, the shelf check over the repo. Commit `docs(trim): v1.1 — payback rule, hover card, live prices`, then a second commit bumping the marketplace ref to that commit if the ref must point at it.
