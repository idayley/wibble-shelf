// The kit's shared rules, run under node against core.js, the one copy that
// sync-core.mjs pastes into every page.
//
//   node --test items/fundraising-kit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./core.js", import.meta.url), "utf8");
const {
  STEPS, PHASES, GUIDE, WHY_THEY_ASK, STEP_NOTE, DRAFT_NOTE, READING_NOTE,
  records, roundOf, phaseAt, quietDays, nextFor, alsoWaiting, weekNotes, unreadWeek, fromDiscovery, applyReading,
  questionStatus, isoDay, addDays,
} = new Function(
  src + "\nreturn { STEPS, PHASES, GUIDE, WHY_THEY_ASK, STEP_NOTE, DRAFT_NOTE, READING_NOTE, records, roundOf, phaseAt, quietDays, nextFor, alsoWaiting, weekNotes, unreadWeek, fromDiscovery, applyReading, questionStatus, isoDay, addDays };",
)();

const D = (s) => Date.parse(s + "T12:00:00");

test("phases from the round's dates", () => {
  const r = roundOf({ round: { start: "2026-10-01", closeBy: "2026-11-30", mustClose: "2026-12-15" } }, D("2026-10-01"));
  assert.deepEqual(r.phases.map((p) => [p.name, p.from, p.to]), [
    ["Prepare", "2026-10-01", "2026-10-20"], ["Meetings", "2026-10-21", "2026-11-15"],
    ["Close", "2026-11-16", "2026-11-30"], ["Backup", "2026-12-01", "2026-12-15"]]);
  assert.equal(phaseAt(r, D("2026-10-20")), 0);
  assert.equal(phaseAt(r, D("2026-10-21")), 1);
  assert.equal(phaseAt(r, D("2026-12-20")), 3);
});

test("defaults: start today, close Nov 30, must close Dec 15", () => {
  const r = roundOf({}, D("2026-10-05"));
  assert.equal(r.start, "2026-10-05"); assert.equal(r.closeBy, "2026-11-30"); assert.equal(r.mustClose, "2026-12-15");
});

test("a close-by earlier than start + 20 days keeps phases in order", () => {
  const r = roundOf({ round: { start: "2026-11-01", closeBy: "2026-11-10", mustClose: "2026-11-20" } }, D("2026-11-01"));
  for (let i = 1; i < 4; i++) assert.ok(r.phases[i].from > r.phases[i - 1].to);
  for (const p of r.phases) assert.ok(p.from <= p.to);
  assert.equal(r.phases[0].from, "2026-11-01");
  assert.equal(r.phases[3].to, "2026-11-20");
});

test("a must-close before close-by still gives four ordered phases", () => {
  const r = roundOf({ round: { start: "2026-10-01", closeBy: "2026-11-30", mustClose: "2026-11-01" } }, D("2026-10-01"));
  for (let i = 1; i < 4; i++) assert.ok(r.phases[i].from > r.phases[i - 1].to);
  for (const p of r.phases) assert.ok(p.from <= p.to);
});

test("dates cross month and year ends", () => {
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(isoDay(D("2026-10-01")), "2026-10-01");
  assert.equal(isoDay("2026-10-01"), "2026-10-01");
});

test("quiet after 10 days with no next step due", () => {
  assert.equal(quietDays({ lastContact: "2026-10-01", step: 4 }, D("2026-10-11")), null);
  assert.equal(quietDays({ lastContact: "2026-10-01", step: 4 }, D("2026-10-12")), 11);
  assert.equal(quietDays({ lastContact: "2026-10-01", step: 4, next: { due: "2026-10-14" } }, D("2026-10-12")), null);
  assert.equal(quietDays({ lastContact: "2026-10-01", passed: true }, D("2026-10-30")), null);
});

