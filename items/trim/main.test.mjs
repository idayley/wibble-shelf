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
  plan,
  v1Line,
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
  slugOf,
  parseEndpoints,
  priceFor,
  BUILTIN_PRICES,
  MAKERS,
  LEFT_TABLE,
  left,
  CALIBRATION,
  probNotNeeded,
  savingUsd,
  noteChat,
  CHATS_KEEP,
  detailNode,
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

// --- plan(), prices null: v1's release, unchanged ----------------------

function makeThread(itemEntries) {
  return { calls: 0, lastRelease: 0, items: new Map(itemEntries), dropped: new Set(), droppedTargets: new Map(), coldPending: new Set(), stats: { cuts: 0, freeCuts: 0, skipped: 0 } };
}

const NO_SEEN = { totalChars: 0, items: [] };

/** plan() with no prices: v1 behaviour, so only `now` can be non-empty. */
function v1Release(thread) {
  const out = plan(thread, NO_SEEN, null);
  assert.deepStrictEqual(out.cold, []);
  assert.deepStrictEqual(out.withdraw, []);
  assert.strictEqual(out.net, 0);
  return out.now;
}

test("plan (no prices): no release before 20 calls", () => {
  const thread = makeThread([["a", { tool: "read", target: "f.txt", chars: 10, age: AGE + 1, verdict: null, asked: false }]]);
  thread.calls = BATCH - 1; // 19

  const ids = v1Release(thread);
  assert.deepStrictEqual(ids, []);
  assert.strictEqual(thread.lastRelease, 0, "no release happened, so lastRelease is untouched");
  assert.strictEqual(thread.dropped.size, 0);
});

test("plan (no prices): at 20 calls, drops age>5 items (fallback or notNeeded>=v1Line), keeps age<=5 and a needed verdict", () => {
  const thread = makeThread([
    ["tooYoung", { tool: "read", target: "young.txt", chars: 10, age: AGE, verdict: null, asked: false }], // age === AGE, not > AGE
    ["fallback", { tool: "read", target: "fallback.txt", chars: 20, age: AGE + 1, head: "x", verdict: null, asked: true }], // no verdict at all
    ["unneeded", { tool: "read", target: "unneeded.txt", chars: 30, age: AGE + 1, verdict: { notNeeded: v1Line(BATCH) }, asked: true }], // exactly the threshold
    ["needed", { tool: "read", target: "needed.txt", chars: 40, age: AGE + 1, verdict: { notNeeded: v1Line(BATCH) - 0.01 }, asked: true }], // just under threshold
  ]);
  thread.calls = BATCH; // first release happens as soon as calls >= BATCH

  const ids = v1Release(thread);
  assert.deepStrictEqual(ids, ["fallback", "unneeded"]);
  assert.strictEqual(thread.lastRelease, BATCH);
  assert.deepStrictEqual([...thread.dropped].sort(), ["fallback", "unneeded"]);
  assert.strictEqual(thread.droppedTargets.get("fallback.txt"), 20);
  assert.strictEqual(thread.droppedTargets.get("unneeded.txt"), 30);
  assert.strictEqual(thread.droppedTargets.has("young.txt"), false);
  assert.strictEqual(thread.droppedTargets.has("needed.txt"), false);
  assert.strictEqual(thread.items.get("fallback").head, null, "a dropped item's head is let go");
});

test("plan (no prices): dropped ids are never returned twice, even in a later batch", () => {
  const thread = makeThread([
    ["fallback", { tool: "read", target: "fallback.txt", chars: 20, age: AGE + 1, verdict: null, asked: true }],
    ["needed", { tool: "read", target: "needed.txt", chars: 40, age: AGE + 1, verdict: { notNeeded: 0.1 }, asked: true }],
  ]);
  thread.calls = BATCH;
  assert.deepStrictEqual(v1Release(thread), ["fallback"]);

  // A second batch passes. "fallback" is still in the map and still aged
  // past AGE, but it must not be offered again. A brand-new aged item
  // ("late") is released.
  thread.items.set("late", { tool: "read", target: "late.txt", chars: 50, age: AGE + 1, verdict: null, asked: false });
  thread.calls = BATCH * 2;
  const ids = v1Release(thread);
  // "needed" (0.1) is still under the 40-call line, so it stays.
  assert.deepStrictEqual(ids, ["late"]);
  assert.deepStrictEqual([...thread.dropped].sort(), ["fallback", "late"]);
});

