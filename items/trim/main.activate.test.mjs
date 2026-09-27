// trim/main.activate.test.mjs — run with `node --test items/trim/main.activate.test.mjs`.
//
// The pure rule/saving functions have their own tests in main.test.mjs.
// This file drives Task 2's wiring -- the judge client, the drop release,
// the savings totals and the top-slot pill -- through activate() itself,
// with a fake `wibble` object standing in for the host. No real network,
// no real storage, no real panel: `net.fetch`, `storage` and `panel.set`
// are all in-memory fakes each test configures for its own scenario.
//
// One thing genuinely waits on the real clock: the panel redraw is
// throttled to at most once a second (see main.js's scheduleDraw), and the
// "panel shows a percent" tests want to see a SECOND draw shortly after
// the first (activate()'s own initial paint). That test waits out the
// throttle window for real, rather than faking timers, because the thing
// being tested is that the throttle's trailing edge actually fires.
//
// The health-probe-cooldown test is the opposite case: it uses Node's
// built-in `t.mock.timers` (an injectable clock, not a real 60s wait) to
// prove the cooldown is anchored to the moment of the failure, not to a
// fixed schedule -- see that test's own comments for why setImmediate,
// specifically, is left real rather than mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { activate, JUDGE_QUESTION, NOT_NEEDED_P } from "./main.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A fake `wibble` for activate(). `judge` configures how the fake judge
 * host answers:
 *   - `judge.health`: "up" (200) or "down" (500) for GET /health.
 *   - `judge.ask`: "up" (200 with `judge.notNeeded`), "down" (500), or
 *     "reject" (net.fetch throws, as a real connection failure would).
 */
function makeWibble(judge = {}) {
  const health = judge.health || "up";
  const askMode = judge.ask || "up";
  const notNeeded = judge.notNeeded ?? 0.99;

  const seenHandlers = [];
  const resultHandlers = [];
  const dropCalls = [];
  const panelCalls = [];
  const store = new Map();

  const wibble = {
    trim: {
      onSeen(fn) {
        seenHandlers.push(fn);
        return () => {};
      },
      onResult(fn) {
        resultHandlers.push(fn);
        return () => {};
      },
      async drop(sessionId, ids) {
        dropCalls.push({ sessionId, ids });
      },
    },
    net: {
      async fetch(url) {
        if (url.endsWith("/health")) {
          if (health === "up") return { status: 200, headers: {}, body: JSON.stringify({ ok: true, model: "test" }) };
          return { status: 500, headers: {}, body: "" };
        }
        if (url.endsWith("/v1/systemone")) {
          if (askMode === "reject") throw new Error("connection refused");
          if (askMode === "down") return { status: 500, headers: {}, body: "" };
          // The judge answers P(still needed); main.js inverts it.
          return { status: 200, headers: {}, body: JSON.stringify({ answers: { stale: { noul: 1 - notNeeded } } }) };
        }
        throw new Error("unexpected fetch: " + url);
      },
    },
    storage: {
      async get(key) {
        return store.get(key);
      },
      async set(key, value) {
        store.set(key, value);
      },
      keys: async () => [...store.keys()],
      onChange: () => () => {},
    },
    panel: {
      async set(title, node) {
        panelCalls.push({ title, node });
      },
    },
  };

  return {
    wibble,
    fireSeen: (payload) => seenHandlers.forEach((fn) => fn(payload)),
    fireResult: (payload) => resultHandlers.forEach((fn) => fn(payload)),
    dropCalls,
    panelCalls,
  };
}

function seenEvent(overrides) {
  return {
    owner: "o",
    sessionId: "s1",
    format: "anthropic",
    thread: "t1",
    model: "claude-sonnet-5",
    totalChars: 100000,
    lastUser: "do the thing",
    recentAssistant: "working on it",
    ...overrides,
  };
}

// --- guard: no wibble.trim (older Wibble) -----------------------------

test("activate: no wibble.trim renders the needs-a-newer-Wibble chip and does nothing else", async () => {
  const panelCalls = [];
  const wibble = {
    panel: { async set(title, node) { panelCalls.push({ title, node }); } },
    // No trim, no net, no storage -- activate() must not touch any of
    // them, so leaving them undefined is itself part of the assertion:
    // touching wibble.storage.get() here would throw "not a function".
  };

  await activate(wibble);

  assert.strictEqual(panelCalls.length, 1);
  assert.deepStrictEqual(panelCalls[0], { title: "Trim", node: { kind: "chip", label: "Trim needs a newer Wibble" } });
});

