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
import { activate, JUDGE_QUESTION, v1Line } from "./main.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A fake `wibble` for activate(). `judge` configures how the fake judge
 * host answers:
 *   - `judge.health`: "up" (200) or "down" (500) for GET /health.
 *   - `judge.ask`: "up" (200 with `judge.notNeeded`), "down" (500), or
 *     "reject" (net.fetch throws, as a real connection failure would).
 * `host` configures the rest:
 *   - `host.openrouter(url, opts)`: the answer to an openrouter.ai fetch
 *     (default a 404, so every model runs on the built-in table or none).
 *   - `host.cold`: true gives `trim.withdraw`, i.e. a Wibble that knows
 *     cold drops; `drop` records its third argument either way.
 *   - `host.store`: storage's starting contents, as an object.
 */
function makeWibble(judge = {}, host = {}) {
  const health = judge.health || "up";
  const askMode = judge.ask || "up";
  const notNeeded = judge.notNeeded ?? 0.99;

  const seenHandlers = [];
  const resultHandlers = [];
  const dropCalls = [];
  const panelCalls = [];
  const withdrawCalls = [];
  const priceFetches = [];
  const store = new Map(Object.entries(host.store || {}));

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
      async drop(sessionId, ids, opts) {
        dropCalls.push(opts ? { sessionId, ids, opts } : { sessionId, ids });
      },
    },
    net: {
      async fetch(url, opts) {
        if (url.startsWith("https://openrouter.ai/")) {
          priceFetches.push({ url, opts });
          return host.openrouter ? host.openrouter(url, opts) : { status: 404, headers: {}, body: "" };
        }
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

  if (host.cold) {
    wibble.trim.withdraw = async (sessionId, ids) => {
      withdrawCalls.push({ sessionId, ids });
    };
  }

  return {
    wibble,
    fireSeen: (payload) => seenHandlers.forEach((fn) => fn(payload)),
    fireResult: (payload) => resultHandlers.forEach((fn) => fn(payload)),
    dropCalls,
    withdrawCalls,
    priceFetches,
    panelCalls,
    store,
  };
}

function seenEvent(overrides) {
  return {
    owner: "o",
    sessionId: "s1",
    format: "anthropic",
    thread: "t1",
    // No built-in price (and the fake's openrouter.ai answers 404), so
    // plan() runs v1's rule: the tests below that don't name a model are
    // v1's wiring tests.
    model: "claude-sonnet-4",
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

  assert.strictEqual(h.dropCalls.length, 0, "the only item was judged needed (0.2 < the cut line), so nothing is dropped");
});

// --- the judge is asked the positive question, and its answer inverted --

test("activate: the judge is asked whether the item is still NEEDED, and a high answer keeps it", async () => {
  // Task 3 measured the negative wording ("how likely it is NOT needed")
  // running hot toward "not needed". The question must be the positive
  // one, and noul must be read as P(needed): 0.95 here means keep.
  assert.ok(!/\bNOT\b/.test(JUDGE_QUESTION), "the question is asked in positive polarity");
  assert.ok(0.05 < v1Line(20), "sanity: 1 - 0.95 is below the cut line");

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

  // The judge being down doesn't stop the pill: savings still show.
  h.fireResult({
    sessionId: "s1",
    thread: "t1",
    model: "claude-sonnet-4",
    usage: { input: 0, cacheRead: 150000000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
    totalChars: 150000000,
    removedChars: 150000000,
    firstCutChars: null,
    newlyRemoved: 1,
  });
  await wait(1100); // the panel redraw throttle's trailing edge (1/s)

  const last = h.panelCalls[h.panelCalls.length - 1].node;
  assert.strictEqual(last.kind, "chip");
  assert.match(last.label, /^[−+]\d+% · /, "the pill shows a saving while the judge is down");
});

// --- panel label shows a percent after results --------------------------

test("activate: with no prices for the model, the panel shows v1's percent and family dollars after an onResult", async () => {
  const h = makeWibble({ health: "up" });
  await activate(h.wibble);

  // Chosen so the arithmetic is exact and legible:
  //   promptTokens = cacheRead = 150,000,000; totalChars = 150,000,000 -> r = 1
  //   unitPrice = 0.1 (cacheRead > 0); gross = removedChars * 1 * 0.1 = 15,000,000
  //   saved = 15,000,000; actual = cost(usage) = cacheRead * 0.1 = 15,000,000
  //   percent = 15,000,000 / 30,000,000 = 0.5 -> "−50%"
  //   dollars(15,000,000, "claude-sonnet-4") = 15,000,000 * 3 / 1e6 = $45
  h.fireResult({
    sessionId: "s1",
    thread: "t1",
    model: "claude-sonnet-4",
    usage: { input: 0, cacheRead: 150000000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
    totalChars: 150000000,
    removedChars: 150000000,
    firstCutChars: null,
    newlyRemoved: 1,
  });
  await wait(1100); // panel redraw throttle's trailing edge (1/s)

  const last = h.panelCalls[h.panelCalls.length - 1].node;
  assert.strictEqual(last.kind, "chip");
  assert.strictEqual(last.label, "−50% · $45 saved");
});

// --- persistence: totals actually survive a reload via storage ---------

test("activate: totals are written to storage, and a second activate() against the same storage reads them back", async () => {
  const h = makeWibble({ health: "up" });
  await activate(h.wibble);

  h.fireResult({
    sessionId: "s1",
    thread: "t1",
    model: "claude-sonnet-4",
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
  assert.strictEqual(last.label, "−50% · $45 saved", "the reloaded activate() painted the stored week, not the empty chip");
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

// --- threads idle past 2 h are forgotten ---------------------------------

test("activate: a thread idle over 2 h is forgotten (it starts over), a recently seen one is not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve)); // setImmediate stays real, as below
  const HOUR = 60 * 60 * 1000;

  const h = makeWibble();
  await activate(h.wibble);
  const aged = (thread, calls) =>
    seenEvent({ thread, calls, items: [{ id: thread + "-x", tool: "Read", target: thread + ".txt", chars: 500, age: 6 }] });

  // t=0: both threads reach their first batch and drop their aged item.
  h.fireSeen(aged("A", 20));
  h.fireSeen(aged("C", 20));
  await flush();
  assert.strictEqual(h.dropCalls.length, 2);

  // t=1h: only C is seen again.
  t.mock.timers.tick(HOUR);
  h.fireSeen(aged("C", 21));
  // t=2h02m: another thread's report runs the idle sweep. A has been idle
  // 2h02m (gone); C 1h02m (kept).
  t.mock.timers.tick(HOUR + 2 * 60 * 1000);
  h.fireSeen(seenEvent({ thread: "B", calls: 1, items: [] }));
  await flush();

  // A comes back at 26 calls: forgotten, so it's a new thread whose first
  // batch is due at once, and its item is dropped again. C at 26 calls is
  // only 6 past its last batch, so nothing happens.
  h.fireSeen(aged("A", 26));
  h.fireSeen(aged("C", 26));
  await flush();
  assert.strictEqual(h.dropCalls.length, 3);
  assert.deepStrictEqual(h.dropCalls[2].ids, ["A-x"]);
});

// --- a failed drop is offered again at the next batch -------------------

test("activate: a drop that fails is released again at the next batch", async () => {
  const h = makeWibble({ health: "down" });
  let fail = true;
  h.wibble.trim.drop = async (sessionId, ids) => {
    h.dropCalls.push({ sessionId, ids });
    if (fail) {
      fail = false;
      throw new Error("session ended");
    }
  };
  await activate(h.wibble);

  const item = (age) => [{ id: "x", tool: "Read", target: "f.txt", chars: 500, age }];
  h.fireSeen(seenEvent({ calls: 20, items: item(6) }));
  await wait(10);
  h.fireSeen(seenEvent({ calls: 40, items: item(26) }));
  await wait(10);

  assert.deepStrictEqual(
    h.dropCalls.map((c) => c.ids),
    [["x"], ["x"]],
  );
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

// --- prices: fetched from openrouter.ai, kept in storage -----------------

const OPUS_SLUG = "anthropic/claude-opus-5.5";
const OPUS_URL = "https://openrouter.ai/api/v1/models/anthropic/claude-opus-5.5/endpoints";

/** An OpenRouter endpoints body: Anthropic's endpoint at cache read $0.10/M. */
function endpointsBody() {
  return JSON.stringify({
    data: {
      endpoints: [
        {
          provider_name: "Anthropic",
          context_length: 1000000,
          pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000001", input_cache_write: "0.000004", input_cache_write_1h: "0.000006" },
        },
      ],
    },
  });
}

/** A warm request that reads 100M tokens from cache and removed as many chars (r = 1). */
function opusResult(overrides) {
  return {
    sessionId: "s1",
    thread: "t1",
    model: "claude-opus-5-5",
    usage: { input: 0, cacheRead: 100000000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
    sentChars: 100000000,
    totalChars: 100000000,
    removedChars: 100000000,
    firstCutChars: null,
    newlyRemoved: 0,
    ...overrides,
  };
}

test("activate: a model's prices are fetched once (a GET with nothing but the slug), stored, and used to charge", async () => {
  const h = makeWibble({ health: "up" }, { openrouter: () => ({ status: 200, headers: {}, body: endpointsBody() }) });
  await activate(h.wibble);

  // Two reports in one turn: the first fetch is still in flight for the second.
  h.fireSeen(seenEvent({ model: "claude-opus-5-5", calls: 1, items: [] }));
  h.fireSeen(seenEvent({ model: "claude-opus-5-5", calls: 2, items: [] }));
  assert.deepStrictEqual(h.priceFetches, [{ url: OPUS_URL, opts: { method: "GET" } }]);
  await wait(20);

  const stored = h.store.get("prices");
  assert.strictEqual(stored[OPUS_SLUG].prices.cacheRead, 1e-7);
  assert.strictEqual(typeof stored[OPUS_SLUG].at, "number");

  // Fresh now: no second fetch.
  h.fireSeen(seenEvent({ model: "claude-opus-5-5", calls: 3, items: [] }));
  await wait(20);
  assert.strictEqual(h.priceFetches.length, 1);

  // Charged at the fetched cache read ($0.10/M), not the built-in $0.20/M:
  //   saved = 1e8 * 1 * 1e-7 = $10; actual = 1e8 * 1e-7 = $10 -> −50%
  h.fireResult(opusResult());
  await wait(1100);
  assert.strictEqual(h.panelCalls[h.panelCalls.length - 1].node.label, "−50% · $10 saved");
});

test("activate: a failed price fetch stores nothing and is not retried for an hour", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const h = makeWibble({ health: "up" }); // openrouter.ai answers 404
  await activate(h.wibble);

  h.fireSeen(seenEvent({ model: "claude-opus-5-5", calls: 1, items: [] }));
  await flush();
  assert.strictEqual(h.priceFetches.length, 1);
  assert.strictEqual(h.store.get("prices"), undefined);

  t.mock.timers.tick(59 * 60 * 1000);
  h.fireSeen(seenEvent({ model: "claude-opus-5-5", calls: 2, items: [] }));
  await flush();
  assert.strictEqual(h.priceFetches.length, 1, "59 minutes after the failure: not yet");

  t.mock.timers.tick(60 * 1000);
  h.fireSeen(seenEvent({ model: "claude-opus-5-5", calls: 3, items: [] }));
  await flush();
  assert.strictEqual(h.priceFetches.length, 2, "an hour after the failure: tried again");
});

test("activate: stored prices are loaded on start, and fetched again once they are a day old", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const prices = { input: 3e-6, cacheRead: 1e-7, write5m: 4e-6, write1h: 6e-6, output: 1.5e-5, context: 1000000 };
  const h = makeWibble({ health: "up" }, { store: { prices: { [OPUS_SLUG]: { prices, at: Date.now() } } } });
  await activate(h.wibble);

  h.fireSeen(seenEvent({ model: "claude-opus-5-5", calls: 1, items: [] }));
  await flush();
  assert.strictEqual(h.priceFetches.length, 0, "the stored copy is fresh");

  // Charged at the stored cache read: $10 saved of $10 (see the test above).
  h.fireResult(opusResult());
  t.mock.timers.tick(5000); // the mocked clock starts at 0, inside the 5 s persist throttle
  await flush();
  const day = Object.values(h.store.get("totals"))[0];
  assert.ok(Math.abs(day.usd.saved - 10) < 1e-9 && Math.abs(day.usd.actual - 10) < 1e-9, JSON.stringify(day.usd));

  t.mock.timers.tick(24 * 60 * 60 * 1000 + 1);
  h.fireSeen(seenEvent({ model: "claude-opus-5-5", calls: 2, items: [] }));
  await flush();
  assert.strictEqual(h.priceFetches.length, 1, "a day old: fetched again");
});

// --- dollars in the day totals, and the chip -----------------------------

test("activate: a priced result shows the week in dollars, and the day keeps dollars and v1 units", async () => {
  const h = makeWibble({ health: "up" });
  await activate(h.wibble);

  // Built-in Opus 5.5 (cache read $0.20/M): saved = 1e8 * 2e-7 = $20 of $20 actual.
  h.fireResult(opusResult());
  await wait(1100);
  assert.strictEqual(h.panelCalls[h.panelCalls.length - 1].node.label, "−50% · $20 saved");

  const day = Object.values(h.store.get("totals"))[0];
  assert.ok(Math.abs(day.usd.saved - 20) < 1e-9);
  assert.ok(Math.abs(day.usd.actual - 20) < 1e-9);
  // v1 units alongside: saved = 1e8 * 0.1 = 1e7, actual = 1e8 * 0.1 = 1e7
  assert.strictEqual(day.saved, 1e7);
  assert.strictEqual(day.actual, 1e7);
});

test("activate: an old stored day without dollars loads with zeroed counters, and the week falls back to v1 units", async () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);
  const h = makeWibble({ health: "up" }, { store: { totals: { [yesterday]: { saved: 0, actual: 2e7, removedTokens: 0, dollars: 0, dollarsKnown: true } } } });
  await activate(h.wibble);

  // Today: v1 saved 1e7 of actual 1e7, $20 saved. Yesterday: 0 of 2e7 units.
  // v1 percent = 1e7 / (3e7 + 1e7) = 25% (dollars alone would read 50%).
  h.fireResult(opusResult());
  await wait(1100);
  assert.strictEqual(h.panelCalls[h.panelCalls.length - 1].node.label, "−25% · $20 saved");

  const old = h.store.get("totals")[yesterday];
  for (const k of ["cuts", "freeCuts", "skipped", "rereads", "rereadCost", "planActual", "apiActual"]) assert.strictEqual(old[k], 0, k);
  assert.deepStrictEqual(old.usd, { saved: 0, actual: 0 });
});

test("activate: cuts, free cuts on a cold request, and plan vs API billing are counted per day", async () => {
  const h = makeWibble({ health: "up" });
  await activate(h.wibble);

  h.fireSeen(seenEvent({ sessionId: "s1", model: "claude-opus-5-5", billing: "plan", calls: 1, items: [] }));
  h.fireResult(opusResult({ sessionId: "s1", cold: true, coldApplied: ["a", "b"], newlyRemoved: 3 }));
  h.fireResult(opusResult({ sessionId: "s1", cold: false, coldApplied: [], newlyRemoved: 2 }));
  h.fireResult(opusResult({ sessionId: "s2", newlyRemoved: 0 })); // never seen: billing unknown -> API
  await wait(20);

  const day = Object.values(h.store.get("totals"))[0];
  assert.strictEqual(day.freeCuts, 2, "the two cold drops applied");
  assert.strictEqual(day.cuts, 3, "one ordinary cut on the cold request, two on the warm one");
  // v1 units per request: 1e7 actual. Two on a plan, one on the API.
  assert.strictEqual(day.planActual, 2e7);
  assert.strictEqual(day.apiActual, 1e7);
});

test("activate: a re-read is counted, with its cost in dollars", async () => {
  const h = makeWibble({ health: "down" });
  await activate(h.wibble);

  // v1's rule (no price for claude-sonnet-4) drops f.txt at 20 calls ...
  h.fireSeen(seenEvent({ calls: 20, items: [{ id: "x", tool: "Read", target: "f.txt", chars: 500, age: 6 }] }));
  // ... and the agent reads it again.
  h.fireSeen(seenEvent({ calls: 21, items: [{ id: "y", tool: "Read", target: "f.txt", chars: 500, age: 0 }] }));
  // r = 1, P = 1e6: reread = 1e6 * 2e-7 + 500 * 1 * 5e-6 = 0.2 + 0.0025 = $0.2025
  h.fireResult(opusResult({ usage: { input: 0, cacheRead: 1000000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 }, sentChars: 1000000, totalChars: 1000000, removedChars: 0 }));
  await wait(20);

  const day = Object.values(h.store.get("totals"))[0];
  assert.strictEqual(day.rereads, 1);
  assert.ok(Math.abs(day.rereadCost - 0.2025) < 1e-9, String(day.rereadCost));
});

// --- cold drops and withdrawals ------------------------------------------

// Built-in Sonnet 5 (cache read $0.20/M, 5-minute write $2.50/M). One
// 20,000-char item at the very start of a 1,000,000-char prompt; r = 0.3
// (no result yet), P = 300,000 tokens.
//   At 20 calls, no verdict (p = base rate 0.6467), L = 105:
//     gain = 0.6467 x 20000 x 0.3 x 2e-7 x 105 = 0.0815
//     risk = 0.3533 x (20000 x 0.3 x 2.5e-6 + 300000 x 2e-7) = 0.3533 x 0.075 = 0.0265
//     a candidate, but rewriting 1e6 chars costs 1e6 x 0.3 x 2.3e-6 = 0.69 -> parked
//   At 40 calls, the judge's 0.01 (p = 0.2667), L = 132:
//     gain = 0.2667 x 0.1584 = 0.0422 < risk = 0.7333 x 0.075 = 0.055 -> withdrawn
const bigEarly = (calls) =>
  seenEvent({ model: "claude-sonnet-5", totalChars: 1000000, calls, items: [{ id: "big", tool: "Read", target: "big.txt", chars: 20000, at: 0, age: calls - 14 }] });

test("activate: an item that only fails on the rewrite is dropped cold, and withdrawn once the judge says keep", async () => {
  const h = makeWibble({ health: "up", ask: "up", notNeeded: 0.01 }, { cold: true });
  await activate(h.wibble);

  h.fireSeen(bigEarly(20));
  await wait(20); // the verdict lands after this batch was planned
  assert.deepStrictEqual(h.dropCalls, [{ sessionId: "s1", ids: ["big"], opts: { when: "cold" } }]);
  assert.strictEqual(Object.values(h.store.get("totals"))[0].skipped, 1);

  h.fireSeen(bigEarly(40));
  await wait(20);
  assert.deepStrictEqual(h.withdrawCalls, [{ sessionId: "s1", ids: ["big"] }]);
  assert.strictEqual(h.dropCalls.length, 1);
});

test("activate: a Wibble without cold drops is never sent one", async () => {
  const h = makeWibble({ health: "down" }); // no trim.withdraw
  await activate(h.wibble);

  h.fireSeen(bigEarly(20));
  h.fireSeen(bigEarly(40));
  await wait(20);
  assert.deepStrictEqual(h.dropCalls, []);
});

test("activate: a rejected cold drop is offered again at the next batch", async () => {
  const h = makeWibble({ health: "down" }, { cold: true });
  h.wibble.trim.drop = async (sessionId, ids, opts) => {
    h.dropCalls.push({ sessionId, ids, opts });
    throw new Error("session ended");
  };
  await activate(h.wibble);

  // No verdict either time (judge down), so it stays a candidate that only
  // fails on the rewrite: parked at 20 calls, and -- the first attempt
  // having been refused -- parked again at 40.
  h.fireSeen(bigEarly(20));
  await wait(20);
  h.fireSeen(bigEarly(40));
  await wait(20);
  assert.deepStrictEqual(
    h.dropCalls.map((c) => [c.ids, c.opts]),
    [
      [["big"], { when: "cold" }],
      [["big"], { when: "cold" }],
    ],
  );
});