test("plan (no prices): cutting an id that was parked for a cold cache takes it out of the parked set", () => {
  const thread = makeThread([["x", { tool: "read", target: "x.txt", chars: 20, age: AGE + 1, verdict: null, asked: true }]]);
  thread.coldPending.add("x"); // parked while the model's prices were known
  thread.calls = BATCH;
  assert.deepStrictEqual(v1Release(thread), ["x"]);
  assert.strictEqual(thread.coldPending.size, 0);
});

// --- v1Line() -----------------------------------------------------------

test("v1Line: 0.87 for a thread's first batch (up to 25 calls), 0.82 after", () => {
  assert.strictEqual(v1Line(0), 0.87);
  assert.strictEqual(v1Line(20), 0.87);
  assert.strictEqual(v1Line(25), 0.87);
  assert.strictEqual(v1Line(26), 0.82);
  assert.strictEqual(v1Line(400), 0.82);
});

test("plan (no prices): at 25 calls a 0.85 verdict keeps (line 0.87), at 26 it cuts (line 0.82)", () => {
  const entry = () => ({ tool: "read", target: "f.txt", chars: 10, age: AGE + 1, verdict: { notNeeded: 0.85 }, asked: true });
  const at25 = makeThread([["a", entry()]]);
  at25.calls = 25;
  assert.deepStrictEqual(v1Release(at25), [], "0.85 < 0.87: kept");

  const at26 = makeThread([["a", entry()]]);
  at26.calls = 26;
  assert.deepStrictEqual(v1Release(at26), ["a"], "0.85 >= 0.82: cut");
});

// --- plan(), with prices ---------------------------------------------------
//
// Shared setup, per the brief: Opus 5.5's prices, r = 0.25 tokens/char,
// calls = 20 (so L = left(20) = 105), P = 50,000 prompt tokens, a 200,000-char
// request. CAL maps every score to p = 0.99, so the sums below are exact.

const PRICES = { input: 4e-6, cacheRead: 2e-7, write5m: 5e-6, write1h: 8e-6, output: 2e-5, context: 1e6 };
const CAL = { bins: [[1, 0.99]], baseRate: 0.99 };
const KEEPER = { bins: [[1, 0.001]], baseRate: 0.001 }; // every item now reads as needed
const SEEN = { totalChars: 200000, items: [] };

function pricedThread(items) {
  const thread = makeThread(items.map(([id, chars, at]) => [id, { tool: "Read", target: id + ".txt", chars, at, age: AGE + 1, verdict: { notNeeded: 0.99 }, asked: true }]));
  thread.calls = BATCH;
  thread.r = 0.25;
  thread.promptTokens = 50000;
  return thread;
}

test("plan: a 40,000-char item near the start costs more to rewrite than it saves, so it waits for a cold cache", () => {
  // keep   = 40000 * 0.25 * 2e-7 * 105                = $0.21
  // reread = 40000 * 0.25 * 5e-6 + 50000 * 2e-7        = $0.05 + $0.01 = $0.06
  //   candidate: 0.99 * 0.21 = 0.2079 >= 0.01 * 0.06 = 0.0006
  // cost   = (200000 - 10000) * 0.25 * (5e-6 - 2e-7)   = $0.228
  // net    = 0.2079 - 0.0006 - 0.228                  = -$0.0207 -> no cut
  const thread = pricedThread([["a", 40000, 10000]]);
  const out = plan(thread, SEEN, PRICES, CAL);
  assert.deepStrictEqual(out.now, []);
  assert.deepStrictEqual(out.cold, ["a"]);
  assert.deepStrictEqual(out.withdraw, []);
  assert.strictEqual(out.net, 0);
  assert.strictEqual(thread.lastRelease, BATCH, "a due batch always moves lastRelease on");
  assert.strictEqual(thread.dropped.size, 0);
  assert.deepStrictEqual([...thread.coldPending], ["a"]);
  assert.strictEqual(thread.stats.skipped, 1);
});

test("plan: the same item near the end pays back, so it is cut now", () => {
  // cost = (200000 - 160000) * 0.25 * 4.8e-6 = $0.048
  // net  = 0.2079 - 0.0006 - 0.048          = $0.1593
  const thread = pricedThread([["a", 40000, 160000]]);
  const out = plan(thread, SEEN, PRICES, CAL);
  assert.deepStrictEqual(out.now, ["a"]);
  assert.deepStrictEqual(out.cold, []);
  closeTo(out.net, 0.1593, "net");
  assert.deepStrictEqual([...thread.dropped], ["a"]);
  assert.strictEqual(thread.droppedTargets.get("a.txt"), 40000);
  assert.strictEqual(thread.coldPending.size, 0);
  assert.strictEqual(thread.stats.skipped, 0);
});