// --- 25 seen events -> one drop call with the aged ids -----------------

test("activate: 25 seen events for one aged item release exactly once, with the aged id", async () => {
  // Judge down from the start (health fails), so this is a clean test of
  // track()/release()/drop() wiring alone: every aged item is dropped by
  // the fallback rule, with no judge race to also account for.
  const h = makeWibble({ health: "down" });
  await activate(h.wibble);

  for (let call = 1; call <= 25; call++) {
    h.fireSeen(
      seenEvent({
        calls: call,
        items: [{ id: "item1", tool: "Read", target: "f.txt", chars: 500, age: call, head: "hello" }],
      }),
    );
  }
  await wait(20); // let any in-flight (rejected) judge probes settle

  assert.strictEqual(h.dropCalls.length, 1, "release fires exactly once across 25 calls");
  assert.deepStrictEqual(h.dropCalls[0], { sessionId: "s1", ids: ["item1"] });
});

// --- judge answer notNeeded 0.2 keeps an item ---------------------------

test("activate: a judge verdict of notNeeded 0.2 keeps the item (no drop)", async () => {
  const h = makeWibble({ health: "up", ask: "up", notNeeded: 0.2 });
  await activate(h.wibble);

  for (let call = 1; call <= 6; call++) {
    h.fireSeen(
      seenEvent({
        calls: call,
        items: [{ id: "item1", tool: "Read", target: "f.txt", chars: 500, age: call, head: "hello" }],
      }),
    );
  }
  // Let the judge's (fake, immediate) answer land before the batch fires.
  await wait(20);

  for (let call = 7; call <= 20; call++) {
    h.fireSeen(
      seenEvent({
        calls: call,
        items: [{ id: "item1", tool: "Read", target: "f.txt", chars: 500, age: call, head: "hello" }],
      }),
    );
  }
  await wait(20);

  assert.strictEqual(h.dropCalls.length, 0, "the only item was judged needed (0.2 < NOT_NEEDED_P), so nothing is dropped");
});

// --- the judge is asked the positive question, and its answer inverted --

test("activate: the judge is asked whether the item is still NEEDED, and a high answer keeps it", async () => {
  // Task 3 measured the negative wording ("how likely it is NOT needed")
  // running hot toward "not needed". The question must be the positive
  // one, and noul must be read as P(needed): 0.95 here means keep.
  assert.ok(!/\bNOT\b/.test(JUDGE_QUESTION), "the question is asked in positive polarity");
  assert.ok(0.05 < NOT_NEEDED_P, "sanity: 1 - 0.95 is below the cut line");

  const seenHandlers = [];
  const dropCalls = [];
  const asked = [];
  const wibble = {
    trim: {
      onSeen(fn) {
        seenHandlers.push(fn);
        return () => {};
      },
      onResult: () => () => {},
      async drop(sessionId, ids) {
        dropCalls.push({ sessionId, ids });
      },
    },
    net: {
      async fetch(url, opts) {
        if (url.endsWith("/health")) return { status: 200, headers: {}, body: "{}" };
        const body = JSON.parse(opts.body);
        asked.push(body);
        return { status: 200, headers: {}, body: JSON.stringify({ answers: { stale: { noul: 0.95 } } }) };
      },
    },
    storage: { get: async () => undefined, set: async () => {}, keys: async () => [], onChange: () => () => {} },
    panel: { async set() {} },
  };
  await activate(wibble);

  for (let call = 1; call <= 20; call++) {
    seenHandlers.forEach((fn) =>
      fn(seenEvent({ calls: call, items: [{ id: "item1", tool: "Read", target: "f.txt", chars: 500, age: call, head: "hello" }] })),
    );
    if (call === 6) await wait(20); // let the verdict land before the batch
  }
  await wait(20);

  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual(asked[0].questions, { stale: { type: "noul", instructions: JUDGE_QUESTION } });
  assert.strictEqual(dropCalls.length, 0, "P(needed) 0.95 -> notNeeded 0.05 -> kept");
});

// --- judge fetch rejects -> judge marked down and fallback still drops --

