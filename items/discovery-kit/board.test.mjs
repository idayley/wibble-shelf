// The board's rules (spec §4.3, §4.4), run under node against the page's
// own <script id="logic"> block -- so what is tested is what ships.
//
//   node --test items/discovery-kit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./board.html", import.meta.url), "utf8");
const block = html.match(/<script id="logic">([\s\S]*?)<\/script>/);
assert.ok(block, "board.html has a <script id=\"logic\"> block");
const L = new Function(
  block[1] + "\nreturn { counted, tally, verdict, nudge, storageWarning, lineLocked, records, commitmentLapsed };",
)();

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-15T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);

// A market with the default pass line (3 of 10 at level 4+, 1 commitment).
const market = (id = "a", extra = {}) => ({ id, name: `Market ${id.toUpperCase()}`, passLine: { calls: 10, hits: 3, commitments: 1 }, ...extra });

let seq = 0;
function world() {
  const people = {};
  const calls = [];
  return {
    people,
    calls,
    person(p) {
      const id = p.id ?? `p${++seq}`;
      people[id] = { id, market: "a", name: id, org: `Org ${id}`, buyingRole: "user", relationship: "none", status: "talked", ...p };
      return id;
    },
    call(c) {
      calls.push({ id: `c${++seq}`, market: "a", date: daysAgo(3), level: 1, confidence: "high", inSegment: true, tainted: false, ...c });
    },
    // One person, one call, in one step.
    talk(level, p = {}, c = {}) {
      const id = this.person(p);
      this.call({ person: id, level, ...c });
      return id;
    },
  };
}

const run = (w, m = market(), now = NOW) => {
  const t = L.tally(m, w.calls, w.people, now);
  return { t, v: L.verdict(m, t) };
};

test("zero calls: keep talking, nothing counted, line still editable", () => {
  const w = world();
  const { t, v } = run(w);
  assert.equal(t.n, 0);
  assert.equal(t.hits, 0);
  assert.equal(t.commits, 0);
  assert.equal(t.target, 10);
  assert.equal(v.auto, "Keep talking");
  assert.equal(v.shown, "Keep talking");
  assert.equal(v.closeMiss, false);
  assert.equal(L.lineLocked(market(), w.calls, w.people), false);
});

test("a market with no pass line gets the default 3 of 10 and 1 commitment", () => {
  const t = L.tally({ id: "a" }, [], {}, NOW);
  assert.deepEqual(t.line, { calls: 10, hits: 3, commitments: 1 });
});

// Three hits from two orgs, one a budget holder, one commitment.
function passing() {
  const w = world();
  const a = w.talk(5, { org: "North", buyingRole: "budget holder" }, { commitment: { currency: "time", what: "second call", due: daysAgo(1), status: "offered" } });
  w.talk(4, { org: "North" });
  w.talk(4, { org: "South" });
  w.talk(1);
  return { w, a };
}

test("persevere: hits, commitment, two orgs and a budget holder -- before the target", () => {
  const { w } = passing();
  const { t, v } = run(w);
  assert.equal(t.n, 4);
  assert.equal(t.hits, 3);
  assert.equal(t.commits, 1);
  assert.equal(t.orgs, 2);
  assert.equal(t.buyers, 1);
  assert.equal(v.auto, "Persevere");
});

test("persevere accepts a decision maker in place of a budget holder", () => {
  const w = world();
  w.talk(5, { org: "X", buyingRole: "decision maker" }, { commitment: { what: "intro", status: "fulfilled" } });
  w.talk(4, { org: "Y" });
  w.talk(4, { org: "Z" });
  assert.equal(run(w).v.auto, "Persevere");
});

test("not persevere when all hits come from one organisation", () => {
  const w = world();
  w.talk(5, { org: "Same", buyingRole: "budget holder" }, { commitment: { what: "intro", status: "offered" } });
  w.talk(4, { org: "same " }); // same org, different spelling of case/space
  w.talk(4, { org: "Same" });
  const { t, v } = run(w);
  assert.equal(t.hits, 3);
  assert.equal(t.orgs, 1);
  assert.equal(v.auto, "Keep talking");
});

