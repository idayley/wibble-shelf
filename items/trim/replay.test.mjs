// trim/replay.test.mjs — run with `node --test items/trim/replay.test.mjs`.
//
// Synthetic threads only; nothing here reads ~/.claude. Hand-worked totals
// sit in comments above each assertion.
//
// Units in the comments: 1e-7 dollars. The fixture model is Haiku 4.5
// (BUILTIN_PRICES): cache read = 1, 5-minute write = 12.5, 1-hour write =
// 20. r = 1 token per char, and every prompt is S = 1000 tokens (system
// and tools) plus its messages' chars, so a prompt's tokens are 1000 + chars.
// An unjudged item's chance of not being needed is CALIBRATION.baseRate,
// p = 0.6467.

import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, replayThread, transcriptReader, targetOf, report } from "./replay.mjs";

const U = 1e-7;
const MODEL = "claude-haiku-4-5";

function closeTo(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: got ${actual}, expected ${expected}`);
}

/**
 * A thread of `count` requests. Before request n comes user message n
 * (`users[n]`: { chars, item?: {id, target} }, else empty), and after it an
 * empty assistant message. `time(n)` is request n's time in seconds.
 */
function thread(name, count, users, time = (n) => n, tier = "1h") {
  const messages = [];
  const requests = [];
  let C = 0;
  for (let n = 0; n < count; n++) {
    const u = users[n] || { chars: 0 };
    const items = u.item ? [{ id: u.item.id, tool: "Read", target: u.item.target || "", chars: u.chars }] : [];
    messages.push({ role: "user", chars: u.chars, items });
    C += u.chars;
    requests.push({ t: time(n), model: MODEL, prompt: 1000 + C, write1h: tier === "1h", billed: tier === "1h" ? [0, 0, 0, 1] : [0, 0, 1, 0], nMsgs: messages.length });
    messages.push({ role: "assistant", chars: 0, items: [] });
  }
  return { name, messages, requests };
}

// A: short. A 100-char result first, then at request 20 a 10,000-char
// message; it ends at request 21.
const A = thread("A", 22, { 0: { chars: 100, item: { id: "a0" } }, 20: { chars: 10000 } });
// B: long. A 10,000-char result first, then 59 more requests.
const B = thread("B", 60, { 0: { chars: 10000, item: { id: "b0" } } });
// C: like A on the 5-minute cache, 30 requests, a 10-minute pause before 25.
const C = thread("C", 30, { 0: { chars: 100, item: { id: "c0" } }, 20: { chars: 10000 } }, (n) => (n < 25 ? n : 600 + n), "5m");

test("replay: a short thread where v2 skips and v1 loses", () => {
  const tot = {};
  for (const mode of ["none", "v1", "v2"]) {
    tot[mode] = { usd: 0, billedUsd: 0, requests: 0, cuts: 0, freeCuts: 0, rereads: 0, rereadUsd: 0 };
    replayThread(A, mode, 1, tot[mode]);
  }
  // none: req 0 writes 1,100 x 20 = 22,000; reqs 1-19 read 1,100 = 20,900;
  // req 20 reads 1,100 and writes 10,000 x 20 = 201,100; req 21 reads
  // 11,100. Total 255,100.
  closeTo(tot.none.usd, 255100 * U, "none");
  // v2 at request 20: plan() sees request 19's P (1,100 -- the request
  // before this one, same as activate() only ever having the previous
  // result's size). a0 is a candidate (p x 100 x 1 x left(20)=210 =
  // 13,581 >= (1-p) x (100 x 20 + 1,100) = 1,095) but the rewrite from it,
  // 10,100 x 19 = 191,900, sinks it: parked for a cold cache, which never
  // comes. So v2 is no trimming.
  closeTo(tot.v2.usd, 255100 * U, "v2");
  assert.strictEqual(tot.v2.cuts, 0);
  // v1 cuts a0 at 20; applied at 21, which reads only the 1,000 before it
  // and rewrites the 10,000 after: 1,000 + 200,000 = 201,000 instead of
  // 11,100. Total 255,100 - 11,100 + 201,000 = 445,000.
  closeTo(tot.v1.usd, 445000 * U, "v1");
  assert.strictEqual(tot.v1.cuts, 1);
});

test("replay: three threads' totals (short: v1 loses; long: both save; paused: v2 cuts free)", () => {
  const out = replay([A, B, C], 1);
  assert.strictEqual(out.threads, 3);
  assert.strictEqual(out.runs.none.requests, 22 + 60 + 30);

  // B, none: req 0 writes 11,000 x 20 = 220,000; reqs 1-59 read 11,000 =
  // 649,000. Total 869,000.
  // B, both: at 20 b0 is cut (v2: 0.6467 x 10,000 x left(20)=210 =
  // 1,358,070 gain, 0.3533 x (200,000 + 11,000) = 74,546 risk, 10,000 x 19
  // = 190,000 rewrite: net 1,093,524 > 0). Reqs 0-20 = 440,000; req 21
  // reads the 1,000 before it and writes nothing = 1,000; reqs 22-59 =
  // 38,000. Total 479,000.
  //
  // C, none (5-minute writes, 12.5): req 0 = 13,750; reqs 1-19 = 20,900;
  // req 20 = 1,100 + 125,000 = 126,100; reqs 21-24 = 44,400; req 25 after
  // the pause rewrites all 11,100 = 138,750; reqs 26-29 = 44,400. Total
  // 388,300.
  // C, v1: cut applied at 21 = 1,000 + 10,000 x 12.5 = 126,000; reqs 22-24
  // = 33,000; req 25 = 11,000 x 12.5 = 137,500; reqs 26-29 = 44,000. With
  // reqs 0-20 (160,750): 501,250.
  // C, v2: c0 parked at 20 (13,581 gain vs 0.3533 x (1,250 + 1,100) = 830
  // risk, using request 19's P as plan() does, but 10,100 x 11.5 = 116,150
  // rewrite), applied free at 25:
  // reqs 0-24 as none = 205,150; req 25 = 137,500; reqs 26-29 = 44,000.
  // Total 386,650.
  //
  // none = 255,100 + 869,000 + 388,300 = 1,512,400
  // v1   = 445,000 + 479,000 + 501,250 = 1,425,250
  // v2   = 255,100 + 479,000 + 386,650 = 1,120,750
  closeTo(out.runs.none.usd, 1512400 * U, "none");
  closeTo(out.runs.v1.usd, 1425250 * U, "v1");
  closeTo(out.runs.v2.usd, 1120750 * U, "v2");
  assert.strictEqual(out.runs.v1.cuts, 3);
  assert.strictEqual(out.runs.v2.cuts, 1);
  assert.strictEqual(out.runs.v2.freeCuts, 1);

  const text = report(out);
  assert.match(text, /v1 +\$0\.14 +saved \$0\.01 \(5\.8%\)/);
  assert.match(text, /v2 +\$0\.11 +saved \$0\.04 \(25\.9%\)/);
  assert.match(text, /gate: PASS/);
});

test("replay: a later call naming a dropped item's target is charged as a re-read", () => {
  // B, with b0 a read of f.txt and, at request 30, a 50-char read of f.txt.
  const B2 = thread("B2", 60, { 0: { chars: 10000, item: { id: "b0", target: "f.txt" } }, 30: { chars: 50, item: { id: "b30", target: "f.txt" } } });
  const out = replay([B2], 1);
  // none: B's 869,000, plus req 30 writing the new 50 (11,000 read + 50 x
  // 20 = 12,000, +1,000) and reqs 31-59 reading 50 more (+1,450): 871,450.
  closeTo(out.runs.none.usd, 871450 * U, "none");
  // Both: B's 479,000; req 30 = 1,000 read + 50 x 20 = 2,000 (+1,000);
  // the re-read at 30: its prompt 1,050 read again + 50 x 20 written =
  // 2,050; reqs 31-40 read 1,050 (+500). At 40 b30 is cut (v2: 0.6467 x 50
  // x left(40)=264 = 8,536 gain, 0.3533 x (1,000 + 1,050) = 724 risk, 50 x
  // 19 = 950 rewrite), so reqs 41-59 read 1,000 as in B. 479,000 + 1,000 +
  // 2,050 + 500 = 482,550.
  closeTo(out.runs.v1.usd, 482550 * U, "v1");
  closeTo(out.runs.v2.usd, 482550 * U, "v2");
  assert.strictEqual(out.runs.v1.rereads, 1);
  closeTo(out.runs.v1.rereadUsd, 2050 * U, "re-read charge");
});

test("replayThread: plan() sees the PREVIOUS request's prompt size, not this one's own growth, same as activate()", () => {
  // Like A (a0, 100 chars, at request 0), but request 20's OWN prompt
  // jumps (tool schemas grew, say) instead of its chars: S = prompt - r x
  // chars picks that jump up, while totalChars -- and so the rewrite --
  // stays tiny. Wrongly feeding plan() THIS request's own P (51,100) makes
  // a0 look too risky to touch at all (0.3533 x (2,000 + 51,100) = 18,760
  // > the 13,581 gain: not even a candidate). Fed the PREVIOUS request's P
  // (1,100 -- request 19's, the only one onResult would actually have had
  // in hand), it clears easily (0.3533 x (2,000 + 1,100) = 1,095) and pays
  // back a 100 x 19 = 1,900 rewrite: cut now, applied at request 21.
  const messages = [];
  const requests = [];
  for (let n = 0; n < 22; n++) {
    const items = n === 0 ? [{ id: "x0", tool: "Read", target: "", chars: 100 }] : [];
    messages.push({ role: "user", chars: n === 0 ? 100 : 0, items });
    const prompt = n === 20 ? 1000 + 100 + 50000 : 1000 + 100;
    requests.push({ t: n, model: MODEL, prompt, write1h: true, billed: [0, 0, 0, 1], nMsgs: messages.length });
    messages.push({ role: "assistant", chars: 0, items: [] });
  }
  const D = { name: "D", messages, requests };

  const tot = { usd: 0, billedUsd: 0, requests: 0, cuts: 0, freeCuts: 0, rereads: 0, rereadUsd: 0 };
  replayThread(D, "v2", 1, tot);
  assert.strictEqual(tot.cuts, 1, "x0 is cut and applied, not left untouched by an inflated risk figure");
});

test("transcriptReader: one message per id, duplicates skipped, a new thread at compaction", () => {
  const lines = [
    { type: "user", uuid: "u1", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a1", timestamp: "2026-09-27T00:00:00Z", message: { id: "m1", model: MODEL, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } } } },
    { type: "assistant", uuid: "a2", timestamp: "2026-09-27T00:00:00Z", message: { id: "m1", model: MODEL, content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/a.txt" } }] } },
    { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "hello" }] } },
    { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "hello" }] } },
    { type: "assistant", uuid: "a3", isSidechain: true, timestamp: "2026-09-27T00:00:01Z", message: { id: "side", model: MODEL, content: [] } },
    { type: "assistant", uuid: "a4", timestamp: "2026-09-27T00:00:02Z", message: { id: "m2", model: MODEL, content: [{ type: "text", text: "done" }] } },
    { type: "system", subtype: "compact_boundary", uuid: "s1" },
    { type: "user", uuid: "u3", message: { role: "user", content: "summary" } },
    { type: "assistant", uuid: "a5", timestamp: "2026-09-27T00:00:03Z", message: { id: "m3", model: MODEL, content: [{ type: "text", text: "go" }] } },
  ];
  const reader = transcriptReader("p/f.jsonl");
  for (const l of lines) reader.line(JSON.stringify(l));
  reader.line("not json");
  const threads = reader.finish();

  assert.strictEqual(threads.length, 2);
  const [one, two] = threads;
  assert.deepStrictEqual(
    one.messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.deepStrictEqual(one.messages[2].items, [{ id: "tu1", tool: "Read", target: "/a.txt", chars: 5 }]);
  assert.deepStrictEqual(
    one.requests.map((q) => [q.model, q.nMsgs, q.prompt, q.write1h]),
    [
      [MODEL, 1, 115, true],
      [MODEL, 3, null, false],
    ],
  );
  assert.deepStrictEqual(one.requests[0].billed, [5, 100, 0, 10]);
  assert.strictEqual(two.requests.length, 1);
  assert.strictEqual(two.requests[0].nMsgs, 1);
});

test("targetOf: wire.rs's order, argv joined, capped at 300", () => {
  assert.strictEqual(targetOf({ command: "ls", file_path: "/x" }), "/x");
  assert.strictEqual(targetOf({ command: ["git", "status"] }), "git status");
  assert.strictEqual(targetOf({ pattern: "a".repeat(400) }).length, 300);
  assert.strictEqual(targetOf({ description: "x" }), "");
  assert.strictEqual(targetOf(null), "");
});