test("activate: a rejected judge fetch marks the judge down, and the fallback still drops the item", async () => {
  const h = makeWibble({ health: "up", ask: "reject" });
  await activate(h.wibble);

  for (let call = 1; call <= 6; call++) {
    h.fireSeen(
      seenEvent({
        calls: call,
        items: [{ id: "item1", tool: "Read", target: "f.txt", chars: 500, age: call, head: "hello" }],
      }),
    );
  }
  await wait(20); // let the rejected ask() land and mark the judge down

  for (let call = 7; call <= 20; call++) {
    h.fireSeen(
      seenEvent({
        calls: call,
        items: [{ id: "item1", tool: "Read", target: "f.txt", chars: 500, age: call, head: "hello" }],
      }),
    );
  }
  await wait(20);

  assert.strictEqual(h.dropCalls.length, 1, "the fallback drops the item even though the judge never answered");
  assert.deepStrictEqual(h.dropCalls[0], { sessionId: "s1", ids: ["item1"] });

  // Observable proof the judge is marked down: once there are savings to
  // show, the panel's pill carries the "age rule" note.
  h.fireResult({
    sessionId: "s1",
    thread: "t1",
    model: "claude-sonnet-5",
    usage: { input: 0, cacheRead: 150000000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
    totalChars: 150000000,
    removedChars: 150000000,
    firstCutChars: null,
    newlyRemoved: 1,
  });
  await wait(1100); // the panel redraw throttle's trailing edge (1/s)

  const last = h.panelCalls[h.panelCalls.length - 1].node;
  assert.strictEqual(last.kind, "stack");
  const ruleText = last.children.find((c) => c.kind === "text" && c.content === "age rule");
  assert.ok(ruleText, "panel shows the age-rule note while the judge is down");
});

// --- panel label shows a percent after results --------------------------

test("activate: the panel shows a percent chip and a dollar label after an onResult", async () => {
  const h = makeWibble({ health: "up" });
  await activate(h.wibble);

  // Chosen so the arithmetic is exact and legible:
  //   promptTokens = cacheRead = 150,000,000; totalChars = 150,000,000 -> r = 1
  //   unitPrice = 0.1 (cacheRead > 0); gross = removedChars * 1 * 0.1 = 15,000,000
  //   saved = 15,000,000; actual = cost(usage) = cacheRead * 0.1 = 15,000,000
  //   percent = 15,000,000 / 30,000,000 = 0.5 -> "−50%"
  //   dollars(15,000,000, "claude-sonnet-5") = 15,000,000 * 3 / 1e6 = $45
  h.fireResult({
    sessionId: "s1",
    thread: "t1",
    model: "claude-sonnet-5",
    usage: { input: 0, cacheRead: 150000000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
    totalChars: 150000000,
    removedChars: 150000000,
    firstCutChars: null,
    newlyRemoved: 1,
  });
  await wait(1100); // panel redraw throttle's trailing edge (1/s)

  const last = h.panelCalls[h.panelCalls.length - 1].node;
  assert.strictEqual(last.kind, "stack");
  const chip = last.children.find((c) => c.kind === "chip");
  const text = last.children.find((c) => c.kind === "text");
  assert.strictEqual(chip.label, "−50%");
  assert.strictEqual(text.content, "$45 saved this week");
  assert.ok(!last.children.some((c) => c.content === "age rule"), "judge is up, so no age-rule note");
});

// --- persistence: totals actually survive a reload via storage ---------

test("activate: totals are written to storage, and a second activate() against the same storage reads them back", async () => {
  const h = makeWibble({ health: "up" });
  await activate(h.wibble);

  h.fireResult({
    sessionId: "s1",
    thread: "t1",
    model: "claude-sonnet-5",
    usage: { input: 0, cacheRead: 150000000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
    totalChars: 150000000,
    removedChars: 150000000,
    firstCutChars: null,
    newlyRemoved: 1,
  });

  // schedulePersist()'s leading edge fires immediately the first time
  // (lastPersistAt starts at 0), so this does not need to wait 5 s.
  await wait(20);

  const stored = await h.wibble.storage.get("totals");
  assert.ok(stored && Object.keys(stored).length === 1, "one day's totals were written to storage");
  const day = Object.values(stored)[0];
  assert.strictEqual(day.saved, 15000000);
  assert.strictEqual(day.actual, 15000000);

  // The actual reload: a fresh activate() call, simulating a relaunch,
  // against the SAME wibble (so the same storage.get("totals") the first
  // activate() wrote to). Its own initial paint (unthrottled, since this
  // second call's own lastDrawAt starts at 0) proves the totals it read
  // back are the ones the first activate() persisted -- not just that
  // storage.set() was called with the right value.
  await activate(h.wibble);
  await wait(20); // let its fire-and-forget initial scheduleDraw() land

  const last = h.panelCalls[h.panelCalls.length - 1].node;
  assert.strictEqual(last.kind, "stack", "the reloaded activate() painted a real pill, not the empty chip");
  const chip = last.children.find((c) => c.kind === "chip");
  const text = last.children.find((c) => c.kind === "text");
  assert.strictEqual(chip.label, "−50%", "percent reloaded from storage, not recomputed from a fresh (empty) totals");
  assert.strictEqual(text.content, "$45 saved this week");
});

// --- queue: cap 200 (drop oldest), newest-thread-first ordering ---------

test("activate: the judge queue is capped at 200 (drop oldest) and drains newest-thread-first", async () => {
  // A dedicated fake, not makeWibble(): this test needs to see the ORDER
  // and COUNT of judge asks, not just their outcome, so net.fetch records
  // each /v1/systemone request's target (which encodes the item id) as it
  // is made.
  const seenHandlers = [];
  const askOrder = [];

  const wibble = {
    trim: {
      onSeen(fn) {
        seenHandlers.push(fn);
        return () => {};
      },
      onResult() {
        return () => {};
      },
      async drop() {},
    },
    net: {
      async fetch(url, opts) {
        if (url.endsWith("/health")) {
          return { status: 200, headers: {}, body: JSON.stringify({ ok: true, model: "test" }) };
        }
        if (url.endsWith("/v1/systemone")) {
          // The item's target is "item-<id>" -- pull the id back out of
          // the state text's "Tool output under question:\n<tool> <target>"
          // line rather than threading extra plumbing through ask().
          const { state } = JSON.parse(opts.body);
          const match = state.match(/Tool output under question:\nRead item-(\S+)\n/);
          askOrder.push(match[1]);
          // Answer "needed" (kept, not dropped) for everything asked, so
          // the only ids release() would drop are ones that were CAPPED
          // out of the queue and never asked at all.
          return { status: 200, headers: {}, body: JSON.stringify({ answers: { stale: { noul: 0.8 } } }) }; // P(needed) 0.8
        }
        throw new Error("unexpected fetch: " + url);
      },
    },
    storage: { get: async () => undefined, set: async () => {}, keys: async () => [], onChange: () => () => {} },
    panel: { async set() {} },
  };

  await activate(wibble);

  // Thread A: 200 items in ONE onSeen report -- exactly fills the queue's
  // cap, so none of these would be dropped by the cap on their own.
  const itemsA = [];
  for (let i = 0; i < 200; i++) {
    itemsA.push({ id: "A" + i, tool: "Read", target: "item-A" + i, chars: 10, age: 10, head: "h" });
  }
  seenHandlers.forEach((fn) => fn(seenEvent({ sessionId: "s1", thread: "tA", calls: 1, items: itemsA })));

  // pump() is idle when A's batch lands, so its very first loop iteration
  // -- shift A0, call ask(A0) -- runs SYNCHRONOUSLY as part of this same
  // onSeen() call: only the *await* inside ask() (on net.fetch's already-
  // resolved promise) actually yields to a microtask, and that happens
  // one shift too late to stop A0 leaving the queue first. So by the time
  // this line returns, A0 is already in flight (removed from `queue`,
  // not subject to the cap below) and A1..A199 (199 items) remain queued.

  // Thread B: 10 more items, from a DIFFERENT (newer) thread, still in
  // the same synchronous turn -- nothing YIELDS between A's enqueue and
  // this one, so B's unshift and the cap's pop() below both still see
  // the queue exactly as A left it (A1..A199), not whatever pump() will
  // eventually do with them.
  const itemsB = [];
  for (let i = 0; i < 10; i++) {
    itemsB.push({ id: "B" + i, tool: "Read", target: "item-B" + i, chars: 10, age: 10, head: "h" });
  }
  seenHandlers.forEach((fn) => fn(seenEvent({ sessionId: "s2", thread: "tB", calls: 1, items: itemsB })));
  // Queue is now [B0..B9, A1..A199] = 209 -- over the 200 cap by 9, so
  // enqueueForJudge's pop() drops the 9 at the tail: A191..A199.

  // Let pump() drain the rest for real.
  await wait(100);

  // 201 asked in total: A0 (already in flight before B ever arrived) +
  // the 200 that survived the cap (B0..B9, A1..A190). 9 were capped out
  // (210 offered - 201 asked = 9), and per the trace above they must be
  // A191..A199, the tail-most items of A's batch once B's landed in front.
  assert.strictEqual(askOrder.length, 201, "210 were offered; 9 capped out, 201 actually asked");
  assert.strictEqual(askOrder[0], "A0", "A0 was already in flight, synchronously, before B's batch was even enqueued");

  // Newest-thread-first: once A0 (already in flight) is set aside, thread
  // B's whole batch -- enqueued after A's -- is asked before any of the
  // rest of A's.
  assert.deepStrictEqual(
    askOrder.slice(1, 11),
    itemsB.map((it) => it.id), // ["B0", ..., "B9"], in the order they were reported
    "thread B's items are asked next, in their own relative order, ahead of the rest of thread A's",
  );

  // Drop oldest: A1..A190 (190 items) were asked; A191..A199 (9 items)
  // were capped out and never asked at all -- the ones furthest from the
  // front once B's batch was unshifted ahead of them.
  const askedFromA = new Set(askOrder.filter((id) => id.startsWith("A")));
  assert.strictEqual(askedFromA.size, 191, "A0 plus A1..A190");
  for (let i = 0; i < 191; i++) assert.ok(askedFromA.has("A" + i), "A" + i + " should have been asked");
  for (let i = 191; i < 200; i++) assert.ok(!askedFromA.has("A" + i), "A" + i + " should have been capped out (dropped oldest)");
});

// --- health probe cooldown is anchored to the failure, not a schedule ---

test("activate: a judge failure re-arms a fresh 60s health-probe window from the failure itself", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  // setImmediate is NOT in the mocked apis list, so it still runs on the
  // real event loop -- used here purely to flush pending microtasks
  // (the rejected ask() promise, markDown(), etc.) after each tick().
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const seenHandlers = [];
  let healthCalls = 0;
  let askCalls = 0;

  const wibble = {
    trim: {
      onSeen(fn) {
        seenHandlers.push(fn);
        return () => {};
      },
      onResult() {
        return () => {};
      },
      async drop() {},
    },
    net: {
      async fetch(url) {
        if (url.endsWith("/health")) {
          healthCalls++;
          return { status: 200, headers: {}, body: JSON.stringify({ ok: true, model: "test" }) };
        }
        if (url.endsWith("/v1/systemone")) {
          askCalls++;
          throw new Error("connection refused"); // always fails, to keep the judge down
        }
        throw new Error("unexpected fetch: " + url);
      },
    },
    storage: { get: async () => undefined, set: async () => {}, keys: async () => [], onChange: () => () => {} },
    panel: { async set() {} },
  };

  await activate(wibble); // the on-start probe succeeds: judge starts up
  assert.strictEqual(healthCalls, 1);

  // 40s pass with nothing having failed yet. Under the old free-running
  // setInterval this alone was irrelevant either way (it only probed
  // while judgeUp was false) -- but it establishes a non-zero clock
  // baseline before the failure, so the assertions below are actually
  // checking "60s from the failure" and not "60s from t=0".
  t.mock.timers.tick(40000);
  await flush();
  assert.strictEqual(healthCalls, 1, "no probe fires before anything has failed");

  // The judge fails now, at t=40s.
  seenHandlers.forEach((fn) =>
    fn(
      seenEvent({
        sessionId: "s1",
        thread: "t1",
        calls: 6,
        items: [{ id: "item1", tool: "Read", target: "f.txt", chars: 10, age: 6, head: "h" }],
      }),
    ),
  );
  await flush(); // let the rejected ask() land and call markDown()
  assert.strictEqual(askCalls, 1, "the ask actually happened and failed");

  // 59s after the failure (t=99s): the fresh window anchored to the
  // failure has not yet elapsed, so still no probe.
  t.mock.timers.tick(59000);
  await flush();
  assert.strictEqual(healthCalls, 1, "still no probe -- only 59s of the 60s anchored to the failure has passed");

  // 1s more (t=100s, exactly 60s after the failure): the probe fires.
  t.mock.timers.tick(1000);
  await flush();
  assert.strictEqual(healthCalls, 2, "the probe fires 60s after the failure itself, not on a stale fixed schedule");
});