test("plan: the best cut point skips a small early item and takes the big late one", () => {
  // Candidates by at: small (2,000 chars at 10,000), big (40,000 at 150,000).
  //   small: keep = 2000*0.25*2e-7*105 = $0.0105, reread = 2000*0.25*5e-6 + 0.01 = $0.0125
  //   big:   keep = $0.21,                         reread = $0.06
  // k = small: save = 0.99*(0.0105+0.21) = 0.218295, risk = 0.01*(0.0125+0.06) = 0.000725,
  //            cost = 190000*0.25*4.8e-6 = 0.228  -> net = -0.01043
  // k = big:   save = 0.2079, risk = 0.0006,
  //            cost = 50000*0.25*4.8e-6 = 0.06    -> net =  0.1473
  const thread = pricedThread([["big", 40000, 150000], ["small", 2000, 10000]]);
  const out = plan(thread, SEEN, PRICES, CAL);
  assert.deepStrictEqual(out.now, ["big"]);
  assert.deepStrictEqual(out.cold, ["small"]);
  closeTo(out.net, 0.1473, "net");
});

test("plan: the 1-hour write price is used when the thread's last result wrote the 1-hour cache", () => {
  // cost = 40000 * 0.25 * (8e-6 - 2e-7) = $0.078; reread = 40000*0.25*8e-6 + 0.01 = $0.09
  // net  = 0.2079 - 0.01*0.09 - 0.078   = $0.1290
  const thread = pricedThread([["a", 40000, 160000]]);
  thread.write1h = true;
  closeTo(plan(thread, SEEN, PRICES, CAL).net, 0.129, "net");
});

test("plan: a parked item is not parked twice, and is withdrawn once its verdict says keep", () => {
  const thread = pricedThread([["a", 40000, 10000]]);
  assert.deepStrictEqual(plan(thread, SEEN, PRICES, CAL).cold, ["a"]);

  // Next batch, same odds: still a candidate, already parked -> not in cold
  // again. (Re-armed at 20 calls, not moved to 40: at 40, L = 132 and the
  // cut would pay back now.)
  thread.lastRelease = 0;
  let out = plan(thread, SEEN, PRICES, CAL);
  assert.deepStrictEqual(out.now, []);
  assert.deepStrictEqual(out.cold, []);
  assert.deepStrictEqual(out.withdraw, []);
  assert.strictEqual(thread.stats.skipped, 1);

  // The judge now says it's needed: p = 0.001 -> 0.001*keep < 0.999*reread.
  thread.lastRelease = 0;
  out = plan(thread, SEEN, PRICES, KEEPER);
  assert.deepStrictEqual(out.now, []);
  assert.deepStrictEqual(out.cold, []);
  assert.deepStrictEqual(out.withdraw, ["a"]);
  assert.strictEqual(thread.coldPending.size, 0);
});

test("plan: a parked item that later pays back is cut now and leaves the parked set", () => {
  const thread = pricedThread([["a", 40000, 10000]]);
  plan(thread, SEEN, PRICES, CAL);
  thread.items.get("a").at = 160000; // earlier output was cut, so it moved up
  thread.calls = BATCH * 2;
  const out = plan(thread, SEEN, PRICES, CAL);
  assert.deepStrictEqual(out.now, ["a"]);
  assert.deepStrictEqual(out.withdraw, []);
  assert.strictEqual(thread.coldPending.size, 0);
});

test("plan: not due -> nothing returned, nothing changed", () => {
  const thread = pricedThread([["a", 40000, 160000]]);
  thread.calls = BATCH - 1;
  const out = plan(thread, SEEN, PRICES, CAL);
  assert.deepStrictEqual(out, { now: [], cold: [], withdraw: [], net: 0 });
  assert.strictEqual(thread.lastRelease, 0);
  assert.strictEqual(thread.dropped.size, 0);
  assert.strictEqual(thread.coldPending.size, 0);
  assert.strictEqual(thread.stats.skipped, 0);
});

test("plan: items without `at` sit at the earliest known position (0 when none is known)", () => {
  // "late" has no at, so it counts as sitting at 150,000 (the only known
  // at): both it and "known" are cut, costing the rewrite from 150,000.
  const mixed = pricedThread([["known", 40000, 150000], ["late", 40000, undefined]]);
  const out = plan(mixed, SEEN, PRICES, CAL);
  assert.deepStrictEqual(out.now.sort(), ["known", "late"]);
  // save = 2*0.2079, risk = 2*0.0006, cost = 50000*0.25*4.8e-6 = 0.06
  closeTo(out.net, 0.3546, "net");

  // No at anywhere (an older Wibble): everything sits at 0, so the rewrite
  // is the whole 200,000 chars = $0.24 > $0.2073 saved -> parked.
  const old = pricedThread([["a", 40000, undefined]]);
  const outOld = plan(old, SEEN, PRICES, CAL);
  assert.deepStrictEqual(outOld.now, []);
  assert.deepStrictEqual(outOld.cold, ["a"]);
});