test("not persevere without a budget holder or decision maker among the hits", () => {
  const w = world();
  w.talk(5, { org: "A" }, { commitment: { what: "intro", status: "offered" } });
  w.talk(4, { org: "B", buyingRole: "influencer" });
  w.talk(4, { org: "C", buyingRole: "expert" });
  w.talk(1, { org: "D", buyingRole: "budget holder" }); // a buyer, but not a hit
  const { t, v } = run(w);
  assert.equal(t.buyers, 0);
  assert.equal(v.auto, "Keep talking");
});

test("not persevere without the commitment", () => {
  const w = world();
  w.talk(5, { org: "A", buyingRole: "budget holder" });
  w.talk(4, { org: "B" });
  w.talk(4, { org: "C" });
  assert.equal(run(w).v.auto, "Keep talking");
});

test("pivot early once the line can't be met: hits + (target − n) < line", () => {
  const w = world();
  for (let i = 0; i < 7; i++) w.talk(2);
  assert.equal(run(w).v.auto, "Keep talking", "0 + 3 left = 3, not below 3");
  w.talk(1);
  const { t, v } = run(w);
  assert.equal(t.n, 8);
  assert.equal(v.auto, "Pivot", "0 + 2 left < 3");
  assert.equal(v.closeMiss, false);
});

test("pivot at the target when the line isn't met", () => {
  const w = world();
  w.talk(4, { org: "A", buyingRole: "budget holder" });
  w.talk(4, { org: "B" });
  w.talk(4, { org: "C" });
  for (let i = 0; i < 7; i++) w.talk(1);
  const { t, v } = run(w);
  assert.equal(t.n, 10);
  assert.equal(t.hits, 3);
  assert.equal(v.auto, "Pivot", "3 hits but no commitment");
  assert.equal(v.closeMiss, false, "hits aren't line − 1");
});

// Ten calls, two hits, one commitment.
function closeMiss() {
  const w = world();
  w.talk(5, { org: "A", buyingRole: "budget holder" }, { commitment: { what: "pilot talk", status: "offered", due: daysAgo(2) } });
  w.talk(4, { org: "B" });
  for (let i = 0; i < 8; i++) w.talk(2);
  return w;
}

test("close miss: pivot with hits = line − 1 and a commitment offers extending to 15", () => {
  const { t, v } = run(closeMiss());
  assert.equal(t.n, 10);
  assert.equal(t.hits, 2);
  assert.equal(t.commits, 1);
  assert.equal(v.auto, "Pivot");
  assert.equal(v.closeMiss, true);
});

test("no close miss without a commitment", () => {
  const w = world();
  w.talk(5, { org: "A", buyingRole: "budget holder" });
  w.talk(4, { org: "B" });
  for (let i = 0; i < 8; i++) w.talk(2);
  const { v } = run(w);
  assert.equal(v.auto, "Pivot");
  assert.equal(v.closeMiss, false);
});

test("extended market: target 15, the same ten calls keep talking, no second close miss", () => {
  const w = closeMiss();
  const m = market("a", { extended: { note: "two strong calls, one more slice to try", at: "2026-06-10" } });
  const { t, v } = run(w, m);
  assert.equal(t.target, 15);
  assert.equal(v.auto, "Keep talking");
  for (let i = 0; i < 5; i++) w.talk(1);
  const after = run(w, m);
  assert.equal(after.t.n, 15);
  assert.equal(after.v.auto, "Pivot");
  assert.equal(after.v.closeMiss, false, "already extended");
});

