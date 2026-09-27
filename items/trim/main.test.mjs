// trim/main.test.mjs — run with `node --test items/trim/main.test.mjs`.
//
// Hand-worked numbers live in comments right above the assertion that
// checks them, so the arithmetic can be checked without re-deriving it.
//
// These exercise only the pure functions at the top of main.js. Importing
// it here runs none of Task 2's wiring -- only activate() does that -- so
// this file needs no fake `wibble` object. See main.activate.test.mjs for
// the judge client, drop release, savings totals and panel pill, driven
// through activate() with a fake wibble.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  track,
  release,
  evictIdle,
  rereads,
  cost,
  saving,
  dollars,
  percent,
  PRICE_PER_M,
  AGE,
  BATCH,
  IDLE_MS,
  cutLine,
  slugOf,
  parseEndpoints,
  priceFor,
  BUILTIN_PRICES,
  MAKERS,
} from "./main.js";

function closeTo(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg}: got ${actual}, expected ${expected}`);
}

// --- track() -----------------------------------------------------------

test("track: keeps head once seen, and offers only aged/unverdicted/unasked/undropped items to the judge", () => {
  const state = {};
  const seenBase = { sessionId: "s1", thread: "t1", format: "anthropic", model: "claude-sonnet-5", totalChars: 0, lastUser: "", recentAssistant: "" };

  // age 0: too young, and this is where the head gets captured.
  track(state, { ...seenBase, calls: 1, items: [{ id: "a", tool: "read", target: "f.txt", chars: 100, age: 0, head: "first line" }] });

  // age AGE (5) exactly: still not older than AGE, so not offered yet. A
  // later report with no head must not blank out the one we already have.
  let out = track(state, { ...seenBase, calls: 6, items: [{ id: "a", tool: "read", target: "f.txt", chars: 100, age: AGE, head: null }] });
  assert.deepStrictEqual(out.toJudge, []);

  // age AGE + 1: now older than AGE, no verdict, not asked, not dropped.
  out = track(state, { ...seenBase, calls: 7, items: [{ id: "a", tool: "read", target: "f.txt", chars: 120, age: AGE + 1, head: null }] });
  assert.strictEqual(out.toJudge.length, 1);
  assert.strictEqual(out.toJudge[0].id, "a");
  assert.strictEqual(out.toJudge[0].head, "first line", "head captured at age 0 must survive a later report with head: null");
  assert.strictEqual(out.toJudge[0].chars, 120, "chars is the latest value, not the one from the first report");

  const key = "s1:t1";
  assert.strictEqual(state.threads[key].calls, 7);

  // Once asked, an item drops out of toJudge even though it still qualifies otherwise.
  state.threads[key].items.get("a").asked = true;
  out = track(state, { ...seenBase, calls: 8, items: [{ id: "a", tool: "read", target: "f.txt", chars: 120, age: AGE + 2, head: null }] });
  assert.deepStrictEqual(out.toJudge, []);
});

// --- release() -----------------------------------------------------------

function makeThread(itemEntries) {
  return { calls: 0, lastRelease: 0, items: new Map(itemEntries), dropped: new Set(), droppedTargets: new Map() };
}

test("release: no release before 20 calls", () => {
  const thread = makeThread([["a", { tool: "read", target: "f.txt", chars: 10, age: AGE + 1, verdict: null, asked: false }]]);
  thread.calls = BATCH - 1; // 19

  const ids = release(thread);
  assert.deepStrictEqual(ids, []);
  assert.strictEqual(thread.lastRelease, 0, "no release happened, so lastRelease is untouched");
  assert.strictEqual(thread.dropped.size, 0);
});

test("release: at 20 calls, drops age>5 items (fallback or notNeeded>=cutLine), keeps age<=5 and a needed verdict", () => {
  const thread = makeThread([
    ["tooYoung", { tool: "read", target: "young.txt", chars: 10, age: AGE, verdict: null, asked: false }], // age === AGE, not > AGE
    ["fallback", { tool: "read", target: "fallback.txt", chars: 20, age: AGE + 1, head: "x", verdict: null, asked: true }], // no verdict at all
    ["unneeded", { tool: "read", target: "unneeded.txt", chars: 30, age: AGE + 1, verdict: { notNeeded: cutLine(BATCH) }, asked: true }], // exactly the threshold
    ["needed", { tool: "read", target: "needed.txt", chars: 40, age: AGE + 1, verdict: { notNeeded: cutLine(BATCH) - 0.01 }, asked: true }], // just under threshold
  ]);
  thread.calls = BATCH; // first release happens as soon as calls >= BATCH

  const ids = release(thread);
  assert.deepStrictEqual(ids, ["fallback", "unneeded"]);
  assert.strictEqual(thread.lastRelease, BATCH);
  assert.deepStrictEqual([...thread.dropped].sort(), ["fallback", "unneeded"]);
  assert.strictEqual(thread.droppedTargets.get("fallback.txt"), 20);
  assert.strictEqual(thread.droppedTargets.get("unneeded.txt"), 30);
  assert.strictEqual(thread.droppedTargets.has("young.txt"), false);
  assert.strictEqual(thread.droppedTargets.has("needed.txt"), false);
  assert.strictEqual(thread.items.get("fallback").head, null, "a dropped item's head is let go");
});

test("release: dropped ids are never returned twice, even in a later batch", () => {
  const thread = makeThread([
    ["fallback", { tool: "read", target: "fallback.txt", chars: 20, age: AGE + 1, verdict: null, asked: true }],
    ["needed", { tool: "read", target: "needed.txt", chars: 40, age: AGE + 1, verdict: { notNeeded: 0.1 }, asked: true }],
  ]);
  thread.calls = BATCH;
  assert.deepStrictEqual(release(thread), ["fallback"]);

  // A second batch passes. "fallback" is still in the map and still aged
  // past AGE, but it must not be offered again. A brand-new aged item
  // ("late") is released.
  thread.items.set("late", { tool: "read", target: "late.txt", chars: 50, age: AGE + 1, verdict: null, asked: false });
  thread.calls = BATCH * 2;
  const ids = release(thread);
  // "needed" (0.1) is still under the 40-call line, so it stays.
  assert.deepStrictEqual(ids, ["late"]);
  assert.deepStrictEqual([...thread.dropped].sort(), ["fallback", "late"]);
});

// --- cutLine() -----------------------------------------------------------

test("cutLine: 0.87 for a thread's first batch (up to 25 calls), 0.82 after", () => {
  assert.strictEqual(cutLine(0), 0.87);
  assert.strictEqual(cutLine(20), 0.87);
  assert.strictEqual(cutLine(25), 0.87);
  assert.strictEqual(cutLine(26), 0.82);
  assert.strictEqual(cutLine(400), 0.82);
});

test("release: at 25 calls a 0.85 verdict keeps (line 0.87), at 26 it cuts (line 0.82)", () => {
  const entry = () => ({ tool: "read", target: "f.txt", chars: 10, age: AGE + 1, verdict: { notNeeded: 0.85 }, asked: true });
  const at25 = makeThread([["a", entry()]]);
  at25.calls = 25;
  assert.deepStrictEqual(release(at25), [], "0.85 < 0.87: kept");

  const at26 = makeThread([["a", entry()]]);
  at26.calls = 26;
  assert.deepStrictEqual(release(at26), ["a"], "0.85 >= 0.82: cut");
});

test("track: the judge is asked at any thread length; the thread records when it was seen and its format", () => {
  const item = { id: "a", tool: "Read", target: "f.txt", chars: 10, age: AGE + 1, head: null };
  const s25 = {};
  assert.strictEqual(track(s25, { sessionId: "s", thread: "t", calls: 25, items: [item] }, 1000).toJudge.length, 1);
  const s26 = {};
  assert.strictEqual(track(s26, { sessionId: "s", thread: "t", calls: 26, format: "responses", items: [item] }, 2000).toJudge.length, 1);
  assert.strictEqual(s26.threads["s:t"].lastSeenAt, 2000);
  assert.strictEqual(s26.threads["s:t"].format, "responses");
});

// --- evictIdle() -----------------------------------------------------------

test("evictIdle: forgets threads idle longer than 2 h, keeps the rest", () => {
  const state = {};
  const seen = (thread) => ({ sessionId: "s", thread, calls: 1, items: [{ id: thread + "1", tool: "Read", target: "f", chars: 1, age: 0 }] });
  const t0 = 1_000_000;
  track(state, seen("old"), t0);
  track(state, seen("fresh"), t0 + IDLE_MS); // seen 2 h after "old"

  // At t0 + 2 h exactly, "old" has been idle exactly IDLE_MS: not over, kept.
  assert.deepStrictEqual(evictIdle(state, t0 + IDLE_MS), []);
  // 1 ms later it's over the line and goes; "fresh" (idle 1 ms) stays.
  assert.deepStrictEqual(evictIdle(state, t0 + IDLE_MS + 1), ["s:old"]);
  assert.deepStrictEqual(Object.keys(state.threads), ["s:fresh"]);
});

// --- rereads() -----------------------------------------------------------

test("rereads: charges a new id's chars once when its target was already dropped", () => {
  const thread = makeThread([]);
  thread.droppedTargets.set("f.txt", 999); // the chars value recorded at drop time; only presence matters here

  const seen = {
    items: [
      { id: "new1", tool: "read", target: "f.txt", chars: 1234, age: 0, head: null }, // new id, dropped target, fresh call -> counts
      { id: "new2", tool: "read", target: "other.txt", chars: 99, age: 0, head: null }, // target never dropped -> doesn't count
      { id: "new3", tool: "read", target: "f.txt", chars: 50, age: 3, head: null }, // not a fresh call (age !== 0) -> doesn't count
    ],
  };

  // Call rereads() before track() merges `seen` in, so "new1" is genuinely new.
  assert.strictEqual(rereads(thread, seen), 1234);

  // Once track() (or a stand-in) has recorded "new1", it is no longer new,
  // so a later report referencing the same id must not be charged again.
  thread.items.set("new1", { tool: "read", target: "f.txt", chars: 1234, age: 0, verdict: null, asked: false });
  assert.strictEqual(rereads(thread, seen), 0);
});

// --- cost() / saving() -----------------------------------------------------------

test("cost: input*1 + cacheRead*0.1 + cacheWrite5m*1.25 + cacheWrite1h*2 + output*5", () => {
  const usage = { input: 10, cacheRead: 90000, cacheWrite5m: 1000, cacheWrite1h: 0, output: 500 };
  // 10*1 + 90000*0.1 + 1000*1.25 + 0*2 + 500*5 = 10 + 9000 + 1250 + 0 + 2500 = 12760
  closeTo(cost(usage), 12760, "cost");
});

test("saving: a warm request (cache reads only, no cut)", () => {
  const usage = { input: 10, cacheRead: 90000, cacheWrite5m: 1000, cacheWrite1h: 0, output: 500 };
  const result = { usage, totalChars: 364040, removedChars: 40000, firstCutChars: null };

  // promptTokens = 10 + 90000 + 1000 + 0 = 91010
  // r = 91010 / 364040 = 0.25
  // writeW: cacheWrite1h(0) > cacheWrite5m(1000)? no -> 1.25 (unused here since cacheRead > 0)
  // unitPrice = cacheRead > 0 -> 0.1
  // gross = 40000 * 0.25 * 0.1 = 1000
  // cut = 0 (firstCutChars is null)
  // reread = 0
  // saved = 1000 - 0 - 0 = 1000
  const out = saving(result, 0);
  closeTo(out.saved, 1000, "saved (warm)");
  closeTo(out.actual, cost(usage), "actual");
  closeTo(out.removedTokens, 10000, "removedTokens (40000 * 0.25)");
});

test("saving: the same request as a cut (firstCutChars set) costs instead of saving", () => {
  const usage = { input: 10, cacheRead: 90000, cacheWrite5m: 1000, cacheWrite1h: 0, output: 500 };
  const result = { usage, totalChars: 364040, removedChars: 40000, firstCutChars: 300000 };

  // Same r = 0.25 and gross = 1000 as the warm case above.
  // cut = max(0, 364040 - 300000) * 0.25 * (1.25 - 0.1) = 64040 * 0.25 * 1.15 = 18411.5
  // saved = 1000 - 18411.5 - 0 = -17411.5 (a cut request costs; later requests pay it back)
  const out = saving(result, 0);
  closeTo(out.saved, -17411.5, "saved (cut)");
});

test("saving: a three-request sequence (cut, then two warm) sums to the hand-worked total", () => {
  const usage = { input: 10, cacheRead: 90000, cacheWrite5m: 1000, cacheWrite1h: 0, output: 500 };
  const cutResult = { usage, totalChars: 364040, removedChars: 40000, firstCutChars: 300000 };
  const warmResult = { usage, totalChars: 364040, removedChars: 40000, firstCutChars: null };

  // request 1 (the cut):  saved = -17411.5  (worked out above)
  // request 2 (warm):     saved =   1000    (worked out above)
  // request 3 (warm):     saved =   1000
  // total = -17411.5 + 1000 + 1000 = -15411.5
  const total = saving(cutResult, 0).saved + saving(warmResult, 0).saved + saving(warmResult, 0).saved;
  closeTo(total, -15411.5, "three-request sequence total");
});

test("saving: with sentChars, tokens per char is taken over the whole body, not the messages alone", () => {
  // 60000 prompt tokens, of which a big share is system prompt + tool
  // schemas. The messages are 160000 chars; the whole body is 240000.
  const usage = { input: 0, cacheRead: 60000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
  const base = { usage, totalChars: 160000, removedChars: 40000, firstCutChars: null };

  // with sentChars: r = 60000 / 240000 = 0.25
  //   gross = 40000 * 0.25 * 0.1 = 1000; removedTokens = 40000 * 0.25 = 10000
  const out = saving({ ...base, sentChars: 240000 }, 0);
  closeTo(out.saved, 1000, "saved (sentChars)");
  closeTo(out.removedTokens, 10000, "removedTokens (sentChars)");

  // without it (an older Wibble): r = 60000 / 160000 = 0.375 -> 1.5x as much
  //   gross = 40000 * 0.375 * 0.1 = 1500; removedTokens = 15000
  const old = saving(base, 0);
  closeTo(old.saved, 1500, "saved (fallback to totalChars)");
  closeTo(old.removedTokens, 15000, "removedTokens (fallback)");

  // 0 or missing sentChars falls back the same way.
  closeTo(saving({ ...base, sentChars: 0 }, 0).saved, 1500, "sentChars 0 falls back");
});

test("saving: a re-read is charged as the extra request it forces", () => {
  const usage = { input: 0, cacheRead: 60000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
  const result = { usage, totalChars: 160000, sentChars: 240000, removedChars: 40000, firstCutChars: null };

  // r = 0.25, gross = 1000 (as above), writeW = 1.25 (anthropic, 5m)
  // reread = whole prompt at cache read + re-read text written
  //        = 60000 * 0.1 + 8000 * 0.25 * 1.25 = 6000 + 2500 = 8500
  // saved = 1000 - 8500 = -7500
  closeTo(saving(result, 8000, "anthropic").saved, -7500, "saved with an 8000-char re-read");
});

test("saving: a cold request on an OpenAI-style engine prices the write at 1x, not 1.25x", () => {
  const usage = { input: 60000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
  const result = { usage, totalChars: 240000, removedChars: 40000, firstCutChars: null };

  // r = 60000 / 240000 = 0.25; nothing read from cache -> unitPrice = writeW
  //   anthropic: gross = 40000 * 0.25 * 1.25 = 12500
  //   responses: gross = 40000 * 0.25 * 1    = 10000
  closeTo(saving(result, 0, "anthropic").saved, 12500, "anthropic");
  closeTo(saving(result, 0, "responses").saved, 10000, "responses");
  closeTo(saving(result, 0, "chat").saved, 10000, "chat");
  closeTo(saving(result, 0).saved, 12500, "unknown format keeps the Anthropic prices");
});

// --- dollars() / percent() -----------------------------------------------------------

test("dollars: matches a known model family by substring, null for an unknown one", () => {
  assert.strictEqual(PRICE_PER_M.opus, 5);
  closeTo(dollars(1_000_000, "claude-opus-5"), 5, "opus, 1M units");
  closeTo(dollars(1_000_000, "claude-sonnet-5"), 3, "sonnet, 1M units");
  closeTo(dollars(1_000_000, "claude-haiku-5"), 1, "haiku, 1M units");
  closeTo(dollars(500_000, "claude-opus-5"), 2.5, "opus, 500k units");
  assert.strictEqual(dollars(1_000_000, "gpt-4o"), null);
  assert.strictEqual(dollars(1_000_000, undefined), null);
});

test("percent: saved / (actual + saved), and 0 (not NaN) when both are 0", () => {
  // 1000 / (12760 + 1000) = 1000 / 13760
  closeTo(percent({ saved: 1000, actual: 12760 }), 1000 / 13760, "percent");

  // A fresh install (or a week with no activity) has totals {saved: 0,
  // actual: 0}. saved/(actual+saved) is 0/0 there, which is NaN, not a
  // percentage -- percent() special-cases the empty denominator to 0.
  assert.strictEqual(percent({ saved: 0, actual: 0 }), 0, "percent of nothing spent or saved is 0, not NaN");
});

// --- slugOf() -----------------------------------------------------------

test("slugOf: model id -> OpenRouter author/slug, per the brief's worked cases", () => {
  assert.strictEqual(slugOf("claude-opus-5-5"), "anthropic/claude-opus-5.5");
  assert.strictEqual(slugOf("claude-opus-5-5[1m]"), "anthropic/claude-opus-5.5", "a [1m] suffix is stripped");
  assert.strictEqual(slugOf("claude-haiku-4-5-20251001"), "anthropic/claude-haiku-4.5", "a trailing date is stripped before the digit join");
  assert.strictEqual(slugOf("gpt-5.5"), "openai/gpt-5.5");
  assert.strictEqual(slugOf("gpt-5-codex"), "openai/gpt-5-codex", "no digit follows the dash, so it's left alone");
  assert.strictEqual(slugOf("openrouter/deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro", "a router prefix is stripped, then it's already author/slug");
  assert.strictEqual(slugOf("deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro", "already author/slug -- unchanged");
  assert.strictEqual(slugOf("mystery"), null, "no known author prefix and no slash");
  assert.strictEqual(slugOf(null), null);
});

// --- parseEndpoints() -----------------------------------------------------------

// A body shaped like a real `.../endpoints` response: two Anthropic
// endpoints and one Google, prices as dollar-per-token strings.
const ENDPOINTS_BODY = JSON.stringify({
  data: {
    id: "anthropic/claude-opus-5.5",
    endpoints: [
      {
        provider_name: "Anthropic",
        context_length: 1000000,
        pricing: { prompt: "0.000004", completion: "0.00002", input_cache_read: "0.0000002", input_cache_write: "0.000005", input_cache_write_1h: "0.000008" },
      },
      {
        provider_name: "Anthropic",
        context_length: 200000,
        pricing: { prompt: "0.000008", completion: "0.00004", input_cache_read: "0.0000004", input_cache_write: "0.00001", input_cache_write_1h: "0.000016" },
      },
      {
        provider_name: "Google",
        context_length: 1000000,
        pricing: { prompt: "0.0000044", completion: "0.000022", input_cache_read: "0.00000044" },
      },
    ],
  },
});

test("parseEndpoints: picks the cheapest endpoint from the model's own maker", () => {
  const priced = parseEndpoints(ENDPOINTS_BODY, "anthropic/claude-opus-5.5");
  assert.deepStrictEqual(priced, { input: 4e-6, cacheRead: 2e-7, write5m: 5e-6, write1h: 8e-6, output: 2e-5, context: 1000000 });
});

test("parseEndpoints: no maker match falls back to the cheapest of every endpoint listed", () => {
  // Anthropic's own cheapest endpoint (0.000004) is NOT the cheapest one
  // here -- Google's (0.000003) is. "mystery" has no entry in MAKERS, so
  // nothing narrows the pool to a maker at all, and the cheapest of every
  // endpoint listed wins, proving this isn't just coincidentally the same
  // pick as the maker-matched test above.
  assert.strictEqual(MAKERS.mystery, undefined);
  const body = JSON.stringify({
    data: {
      endpoints: [
        { provider_name: "Anthropic", context_length: 1000000, pricing: { prompt: "0.000004", completion: "0.00002", input_cache_read: "0.0000002" } },
        { provider_name: "Google", context_length: 500000, pricing: { prompt: "0.000003", completion: "0.000009", input_cache_read: "0.0000003" } },
      ],
    },
  });
  const priced = parseEndpoints(body, "mystery/model");
  assert.deepStrictEqual(priced, { input: 3e-6, cacheRead: 3e-7, write5m: 3e-6, write1h: 3e-6, output: 9e-6, context: 500000 });
});

test("parseEndpoints: a missing input_cache_write/input_cache_write_1h/input_cache_read costs the same as input", () => {
  const body = JSON.stringify({
    data: {
      endpoints: [{ provider_name: "OpenAI", context_length: 400000, pricing: { prompt: "0.00000125", completion: "0.00001" } }],
    },
  });
  const priced = parseEndpoints(body, "openai/gpt-5-codex");
  assert.deepStrictEqual(priced, { input: 1.25e-6, cacheRead: 1.25e-6, write5m: 1.25e-6, write1h: 1.25e-6, output: 1e-5, context: 400000 });
});

test("parseEndpoints: malformed JSON, no data.endpoints, and a non-numeric price all give null", () => {
  assert.strictEqual(parseEndpoints("{not json", "anthropic/claude-opus-5.5"), null, "malformed JSON");
  assert.strictEqual(parseEndpoints(JSON.stringify({ data: { id: "x" } }), "anthropic/claude-opus-5.5"), null, "no data.endpoints");
  const badPrice = JSON.stringify({
    data: { endpoints: [{ provider_name: "Anthropic", pricing: { prompt: "not-a-number", completion: "0.00002" } }] },
  });
  assert.strictEqual(parseEndpoints(badPrice, "anthropic/claude-opus-5.5"), null, "a non-numeric price leaves no usable endpoint");
});

// --- priceFor() -----------------------------------------------------------

test("priceFor: a fetched entry wins over the built-in table", () => {
  const fetched = { "anthropic/claude-opus-5.5": { prices: { input: 3e-6, cacheRead: 1e-7, write5m: 4e-6, write1h: 6e-6, output: 1.5e-5, context: 1000000 }, at: 12345 } };
  const out = priceFor("claude-opus-5-5", fetched);
  assert.deepStrictEqual(out, { slug: "anthropic/claude-opus-5.5", prices: fetched["anthropic/claude-opus-5.5"].prices, source: "fetched" });
});

test("priceFor: the built-in table is used when nothing has been fetched for that slug", () => {
  const out = priceFor("claude-opus-5-5", {});
  assert.deepStrictEqual(out, { slug: "anthropic/claude-opus-5.5", prices: BUILTIN_PRICES["anthropic/claude-opus-5.5"], source: "built-in" });

  // No `fetched` argument at all behaves the same way.
  assert.deepStrictEqual(priceFor("claude-opus-5-5", undefined), out);
});

test("priceFor: an unknown model is null, fetched or not", () => {
  assert.strictEqual(priceFor("mystery-model-9000", {}), null);
  assert.strictEqual(priceFor(null, {}), null);
});
