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
import { track, release, rereads, cost, saving, dollars, percent, PRICE_PER_M, AGE, BATCH, cutLine } from "./main.js";

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
    ["fallback", { tool: "read", target: "fallback.txt", chars: 20, age: AGE + 1, verdict: null, asked: true }], // no verdict at all
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
  // At 40 calls the thread is past the last cut line (cutLine(40) is null),
  // so "needed"'s verdict is ignored and the age rule cuts it too.
  assert.deepStrictEqual(ids, ["needed", "late"]);
  assert.deepStrictEqual([...thread.dropped].sort(), ["fallback", "late", "needed"]);
});

// --- cutLine() -----------------------------------------------------------

test("cutLine: 0.82 up to 10 calls, 0.78 for 11-25, none (pure age rule) past 25", () => {
  assert.strictEqual(cutLine(0), 0.82);
  assert.strictEqual(cutLine(10), 0.82);
  assert.strictEqual(cutLine(11), 0.78);
  assert.strictEqual(cutLine(25), 0.78);
  assert.strictEqual(cutLine(26), null);
  assert.strictEqual(cutLine(400), null);
});

test("release: at 25 calls a 0.77 verdict keeps (line 0.78), at 26 the verdict is ignored and the age rule cuts", () => {
  const entry = () => ({ tool: "read", target: "f.txt", chars: 10, age: AGE + 1, verdict: { notNeeded: 0.77 }, asked: true });
  const at25 = makeThread([["a", entry()]]);
  at25.calls = 25;
  assert.deepStrictEqual(release(at25), [], "0.77 < 0.78: kept");

  const at26 = makeThread([["a", entry()]]);
  at26.calls = 26;
  assert.deepStrictEqual(release(at26), ["a"], "past 25 calls the verdict is ignored");
});

test("release: at 10 calls the line is 0.82, at 11 it is 0.78", () => {
  const entry = () => ({ tool: "read", target: "f.txt", chars: 10, age: AGE + 1, verdict: { notNeeded: 0.8 }, asked: true });
  const at10 = makeThread([["a", entry()]]);
  at10.calls = 10;
  at10.lastRelease = 10 - BATCH; // a batch is due
  assert.deepStrictEqual(release(at10), [], "0.80 < 0.82: kept");

  const at11 = makeThread([["a", entry()]]);
  at11.calls = 11;
  at11.lastRelease = 11 - BATCH;
  assert.deepStrictEqual(release(at11), ["a"], "0.80 >= 0.78: cut");
});

test("track: past 25 calls nothing is sent to the judge; at 25 it still is", () => {
  const item = { id: "a", tool: "Read", target: "f.txt", chars: 10, age: AGE + 1, head: null };
  const s25 = {};
  assert.strictEqual(track(s25, { sessionId: "s", thread: "t", calls: 25, items: [item] }).toJudge.length, 1);
  const s26 = {};
  assert.deepStrictEqual(track(s26, { sessionId: "s", thread: "t", calls: 26, items: [item] }).toJudge, []);
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