test("override is shown, and the automatic verdict stays beside it", () => {
  const w = closeMiss();
  const m = market("a", { override: { verdict: "Persevere", note: "the budget holder asked to pilot", at: "2026-06-14" } });
  const { v } = run(w, m);
  assert.equal(v.auto, "Pivot");
  assert.equal(v.shown, "Persevere");
  assert.equal(v.override.note, "the budget holder asked to pilot");
});

test("an override with an unknown verdict is ignored", () => {
  const { v } = run(world(), market("a", { override: { verdict: "Maybe", note: "" } }));
  assert.equal(v.shown, "Keep talking");
  assert.equal(v.override, undefined);
});

test("a commitment lapses 14 days after it was due, unless kept", () => {
  const due = (d) => ({ what: "intro", status: "offered", due: daysAgo(d) });
  assert.equal(L.commitmentLapsed(due(13), NOW), false);
  assert.equal(L.commitmentLapsed(due(15), NOW), true);
  assert.equal(L.commitmentLapsed({ ...due(40), status: "fulfilled" }, NOW), false);
  assert.equal(L.commitmentLapsed({ what: "intro", status: "lapsed" }, NOW), true);
  assert.equal(L.commitmentLapsed({ what: "intro", status: "offered" }, NOW), false, "no due date, no lapse");

  const w = world();
  w.talk(5, { org: "A", buyingRole: "budget holder" }, { commitment: due(20) });
  w.talk(4, { org: "B" });
  w.talk(4, { org: "C" });
  const { t, v } = run(w);
  assert.equal(t.commits, 0);
  assert.equal(t.commitments.length, 1);
  assert.equal(t.commitments[0].lapsed, true, "kept for display, struck through");
  assert.equal(v.auto, "Keep talking", "a lapsed commitment can't carry persevere");
});

test("commitments count once per person", () => {
  const w = world();
  const id = w.talk(4, {}, { commitment: { what: "intro", status: "offered" } });
  w.call({ person: id, level: 4, date: daysAgo(1), commitment: { what: "data", status: "offered" } });
  assert.equal(run(w).t.commits, 1);
});

test("not counted: friend-family, out of segment, tainted, low confidence with an ambiguous speaker", () => {
  const w = world();
  w.talk(5, { relationship: "friend-family", buyingRole: "budget holder" }, { commitment: { what: "intro", status: "offered" } });
  w.talk(5, {}, { inSegment: false });
  w.talk(5, {}, { tainted: true });
  w.talk(5, {}, { confidence: "low", speaker: "ambiguous" });
  w.talk(3, {}, { confidence: "low" }); // low alone still counts
  w.talk(3, { relationship: "colleague" }); // flagged, but counts
  const { t } = run(w);
  assert.equal(t.n, 2);
  assert.equal(t.hits, 0);
  assert.equal(t.commits, 0, "the friend's commitment doesn't count either");
  assert.equal(t.notCounted, 4);
});

test("a person is counted once -- their latest call", () => {
  const w = world();
  const id = w.person({});
  w.call({ person: id, level: 2, date: daysAgo(9) });
  w.call({ person: id, level: 5, date: daysAgo(2) });
  w.call({ person: id, level: 3, date: daysAgo(5) });
  const counted = L.counted(w.calls, w.people);
  assert.equal(counted.length, 1);
  assert.equal(counted[0].level, 5);
  const { t } = run(w);
  assert.equal(t.n, 1);
  assert.equal(t.hits, 1);
  assert.equal(t.notCounted, 2);
});

test("calls for another market don't count here", () => {
  const w = world();
  w.talk(5);
  w.talk(5, { market: "b" }, { market: "b" });
  assert.equal(run(w).t.n, 1);
});

test("the pass line locks after the first counted call, not before", () => {
  const w = world();
  w.talk(5, { relationship: "friend-family" });
  assert.equal(L.lineLocked(market(), w.calls, w.people), false, "an uncounted call doesn't lock it");
  w.talk(1);
  assert.equal(L.lineLocked(market(), w.calls, w.people), true);
});

