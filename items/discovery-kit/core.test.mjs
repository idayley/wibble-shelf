// The kit's shared rules, run under node against core.js, the one copy that
// sync-core.mjs pastes into every page.
//
//   node --test items/discovery-kit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./core.js", import.meta.url), "utf8");
const L = new Function(
  src + "\nreturn { counted, tally, verdict, verdictLine, verdictLabel, lineLocked, records, commitmentLapsed, countsFor, funnel, nextStep, lineOf, plural };",
)();

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-15T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);

// A market with the default pass line (3 of 10 at level 4+, 1 commitment).
const market = (id = "a", extra = {}) => ({ id, name: `Market ${id.toUpperCase()}`, passLine: { calls: 10, hits: 3, commitments: 1 }, bet: { v: 1 }, ...extra });

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
      calls.push({ id: `c${++seq}`, market: "a", date: daysAgo(3), betV: 1, level: 1, confidence: "high", inSegment: true, tainted: false, ...c });
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


// ---- bets: a call counts for the bet it was made under, or carries over --

test("countsFor: the call's own bet, unless counts says otherwise", () => {
  assert.equal(L.countsFor({ betV: 1 }, 2), false);
  assert.equal(L.countsFor({ betV: 1 }, 1), true);
  assert.equal(L.countsFor({ betV: 1, counts: { "2": true } }, 2), true);
  assert.equal(L.countsFor({ betV: 1, counts: { "1": false } }, 1), false);
});

test("a market on bet v2 tallies only the calls that carried over", () => {
  const w = world();
  // Four calls at levels 5, 4, 2, 1; the two no-show calls carry to v2.
  w.talk(5, { org: "A" }, { counts: { "2": true } });
  w.talk(4, { org: "B" }, { counts: { "2": true } });
  w.talk(2, { org: "C" });
  w.talk(1, { org: "D" });
  const v1 = L.tally(market("a"), w.calls, w.people, NOW);
  assert.equal(v1.n, 4);
  assert.equal(v1.hits, 2);
  const m2 = market("a", { bet: { v: 2 } });
  const t = L.tally(m2, w.calls, w.people, NOW);
  assert.equal(t.n, 2);
  assert.equal(t.hits, 2);
  // The line stays locked: v1's calls still lock it.
  assert.equal(L.lineLocked(m2, w.calls, w.people), true);
});

test("the pass line reads {hits, of, commits} and the older spelling", () => {
  assert.deepEqual(L.lineOf({ passLine: { hits: 2, of: 8, commits: 0 } }), { calls: 8, hits: 2, commitments: 0 });
  assert.deepEqual(L.lineOf({ passLine: { calls: 6, hits: 2, commitments: 1 } }), { calls: 6, hits: 2, commitments: 1 });
});

test("verdict label and line: not started, counts, never a percentage", () => {
  const w = world();
  const m = market();
  let t = L.tally(m, w.calls, w.people, NOW);
  assert.equal(L.verdictLabel(L.verdict(m, t), t), "Not started");
  assert.equal(L.verdictLine(m, t, L.verdict(m, t)), "No calls yet. You can still change the pass line.");
  w.talk(5, { org: "A" });
  w.talk(4, { org: "B" });
  t = L.tally(m, w.calls, w.people, NOW);
  const line = L.verdictLine(m, t, L.verdict(m, t));
  assert.match(line, /^One more hair-on-fire call in the next 8 makes it Persevere/);
  assert.doesNotMatch(line, /%/);
  assert.equal(L.verdictLabel(L.verdict(m, t), t), "Keep talking");
});

// ---- funnel and next step ------------------------------------------------

const ch = (email, li, call) => ({ email: !!email, li: !!li, call: !!call });
const P = (id, status, over = {}) => ({ id, market: "a", name: id, status, channels: ch(), ...over });
function rec(over = {}) {
  const base = {
    "settings": { active: "a" },
    "market:a": { name: "A", order: 0, passLine: { hits: 3, of: 10, commits: 1 }, bet: { v: 1, who: "w", pain: "p", shown: "s", where: "x" } },
  };
  return L.records({ ...base, ...over });
}

test("funnel counts people by how far they got, and hits among counted calls", () => {
  const w = world();
  w.talk(5, { id: "p1", status: "called" });
  w.talk(1, { id: "p2", status: "called" });
  const people = { ...w.people, n1: P("n1", "new"), a1: P("a1", "asked"), b1: P("b1", "booked"), s1: P("s1", "skipped"), o: P("o", "asked", { market: "z" }) };
  assert.deepEqual(L.funnel(market(), people, w.calls), [
    ["Found", 6], ["Asked", 4], ["Booked", 3], ["Called", 2], ["Hair on fire", 1],
  ]);
});

test("nextStep: no market, then no bet, writes the first bet", () => {
  assert.equal(L.nextStep(L.records({})).zone, "markets");
  assert.equal(L.nextStep(L.records({})).text, "Write your first bet");
  assert.equal(L.nextStep(L.records({ "market:a": { name: "A" } })).text, "Write your first bet");
});

test("nextStep: no people says press Find people", () => {
  const n = L.nextStep(rec());
  assert.equal(n.zone, "markets");
  assert.equal(n.text, "Press Find people");
});

test("nextStep: people but none picked or asked says pick who to ask", () => {
  const n = L.nextStep(rec({ "person:p1": P("p1", "new") }));
  assert.equal(n.zone, "people");
  assert.equal(n.text, "Pick who to ask");
  // A picked channel, or an already-asked person, moves on.
  assert.notEqual(L.nextStep(rec({ "person:p1": P("p1", "new", { channels: ch(1) }) })).text, "Pick who to ask");
});

test("nextStep: unsent drafts say send your asks", () => {
  const draft = (status) => ({ id: "d1", person: "p1", market: "a", kind: "ask", body: "hi", betV: 1, status, at: "2026-09-30T00:00:00Z" });
  const n = L.nextStep(rec({ "person:p1": P("p1", "new", { channels: ch(1) }), "draft:d1": draft("draft") }));
  assert.equal(n.zone, "send");
  assert.equal(n.text, "Send your asks");
  const sent = L.nextStep(rec({ "person:p1": P("p1", "asked"), "draft:d1": draft("sent") }));
  assert.notEqual(sent.zone, "send");
});

test("nextStep: booked with no call scored says drop the recording", () => {
  const n = L.nextStep(rec({ "person:p1": P("p1", "booked") }));
  assert.equal(n.zone, "calls");
  assert.equal(n.text, "Drop the recording after your call");
});

test("nextStep: otherwise the verdict's sentence, with the sharper-bet line when one is open", () => {
  const calls = {
    "person:p1": P("p1", "called", { org: "North" }),
    "call:c1": { id: "c1", person: "p1", market: "a", at: "2026-09-20T00:00:00Z", level: 5, betV: 1 },
  };
  const n = L.nextStep(rec(calls), NOW);
  assert.equal(n.zone, "calls");
  assert.match(n.text, /more hair-on-fire calls? in the next 9 makes it Persevere/);
  assert.equal(n.also, undefined);
  const s = L.nextStep(rec({ ...calls, "suggest:a": { status: "open", from: 1 } }), NOW);
  assert.equal(s.also, "a sharper bet, suggested in Calls");
  assert.equal(L.nextStep(rec({ ...calls, "suggest:a": { status: "kept" } }), NOW).also, undefined);
});

test("records collects drafts and suggestions", () => {
  const r = L.records({ "draft:d1": { person: "p1" }, "suggest:a": { status: "open" } });
  assert.equal(r.drafts[0].id, "d1");
  assert.equal(r.suggest.a.status, "open");
});
