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

import { test } from "node:test";
import assert from "node:assert/strict";
import { activate } from "./main.js";

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
  const notNeeded = judge.notNeeded ?? 0.9;

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
      async fetch(url, opts) {
        if (url.endsWith("/health")) {
          if (health === "up") return { status: 200, headers: {}, body: JSON.stringify({ ok: true, model: "test" }) };
          return { status: 500, headers: {}, body: "" };
        }
        if (url.endsWith("/v1/systemone")) {
          if (askMode === "reject") throw new Error("connection refused");
          if (askMode === "down") return { status: 500, headers: {}, body: "" };
          return { status: 200, headers: {}, body: JSON.stringify({ answers: { stale: { noul: notNeeded } } }) };
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

  assert.strictEqual(h.dropCalls.length, 0, "the only item was judged needed (0.2 < 0.7), so nothing is dropped");
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

// --- persistence: totals survive a reload via storage -------------------

test("activate: totals persist to storage and are read back on the next activate()", async () => {
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
  assert.ok(stored && Object.keys(stored).length === 1, "one day's totals were persisted");
  const day = Object.values(stored)[0];
  assert.strictEqual(day.saved, 15000000);
  assert.strictEqual(day.actual, 15000000);
});