test("nudge: no markets says how to start", () => {
  assert.match(L.nudge([], [], NOW, {}), /Add a market/);
});

test("nudge precedence: a close miss beats the market with most hits", () => {
  const w = closeMiss();
  w.talk(5, { market: "b", org: "P" }, { market: "b" });
  w.talk(4, { market: "b", org: "Q" }, { market: "b" });
  w.talk(4, { market: "b", org: "R" }, { market: "b" });
  const line = L.nudge([market("a", { order: 1 }), market("b", { order: 0 })], w.calls, NOW, w.people);
  assert.match(line, /^Market A: close miss, 2 of 3/);
  assert.match(line, /Extend to 15/);
});

test("nudge precedence: most hits (still keep talking) beats a quiet market", () => {
  const w = world();
  w.talk(5, { org: "A" });
  w.talk(4, { org: "B" });
  w.talk(1);
  w.talk(4, { market: "b" }, { market: "b" });
  const line = L.nudge([market("a"), market("b"), market("c")], w.calls, NOW, w.people);
  assert.equal(line, "Market A: 3 calls, 2 hair-on-fire. 7 more before the pass line can be judged.");
});

test("nudge precedence: with no hits anywhere, a market with no calls this week", () => {
  const w = world();
  w.talk(2);
  w.talk(1, { market: "b" }, { market: "b", date: daysAgo(10) });
  w.talk(1, { market: "b" }, { market: "b", date: daysAgo(12) });
  const line = L.nudge([market("a"), market("b")], w.calls, NOW, w.people);
  assert.equal(line, "Market B: no calls in the last 7 days, 2 of 10 so far.");
});

test("nudge precedence: otherwise the market with the fewest calls", () => {
  const w = world();
  w.talk(2);
  w.talk(2);
  w.talk(1, { market: "b" }, { market: "b" });
  const line = L.nudge([market("a"), market("b")], w.calls, NOW, w.people);
  assert.equal(line, "Market B: fewest calls, 1 of 10.");
});

test("nudge skips decided markets: overridden or already persevere/pivot", () => {
  const { w } = passing();
  w.talk(1, { market: "b" }, { market: "b" });
  const line = L.nudge([market("a"), market("b", { override: { verdict: "Pivot", note: "" } })], w.calls, NOW, w.people);
  assert.match(line, /Every market has a verdict/);
});

test("counts only, never percentages, in every verdict-side line", () => {
  const lines = [
    L.nudge([market("a")], closeMiss().calls, NOW, closeMiss().people),
    L.nudge([market("a")], [], NOW, {}),
  ];
  const { w } = passing();
  lines.push(L.nudge([market("a"), market("b")], w.calls, NOW, w.people));
  for (const l of lines) assert.doesNotMatch(l, /%/);
});

test("storage warning past 80% of 256 KB", () => {
  assert.equal(L.storageWarning(0), false);
  assert.equal(L.storageWarning(0.8 * 256 * 1024), false);
  assert.equal(L.storageWarning(0.8 * 256 * 1024 + 1), true);
});

test("records: the store's keys come apart by kind", () => {
  const r = L.records({
    "market:b": { name: "B", order: 1 },
    "market:a": { name: "A", order: 0 },
    "person:p1": { id: "p1", market: "a" },
    "call:c1": { id: "c1", person: "p1", market: "a", level: 4 },
    "wave:a:1": { thought: "t" },
    settings: { sender: "S", channels: ["email"] },
  });
  assert.deepEqual(r.markets.map((m) => m.id), ["a", "b"]);
  assert.equal(r.people.p1.market, "a");
  assert.equal(r.calls.length, 1);
  assert.equal(r.waves[0].key, "wave:a:1");
  assert.equal(r.settings.sender, "S");
});

test("the page names no market, company or bet of its own", () => {
  // Generic kit: the only market names in the page are placeholders.
  assert.doesNotMatch(html, /Market [A-Z]\b/, "no sample markets baked in");
});