test("next for you: day one's three moves in order, then the rest", () => {
  const empty = records({});
  assert.equal(nextFor(empty, D("2026-10-01")).zone, "investors");
  assert.equal(nextFor(empty, D("2026-10-01")).cap, "START HERE · 0 OF 3 DONE");
  assert.deepEqual(nextFor(empty, D("2026-10-01")).start.map((s) => s.done), [false, false, false]);
  const added = records({ "investor:a": { name: "Dana", step: 0 } });
  assert.equal(nextFor(added, D("2026-10-01")).zone, "story");
  assert.match(nextFor(added, D("2026-10-01")).text, /Set the round/);
  const roundSet = records({ "investor:a": { name: "Dana", step: 0 }, settings: { round: { set: true } } });
  assert.match(nextFor(roundSet, D("2026-10-01")).text, /Fill answers/);
  // set up: draft a first note, then send it
  const ready = { settings: { round: { set: true } }, "question:pmf": { status: "ready" }, "question:big": { status: "ready" }, "question:pay": { status: "ready" }, "investor:a": { name: "Dana", step: 0 } };
  assert.equal(nextFor(records(ready), D("2026-10-01")).zone, "investors");
  assert.match(nextFor(records(ready), D("2026-10-01")).text, /draft a first note/);
  assert.equal(nextFor(records(ready), D("2026-10-01")).cap, "NEXT FOR YOU");
  const drafted = records({ ...ready, "draft:x": { status: "new" } });
  assert.equal(nextFor(drafted, D("2026-10-01")).zone, "send");
  // round set, answers filled, investors in: the soonest next step
  const going = records({
    settings: { round: { amount: "500k", set: true } }, "question:pmf": { status: "ready" }, "question:big": { status: "ready" }, "question:pay": { status: "ready" },
    "investor:a": { name: "Dana", step: 3, next: { text: "First meeting", due: "2026-10-09" } },
    "investor:b": { name: "Ana", step: 4, next: { text: "Send references", due: "2026-10-08" } },
    "draft:x": { status: "sent" },
  });
  assert.match(nextFor(going, D("2026-10-08")).text, /Ana/);
  assert.equal(nextFor(going, D("2026-10-08")).zone, "investors");
  assert.equal(nextFor(going, D("2026-10-08")).start, undefined);
});

test("a question needing evidence comes before the soonest step", () => {
  const r = records({
    settings: { round: { set: true } },
    "question:pmf": { status: "ready" }, "question:big": { status: "ready" }, "question:pay": { status: "ready" },
    "question:margins": { status: "needs", source: "meeting" },
    "investor:a": { name: "Dana", step: 3, next: { text: "First meeting", due: "2026-10-20" } },
    "draft:x": { status: "sent" },
  });
  const n = nextFor(r, D("2026-10-08"));
  assert.equal(n.zone, "story");
  assert.match(n.text, /still needs evidence/);
  // a step due today still comes first
  const r2 = records({
    settings: { round: { set: true } },
    "question:pmf": { status: "ready" }, "question:big": { status: "ready" }, "question:pay": { status: "ready" },
    "investor:a": { name: "Dana", step: 3, next: { text: "First meeting", due: "2026-10-08" } },
    "draft:x": { status: "sent" },
  });
  assert.equal(nextFor(r2, D("2026-10-08")).zone, "investors");
});

test("a follow-up request from a meeting asks for the draft in To send", () => {
  const r = records({
    settings: { round: { set: true } },
    "question:pmf": { status: "ready" }, "question:big": { status: "ready" }, "question:pay": { status: "ready" },
    "investor:a": { name: "Dana", step: 3 },
    "draft:x": { status: "sent" }, "draft:y": { kind: "followup", investor: "a", status: "requested" },
  });
  const n = nextFor(r, D("2026-10-08"));
  assert.equal(n.zone, "send");
  assert.match(n.text, /Dana/);
});

test("questions: yours until written, drafted ones need evidence until ready", () => {
  const r = records({ "question:why": { answer: "We ran restaurants." }, "question:pmf": { status: "ready", answer: "x" }, "question:big": { answer: "y" } });
  assert.equal(questionStatus(r, "why"), "ready");
  assert.equal(questionStatus(r, "now"), "yours");
  assert.equal(questionStatus(r, "pmf"), "ready");
  assert.equal(questionStatus(r, "big"), "ready");
  assert.equal(questionStatus(r, "pay"), "needs");
});

test("also waiting names the quietest investor", () => {
  const r = records({
    "investor:a": { name: "Dana", step: 4, lastContact: "2026-09-25" },
    "investor:b": { name: "Ellis Rowe", step: 4, lastContact: "2026-09-18" },
    "investor:c": { name: "Ana", step: 4, lastContact: "2026-10-05" },
  });
  assert.equal(alsoWaiting(r, D("2026-10-08")), "Ellis Rowe has been quiet 20 days");
  assert.equal(alsoWaiting(records({ "investor:c": { name: "Ana", step: 4, lastContact: "2026-10-05" } }), D("2026-10-08")), null);
});

test("every field note shows somewhere, and each phase has three This week notes", () => {
  assert.equal(GUIDE.length, 25);
  const shown = new Set([...Object.values(STEP_NOTE), ...Object.values(DRAFT_NOTE), ...Object.values(READING_NOTE), "p4", "p5", "p2"]);
  for (let ph = 0; ph < 4; ph++) assert.equal(weekNotes(ph).length, 3);
  for (const g of GUIDE) assert.ok(shown.has(g.id) || g.week, g.id);
  for (const g of GUIDE) assert.ok(/^Paraphrasing /.test(g.src) || g.id === "b4", g.id);
  assert.deepEqual(new Set(GUIDE.map((g) => g.id)).size, 25);
  for (const id of [...Object.values(STEP_NOTE), ...Object.values(DRAFT_NOTE), ...Object.values(READING_NOTE)]) assert.ok(GUIDE.some((g) => g.id === id), id);
});