test("plan: r and promptTokens fall back to 0.3 and totalChars * r before any result has arrived", () => {
  // r = 0.3, P = 200000*0.3 = 60000.
  // keep = 40000*0.3*2e-7*105 = 0.252; reread = 40000*0.3*5e-6 + 60000*2e-7 = 0.072
  // cost = 40000*0.3*4.8e-6 = 0.0576; net = 0.99*0.252 - 0.01*0.072 - 0.0576 = 0.19116
  const thread = pricedThread([["a", 40000, 160000]]);
  delete thread.r;
  delete thread.promptTokens;
  closeTo(plan(thread, SEEN, PRICES, CAL).net, 0.19116, "net");
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

test("track: every thread starts with an empty parked set and zeroed stats, and keeps each item's latest `at`", () => {
  const state = {};
  const seen = (calls, at) => ({ sessionId: "s", thread: "t", calls, items: [{ id: "a", tool: "Read", target: "f.txt", chars: 10, age: 0, head: null, at }] });
  track(state, seen(1, 500));
  const thread = state.threads["s:t"];
  assert.ok(thread.coldPending instanceof Set && thread.coldPending.size === 0);
  assert.deepStrictEqual(thread.stats, { cuts: 0, freeCuts: 0, skipped: 0 });
  assert.strictEqual(thread.items.get("a").at, 500);
  track(state, seen(2, 300)); // something before it was cut: it moved up
  assert.strictEqual(thread.items.get("a").at, 300);
  track(state, seen(3, undefined)); // an older Wibble's report: keep what we had
  assert.strictEqual(thread.items.get("a").at, 300);
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

// --- savingUsd() -----------------------------------------------------------

// Opus 5.5's built-in prices: cacheRead 2e-7, write5m 5e-6, write1h 8e-6.
const OPUS = BUILTIN_PRICES["anthropic/claude-opus-5.5"];
const WARM_USAGE = { input: 10, cacheRead: 90000, cacheWrite5m: 1000, cacheWrite1h: 0, output: 500 };

test("savingUsd: a warm request with no cut saves the removed chars at the cache-read price", () => {
  const result = { usage: WARM_USAGE, sentChars: 364040, totalChars: 364040, removedChars: 40000, firstCutChars: null };
  // P = 10 + 90000 + 1000 = 91010; r = 91010 / 364040 = 0.25
  // gross = 40000 * 0.25 * 2e-7 = $0.002
  // actual = 10*4e-6 + 90000*2e-7 + 1000*5e-6 + 500*2e-5 = 0.00004 + 0.018 + 0.005 + 0.01 = $0.03304
  const out = savingUsd(result, 0, OPUS);
  closeTo(out.saved, 0.002, "saved");
  closeTo(out.actual, 0.03304, "actual");
  closeTo(out.removedTokens, 10000, "removedTokens (40000 * 0.25)");
  closeTo(out.cutCost, 0, "cutCost");
  closeTo(out.rereadCost, 0, "rereadCost");
});

test("savingUsd: a cut on a warm cache pays the rewrite from the first cut to the end", () => {
  const result = { usage: WARM_USAGE, sentChars: 364040, totalChars: 364040, removedChars: 40000, firstCutChars: 300000 };
  // cut = (364040 - 300000) * 0.25 * (5e-6 - 2e-7) = 64040 * 0.25 * 4.8e-6 = $0.076848
  // saved = 0.002 - 0.076848 = -$0.074848
  const out = savingUsd(result, 0, OPUS);
  closeTo(out.cutCost, 0.076848, "cutCost");
  closeTo(out.saved, 0.002 - 0.076848, "saved");
});

test("savingUsd: on a cold request the cut is free, and the removed chars save the write price", () => {
  const result = { usage: WARM_USAGE, sentChars: 364040, totalChars: 364040, removedChars: 40000, firstCutChars: 300000, cold: true };
  // cutCost = 0 (the whole prompt was rewritten anyway)
  // gross = 40000 * 0.25 * 5e-6 = $0.05
  const out = savingUsd(result, 0, OPUS);
  closeTo(out.cutCost, 0, "cutCost");
  closeTo(out.saved, 0.05, "saved");
});

test("savingUsd: nothing read from cache prices the gross at the write price, the 1-hour one when that was written", () => {
  const usage = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 60000, output: 0 };
  const result = { usage, sentChars: 240000, totalChars: 240000, removedChars: 40000, firstCutChars: null };
  // r = 60000 / 240000 = 0.25; write = write1h (8e-6), since cacheWrite1h > cacheWrite5m
  // gross = 40000 * 0.25 * 8e-6 = $0.08
  closeTo(savingUsd(result, 0, OPUS).saved, 0.08, "saved");
});

test("savingUsd: a re-read charges the whole prompt at the read price plus the re-read text written", () => {
  const result = { usage: WARM_USAGE, sentChars: 364040, totalChars: 364040, removedChars: 40000, firstCutChars: null };
  // reread = P * cacheRead + chars * r * write = 91010 * 2e-7 + 2000 * 0.25 * 5e-6
  //        = 0.018202 + 0.0025 = $0.020702
  // saved = 0.002 - 0.020702 = -$0.018702
  const out = savingUsd(result, 2000, OPUS);
  closeTo(out.rereadCost, 0.020702, "rereadCost");
  closeTo(out.saved, 0.002 - 0.020702, "saved");
});

// --- noteChat() -----------------------------------------------------------

test("noteChat: creates a chat, keeps the highest calls, and adds dollars and units", () => {
  const chats = {};
  noteChat(chats, "s1", { calls: 12, model: "claude-opus-5-5", billing: "plan" }, 1000);
  noteChat(chats, "s1", { calls: 9 }, 2000); // a subagent's shorter thread in the same session
  noteChat(chats, "s1", { usd: { saved: 0.5, actual: 2 }, units: { saved: 100, actual: 400 } }, 3000);
  noteChat(chats, "s1", { usd: { saved: 0.25, actual: 1 }, units: { saved: 50, actual: 200 } }, 4000);
  assert.deepStrictEqual(chats.s1, {
    saved: 0.75,
    actual: 3,
    calls: 12,
    model: "claude-opus-5-5",
    billing: "plan",
    lastAt: 4000,
    usd: true,
    units: { saved: 150, actual: 600 },
    cuts: 0,
    freeCuts: 0,
    skipped: 0,
    rereads: 0,
    rereadCost: 0,
  });
});

test("noteChat: counts cuts, free cuts, skipped candidates, re-reads and their cost, per chat", () => {
  const chats = {};
  noteChat(chats, "s1", { cuts: 3, freeCuts: 1, skipped: 2 }, 1000);
  noteChat(chats, "s1", { cuts: 1, skipped: 1, rereads: 1, rereadCost: 0.5 }, 2000);
  assert.strictEqual(chats.s1.cuts, 4, "3 + 1");
  assert.strictEqual(chats.s1.freeCuts, 1);
  assert.strictEqual(chats.s1.skipped, 3, "2 + 1");
  assert.strictEqual(chats.s1.rereads, 1);
  closeTo(chats.s1.rereadCost, 0.5, "rereadCost");

  // A field left out of a call doesn't touch what's already there.
  noteChat(chats, "s1", { model: "claude-opus-5-5" }, 3000);
  assert.strictEqual(chats.s1.cuts, 4, "unaffected by a call that names no cuts");
});

test("noteChat: one result without dollars marks the chat's dollars incomplete; units still add up", () => {
  const chats = {};
  noteChat(chats, "s1", { usd: { saved: 0.5, actual: 2 }, units: { saved: 100, actual: 400 } }, 1000);
  noteChat(chats, "s1", { usd: null, units: { saved: 10, actual: 40 } }, 2000);
  assert.strictEqual(chats.s1.usd, false);
  assert.strictEqual(chats.s1.saved, 0.5);
  assert.deepStrictEqual(chats.s1.units, { saved: 110, actual: 440 });
});

test("noteChat: keeps at most CHATS_KEEP chats, forgetting the one seen longest ago", () => {
  const chats = {};
  for (let i = 0; i < CHATS_KEEP; i++) noteChat(chats, "s" + i, { calls: 1 }, 1000 + i);
  noteChat(chats, "s0", { calls: 2 }, 5000); // s0 is fresh again; s1 is now the oldest
  noteChat(chats, "new", { calls: 1 }, 6000);
  assert.strictEqual(Object.keys(chats).length, CHATS_KEEP);
  assert.ok(chats.s0 && chats.new && !chats.s1);
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
  assert.strictEqual(slugOf(undefined), null, "an older Wibble that sends no model at all");
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

test("parseEndpoints: a known maker whose provider_name matches nothing in the body still falls back to the cheapest of all", () => {
  // "Anthropic" IS in MAKERS (unlike the "mystery" case above), but no
  // endpoint here is provider_name "Anthropic" -- both listed are OpenAI
  // and Google. A known-but-absent maker must fall back the same way an
  // unknown one does.
  const body = JSON.stringify({
    data: {
      endpoints: [
        { provider_name: "OpenAI", context_length: 400000, pricing: { prompt: "0.000005", completion: "0.00002", input_cache_read: "0.0000005" } },
        { provider_name: "Google", context_length: 500000, pricing: { prompt: "0.000003", completion: "0.000009", input_cache_read: "0.0000003" } },
      ],
    },
  });
  const priced = parseEndpoints(body, "anthropic/claude-opus-5.5");
  assert.deepStrictEqual(priced, { input: 3e-6, cacheRead: 3e-7, write5m: 3e-6, write1h: 3e-6, output: 9e-6, context: 500000 });
});

test("parseEndpoints: malformed JSON, no data.endpoints, a non-numeric price and a negative price all give null", () => {
  assert.strictEqual(parseEndpoints("{not json", "anthropic/claude-opus-5.5"), null, "malformed JSON");
  assert.strictEqual(parseEndpoints(JSON.stringify({ data: { id: "x" } }), "anthropic/claude-opus-5.5"), null, "no data.endpoints");
  const badPrice = JSON.stringify({
    data: { endpoints: [{ provider_name: "Anthropic", pricing: { prompt: "not-a-number", completion: "0.00002" } }] },
  });
  assert.strictEqual(parseEndpoints(badPrice, "anthropic/claude-opus-5.5"), null, "a non-numeric price leaves no usable endpoint");
  const negativePrice = JSON.stringify({
    data: { endpoints: [{ provider_name: "Anthropic", pricing: { prompt: "-0.000001", completion: "0.00002" } }] },
  });
  assert.strictEqual(parseEndpoints(negativePrice, "anthropic/claude-opus-5.5"), null, "a negative price is rejected, same as non-numeric");
});

// --- priceFor() -----------------------------------------------------------

test("priceFor: a fetched entry wins over the built-in table", () => {
  const fetched = { "anthropic/claude-opus-5.5": { prices: { input: 3e-6, cacheRead: 1e-7, write5m: 4e-6, write1h: 6e-6, output: 1.5e-5, context: 1000000 }, at: 12345 } };
  const out = priceFor("claude-opus-5-5", fetched);
  assert.deepStrictEqual(out, { slug: "anthropic/claude-opus-5.5", prices: fetched["anthropic/claude-opus-5.5"].prices, source: "fetched", at: 12345 });
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

// --- left() -----------------------------------------------------------

test("left: exactly on a table point, and flat past both ends", () => {
  // LEFT_TABLE's first/last points, from calibrate.py --lengths.
  assert.strictEqual(left(20), LEFT_TABLE[0][1]);
  closeTo(left(20), 105, "left(20)");
  assert.strictEqual(left(5), left(20), "below the first point is flat");
  closeTo(left(5), 105, "left(5)");
  assert.strictEqual(left(1000), LEFT_TABLE[LEFT_TABLE.length - 1][1], "past the last point is flat");
  closeTo(left(1000), 231, "left(1000)");
});

test("left: linear interpolation between two table points", () => {
  // Between (20, 105) and (40, 132): 105 + (132-105) * (30-20)/(40-20) = 118.5
  closeTo(left(30), 118.5, "left(30)");
});

test("left: capped at 10 once the prompt is >= 85% of the model's context, uncapped otherwise", () => {
  // calls=100 lands exactly on a table point (164), so any deviation from
  // 164 below is purely the compaction cap, not interpolation.
  closeTo(left(100, 870000, 1000000), 10, "870000/1000000 = 87% full -> capped at 10");
  closeTo(left(100, 800000, 1000000), 164, "80% full -> under the 85% line, uncapped");
  closeTo(left(100, 870000, null), 164, "no context given -> cap never applies");
});

// --- probNotNeeded() -----------------------------------------------------------

test("probNotNeeded: no verdict falls back to the calibration's base rate", () => {
  assert.strictEqual(probNotNeeded(null), CALIBRATION.baseRate);
  assert.strictEqual(probNotNeeded(undefined), CALIBRATION.baseRate);

  // An override calibration (as the planner's tests and Task 3 itself pass)
  // is used in place of the module's own CALIBRATION.
  const cal = { bins: [[1, 0.5]], baseRate: 0.42 };
  assert.strictEqual(probNotNeeded(null, cal), 0.42);
});

test("probNotNeeded: a raw score in bin k returns bin k's prob", () => {
  const cal = { bins: [[0.3, 0.1], [0.6, 0.4], [1, 0.9]] };
  assert.strictEqual(probNotNeeded({ notNeeded: 0.1 }, cal), 0.1, "below the first bin's upper");
  assert.strictEqual(probNotNeeded({ notNeeded: 0.3 }, cal), 0.1, "exactly on a bin's upper is inclusive");
  assert.strictEqual(probNotNeeded({ notNeeded: 0.45 }, cal), 0.4, "inside the second bin");
  assert.strictEqual(probNotNeeded({ notNeeded: 1 }, cal), 0.9, "the top bin");
});

test("probNotNeeded: CALIBRATION's own bins are within [0, 1] and non-decreasing in score", () => {
  let prev = -Infinity;
  for (const [upper, prob] of CALIBRATION.bins) {
    assert.ok(upper >= 0 && upper <= 1, `upper ${upper} in [0,1]`);
    assert.ok(prob >= 0 && prob <= 1, `prob ${prob} in [0,1]`);
    assert.ok(prob >= prev, `probs non-decreasing: ${prob} >= ${prev}`);
    prev = prob;
  }
  assert.strictEqual(CALIBRATION.bins[CALIBRATION.bins.length - 1][0], 1, "the top bin covers the rest of the range");
  assert.ok(CALIBRATION.baseRate >= 0 && CALIBRATION.baseRate <= 1);
});

// --- detailNode() -- the pill's hover card (payback spec §3) --------------

function findRow(children, label) {
  return children.find((c) => c.kind === "row" && c.label === label);
}

const OPUS_PRICES = { input: 4e-6, cacheRead: 2e-7, write5m: 5e-6, write1h: 8e-6, output: 2e-5, context: 1000000 };

/**
 * The design doc's own worked example (§3): saved/actual chosen so the
 * arithmetic lands exactly on its literal numbers --
 *   week:  41 / (41 + 130) = 0.2397... -> round -> 24% ; dollars = $41
 *   chat:  3.1 / (3.1 + 6.9) = 0.31 exactly -> 31% ; $3.10, 58 calls
 */
function baseView(now) {
  return {
    week: { saved: 41, actual: 130, dollars: 41, dollarsKnown: true, removedTokens: 3100000, cuts: 42, freeCuts: 31, skipped: 9, rereads: 6, rereadCost: 1.2 },
    chat: { saved: 3.1, actual: 6.9, calls: 58, billing: "api", usd: true, units: { saved: 0, actual: 0 }, model: "claude-opus-5-5" },
    prices: OPUS_PRICES,
    priceSource: "fetched",
    priceAt: now,
    judgeUp: true,
    plan: false,
  };
}

test("detailNode: the design doc's worked example, node for node", () => {
  const now = Date.now();
  const node = detailNode(baseView(now), now);

  assert.strictEqual(node.kind, "stack");
  assert.deepStrictEqual(node.children[0], { kind: "heading", content: "This week  −24% · $41 saved" });
  assert.deepStrictEqual(findRow(node.children, "This chat"), { kind: "row", label: "This chat", value: "−31% · $3.10 saved · 58 calls" });
  assert.deepStrictEqual(findRow(node.children, "Removed"), { kind: "row", label: "Removed", value: "3.1M tokens of old tool output" });
  assert.deepStrictEqual(findRow(node.children, "Cuts"), {
    kind: "row",
    label: "Cuts",
    value: "42 made · 31 free (after a pause) · 9 skipped (wouldn't pay back yet)",
  });
  assert.deepStrictEqual(findRow(node.children, "Re-reads"), { kind: "row", label: "Re-reads", value: "6, cost $1.20 (already subtracted)" });
  assert.deepStrictEqual(findRow(node.children, "Prices"), {
    kind: "row",
    label: "Prices",
    value: "Opus 5.5: $4/M input · cache read $0.20 · cache write $5",
  });
  const text = node.children.find((c) => c.kind === "text");
  assert.deepStrictEqual(text, { kind: "text", content: "updated today from openrouter.ai" });
  assert.deepStrictEqual(findRow(node.children, "Judge"), { kind: "row", label: "Judge", value: "on" });

  // No button/check/input/wibblet/detail anywhere in the card.
  for (const c of node.children) assert.ok(["heading", "row", "text"].includes(c.kind), c.kind);
});

test("detailNode: a plan-billed chat's dollar line reads an API-price estimate, not a saving", () => {
  const view = baseView(Date.now());
  view.chat = { ...view.chat, billing: "plan" };
  const node = detailNode(view, Date.now());
  assert.deepStrictEqual(findRow(node.children, "This chat"), {
    kind: "row",
    label: "This chat",
    value: "−31% · ≈ $3.10 at API prices · 58 calls",
  });
});

test("detailNode: a plan-billed chat that cost more says so, still as an API-price estimate", () => {
  const view = baseView(Date.now());
  view.chat = { ...view.chat, billing: "plan", saved: -view.chat.saved };
  const node = detailNode(view, Date.now());
  assert.match(findRow(node.children, "This chat").value, /≈ \$3\.10 more at API prices/);
});

test("detailNode: the week heading reads an API-price estimate when plan requests are the majority", () => {
  const view = baseView(Date.now());
  view.plan = true;
  const node = detailNode(view, Date.now());
  assert.deepStrictEqual(node.children[0], { kind: "heading", content: "This week  −24% · ≈ $41 at API prices" });
});

test("detailNode: no chat yet omits both the This chat row and the Prices row", () => {
  const view = baseView(Date.now());
  view.chat = null;
  view.prices = null;
  view.priceSource = null;
  view.priceAt = null;
  const node = detailNode(view, Date.now());

  assert.strictEqual(findRow(node.children, "This chat"), undefined);
  assert.strictEqual(findRow(node.children, "Prices"), undefined);
  assert.strictEqual(node.children.find((c) => c.kind === "text"), undefined);
  assert.deepStrictEqual(
    node.children.map((c) => c.label || c.kind),
    ["heading", "Removed", "Cuts", "Re-reads", "Judge"],
  );
});

test("detailNode: unknown prices name the model and drop the updated-text line", () => {
  const view = baseView(Date.now());
  view.prices = null;
  view.priceSource = null;
  view.priceAt = null;
  const node = detailNode(view, Date.now());

  assert.deepStrictEqual(findRow(node.children, "Prices"), { kind: "row", label: "Prices", value: "unknown for claude-opus-5-5, counting tokens" });
  assert.strictEqual(node.children.find((c) => c.kind === "text"), undefined);
});

test("detailNode: built-in prices read 'built-in prices', regardless of priceAt", () => {
  const view = baseView(Date.now() - 999 * 24 * 60 * 60 * 1000);
  view.priceSource = "built-in";
  const node = detailNode(view, Date.now());
  assert.deepStrictEqual(node.children.find((c) => c.kind === "text"), { kind: "text", content: "built-in prices" });
});

test("detailNode: a stale fetch reads 'updated N days ago', with no source named", () => {
  const now = Date.now();
  const view = baseView(now - 3 * 24 * 60 * 60 * 1000);
  const node = detailNode(view, now);
  assert.deepStrictEqual(node.children.find((c) => c.kind === "text"), { kind: "text", content: "updated 3 days ago" });
});

test("detailNode: the judge off reads the age-rule fallback", () => {
  const view = baseView(Date.now());
  view.judgeUp = false;
  const node = detailNode(view, Date.now());
  assert.deepStrictEqual(findRow(node.children, "Judge"), { kind: "row", label: "Judge", value: "off — using the age rule" });
});

test("detailNode: a chat with unknown dollars falls back to units, the same way the chip does", () => {
  const view = baseView(Date.now());
  view.chat = { saved: 0, actual: 0, calls: 12, billing: "api", usd: false, units: { saved: 500000, actual: 1500000 }, model: "claude-opus-5-5" };
  const node = detailNode(view, Date.now());
  assert.deepStrictEqual(findRow(node.children, "This chat"), { kind: "row", label: "This chat", value: "−25% · 500K units saved · 12 calls" });
});

test("detailNode: model display names -- GPT family, and the fallback to the slug after '/'", () => {
  const now = Date.now();
  let view = baseView(now);
  view.chat = { ...view.chat, model: "gpt-5.5" };
  view.prices = { input: 5e-6, cacheRead: 5e-7, write5m: 5e-6, write1h: 5e-6, output: 3e-5, context: 1050000 };
  let node = detailNode(view, now);
  assert.strictEqual(findRow(node.children, "Prices").value, "GPT-5.5: $5/M input · cache read $0.50 · cache write $5");

  view = baseView(now);
  view.chat = { ...view.chat, model: "deepseek/deepseek-v3" };
  view.prices = { input: 2.7e-7, cacheRead: 2.7e-8, write5m: 2.7e-7, write1h: 2.7e-7, output: 1.1e-6, context: 128000 };
  node = detailNode(view, now);
  assert.strictEqual(findRow(node.children, "Prices").value, "deepseek-v3: $0.27/M input · cache read $0.03 · cache write $0.27");
});