test("the week's notes are the ones the spec names, and unread ones are counted", () => {
  assert.deepEqual(weekNotes(0).map((g) => g.id).sort(), ["p1", "p2", "p5"]);
  assert.deepEqual(weekNotes(1).map((g) => g.id).sort(), ["m1", "m4", "m5"]);
  assert.deepEqual(weekNotes(2).map((g) => g.id).sort(), ["c1", "c2", "c4"]);
  assert.deepEqual(weekNotes(3).map((g) => g.id).sort(), ["b1", "b3", "b4"]);
  assert.equal(unreadWeek(records({}), 1), 3);
  assert.equal(unreadWeek(records({ read: { m1: true, m4: true } }), 1), 1);
  assert.equal(unreadWeek(records({ read: { m1: true, m4: true, m5: true } }), 1), 0);
});

test("the notes carry their sources, and the five questions their own", () => {
  assert.equal(GUIDE.find((g) => g.id === "p4").src, "Paraphrasing Paul Graham, “How to Raise Money”, and Scott Kupor, Secrets of Sand Hill Road");
  assert.equal(GUIDE.find((g) => g.id === "b4").src, "Widely reported by founders; not from one book");
  assert.equal(GUIDE.find((g) => g.id === "b3").src, "Paraphrasing Jason Calacanis, Angel");
  assert.equal(WHY_THEY_ASK.length, 5);
  for (const q of WHY_THEY_ASK) assert.match(q.src, /^Paraphrasing /);
  assert.equal(STEPS.length, 9);
  assert.equal(PHASES.length, 4);
});

test("readings move the step", () => {
  assert.equal(applyReading({ step: 3 }, "next", "2026-10-02").step, 4);
  assert.equal(applyReading({ step: 3 }, "intro", "2026-10-02").step, 3);
  assert.equal(applyReading({ step: 3 }, "pass", "2026-10-02").passed, true);
  assert.equal(applyReading({ step: 3 }, "maybe", "2026-10-02").step, 3);
  assert.equal(applyReading({ step: 1 }, "intro", "2026-10-02").step, 3);
  assert.equal(applyReading({ step: 8 }, "next", "2026-10-02").step, 8);
  const was = { step: 3, lastContact: "2026-10-01" };
  const now = applyReading(was, "next", "2026-10-02");
  assert.equal(now.lastContact, "2026-10-02");
  assert.equal(now.dates[4], "2026-10-02");
  assert.equal(was.step, 3);
});

test("from Discovery: counts across markets, the strongest quote, sharpened bets", () => {
  const d = {
    "market:m": { name: "Restaurants", bet: { v: 2 } },
    "call:1": { market: "m", person: "p1", level: 5, quote: "Friday a cook no-showed", consent: "yes" },
    "call:2": { market: "m", person: "p2", level: 2 },
    "call:3": { market: "m", person: "p3", level: 4, commitment: { what: "pilot", status: "made" } },
    "person:p1": { name: "Lucia" },
  };
  const f = fromDiscovery(d, D("2026-10-01"));
  assert.deepEqual([f.calls, f.hot, f.commits, f.sharpened, f.any], [3, 2, 1, 1, true]);
  assert.deepEqual(f.quote, { text: "Friday a cook no-showed", who: "Lucia" });
  assert.equal(fromDiscovery({}, 0).any, false);
  assert.equal(fromDiscovery(undefined, 0).quote, null);
});

test("from Discovery: a lapsed or broken commitment doesn't count, nor does a call with no person", () => {
  const d = {
    "call:1": { market: "m", person: "p1", level: 4, commitment: { what: "pilot", status: "lapsed" } },
    "call:2": { market: "m", person: "p2", level: 5, commitment: { what: "pilot", status: "made", due: "2026-08-01" } },
    "call:3": { market: "m", level: 5 },
  };
  const f = fromDiscovery(d, D("2026-10-01"));
  assert.deepEqual([f.calls, f.hot, f.commits], [2, 2, 0]);
});

test("records sorts the store by kind and reads the read map", () => {
  const r = records({ settings: { x: 1 }, "investor:a": { name: "A" }, "draft:d": { kind: "cold" }, "meeting:m": {}, "question:q": {}, read: { p1: true } });
  assert.equal(r.investors[0].id, "a");
  assert.equal(r.drafts[0].id, "d");
  assert.equal(r.meetings.length, 1);
  assert.equal(r.questions.length, 1);
  assert.deepEqual(r.read, { p1: true });
  assert.deepEqual(records(undefined).read, {});
});
