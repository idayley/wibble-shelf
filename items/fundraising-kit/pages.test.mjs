// The pages' own rules, run under node against each page's <script id="logic">
// block, after core -- so what is tested is what ships. Also checks that
// every page's copy of core.js is the real one (sync-core.mjs keeps it so).
//
//   node --test items/fundraising-kit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("./", import.meta.url);
const core = readFileSync(new URL("core.js", dir), "utf8").replace(/\s+$/, "");
const pageFiles = readdirSync(dir).filter((n) => n.endsWith(".html"));
const pagesWithCore = pageFiles.filter((f) => /<script id="core">/.test(readFileSync(new URL(f, dir), "utf8")));

function block(file, id) {
  const html = readFileSync(new URL(file, dir), "utf8");
  const m = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`));
  return m ? m[1] : null;
}

function logic(file, names) {
  const l = block(file, "logic");
  assert.ok(l, `${file} has a <script id="logic"> block`);
  return new Function(`${core}\n${l}\nreturn { ${names.join(", ")} };`)();
}

test("the app pages carry core.js, byte for byte", () => {
  assert.ok(pagesWithCore.includes("progress.html"));
  for (const f of pagesWithCore) {
    assert.equal(block(f, "core").trim(), core.trim(), `${f}: run node items/fundraising-kit/sync-core.mjs`);
    assert.ok(block(f, "logic"), `${f} has a <script id="logic"> block`);
    const html = readFileSync(new URL(f, dir), "utf8");
    assert.ok(html.indexOf('id="core"') < html.indexOf('id="logic"'), `${f}: core comes before logic`);
  }
});

test("no page uses an em dash, and notes lead with Why:", () => {
  for (const f of pageFiles) {
    const html = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(html, /—/, `${f} has an em dash`);
    if (f.startsWith("note-")) {
      assert.match(html, /<b class="why">Why:<\/b>/, `${f} has a Why: line`);
      const body = html.slice(html.indexOf("<body>"));
      const first = body.match(/<p>([\s\S]*?)<\/p>/)[1];
      assert.match(first, /^<b class="why">Why:<\/b>/, `${f} leads with Why:`);
    }
  }
  assert.doesNotMatch(readFileSync(new URL("core.js", dir), "utf8"), /—/);
  assert.deepEqual(pageFiles.filter((f) => f.startsWith("note-")).sort(), ["note-investors.html", "note-meetings.html", "note-send.html", "note-story.html"]);
});

test("the field notes on the zone notes are the guide's own, with their sources", () => {
  const L = new Function(`${core}\nreturn { GUIDE };`)();
  const norm = (s) => s.replace(/&amp;/g, "&");
  for (const [file, id] of [["note-send.html", "p1"], ["note-meetings.html", "m6"]]) {
    const html = readFileSync(new URL(file, dir), "utf8");
    const g = L.GUIDE.find((x) => x.id === id);
    assert.ok(norm(html).includes(g.text), `${file} carries ${id}'s text`);
    assert.ok(norm(html).includes(g.src), `${file} carries ${id}'s source`);
  }
});

test("kit.json: zones, pages and the Discovery read agree", () => {
  const kit = JSON.parse(readFileSync(new URL("kit.json", dir), "utf8"));
  assert.deepEqual(kit.reads, ["discovery-kit"]);
  assert.deepEqual(kit.zones.map((z) => z.key), ["progress", "story", "investors", "send", "meetings"]);
  assert.equal(kit.items.length, 3);
  const keys = new Set(kit.zones.map((z) => z.key));
  for (const p of kit.pages) {
    assert.ok(keys.has(p.zone), `${p.file} is in a real zone`);
    assert.ok(pageFiles.includes(p.file) || ["story.html", "investors.html", "send.html", "meetings.html"].includes(p.file), `${p.file} exists or is yet to come`);
  }
  for (const z of kit.zones.filter((z) => z.rule)) assert.ok(kit.items.some((i) => i.id === z.rule.run.agent), `${z.key} runs one of the kit's agents`);
});

// ---- the progress strip ----------------------------------------------------

const S = logic("progress.html", ["view", "shouldMark", "peekPatch", "openNotePatch", "withStart", "rangeLabel", "weeksLine", "dayLabel"]);
const D = (s) => Date.parse(s + "T12:00:00");
const round = { start: "2026-10-01", closeBy: "2026-11-30", mustClose: "2026-12-15" };

test("strip: Oct 21 is the first day of Meetings, with its new notes counted", () => {
  const v = S.view({ settings: { round } }, undefined, D("2026-10-21"));
  assert.deepEqual(v.phases.map((p) => p.state), ["done", "now", "later", "later"]);
  assert.deepEqual(v.phases.map((p) => p.dates), ["Oct 1–20", "Oct 21–Nov 15", "Nov 16–30", "Dec 1–15"]);
  assert.equal(v.phases[0].mark, "✓");
  assert.equal(v.phases[1].mark, "2");
  assert.equal(v.phases[1].newLine, "New this week: 3 field notes →");
  assert.equal(v.phases[0].newLine, "");
  assert.equal(v.today, "Today · Oct 21");
  assert.equal(v.weeksLeft, "7 weeks to Dec 15");
  assert.equal(S.view({ settings: { round } }, undefined, D("2026-10-20")).weeksLeft, "8 weeks to Dec 15");
});

test("strip: the new line counts down as the week's notes are read, and goes when all are", () => {
  const read = (ids) => Object.fromEntries(ids.map((i) => [i, true]));
  const at = (ids) => S.view({ settings: { round }, read: read(ids) }, undefined, D("2026-10-21")).phases[1].newLine;
  assert.equal(at(["m1"]), "New this week: 2 field notes →");
  assert.equal(at(["m1", "m4"]), "New this week: 1 field note →");
  assert.equal(at(["m1", "m4", "m5"]), "");
  assert.equal(at(["m2", "m3"]), "New this week: 3 field notes →");
});

test("strip: next zone is investors on an empty store, with the three starting moves", () => {
  const v = S.view({}, undefined, D("2026-10-01"));
  assert.equal(v.next.zone, "investors");
  assert.equal(v.next.cap, "START HERE · 0 OF 3 DONE");
  assert.deepEqual(v.start.map((k) => k.label), ["Add the investors you know", "Set the round", "Fill answers from Discovery"]);
  assert.equal(v.today, "Today · Oct 1");
  assert.equal(v.weeksLeft, "10 weeks to Dec 15");
  assert.equal(v.phases[0].state, "now");
  assert.equal(v.also, null);
  assert.equal(v.needsStart, true);
  assert.equal(S.view({ settings: { round } }, undefined, D("2026-10-01")).needsStart, false);
});

test("strip: Also waiting names a quiet investor, and the start list goes after day one", () => {
  const data = {
    settings: { round: { ...round, set: true } },
    "question:pmf": { status: "ready" }, "question:big": { status: "ready" }, "question:pay": { status: "ready" },
    "investor:a": { name: "Dana", step: 4, lastContact: "2026-10-01", next: { text: "Send news", due: "2026-10-30" } },
    "investor:e": { name: "Ellis Rowe", step: 4, lastContact: "2026-10-02" },
    "draft:x": { status: "sent" },
  };
  const v = S.view(data, undefined, D("2026-10-14"));
  assert.equal(v.also, "Ellis Rowe has been quiet 12 days");
  assert.equal(v.start, null);
  assert.equal(v.next.cap, "NEXT FOR YOU");
});

test("strip: weeks left and range labels read plainly", () => {
  assert.equal(S.weeksLine(round, D("2026-12-10")), "5 days to Dec 15");
  assert.equal(S.weeksLine(round, D("2026-12-14")), "1 day to Dec 15");
  assert.equal(S.weeksLine(round, D("2026-12-20")), "Past Dec 15");
  assert.equal(S.rangeLabel("2026-10-01", "2026-10-20"), "Oct 1–20");
  assert.equal(S.rangeLabel("2026-10-21", "2026-11-15"), "Oct 21–Nov 15");
});

test("strip: a phase click reads ahead, today's phase or a second click goes back", () => {
  const now = D("2026-10-21");
  const s0 = { round };
  assert.equal(S.peekPatch(s0, 2, now).peek, 2);
  assert.equal(S.peekPatch({ ...s0, peek: 2 }, 2, now).peek, null);
  assert.equal(S.peekPatch({ ...s0, peek: 2 }, 1, now).peek, null);
  assert.equal(S.peekPatch({ ...s0, peek: 2 }, 3, now).peek, 3);
  assert.deepEqual(S.peekPatch({ round, other: 1 }, 3, now).round, round);
  assert.equal(S.peekPatch({ round, other: 1 }, 3, now).other, 1);
  assert.equal(S.view({ settings: { round, peek: 3 } }, undefined, now).phases[3].peeking, true);
  assert.equal(S.view({ settings: { round, peek: 1 } }, undefined, now).phases[1].peeking, false);
});

test("strip: the New this week line opens the first unread note and goes back to today", () => {
  const now = D("2026-10-21");
  const p = S.openNotePatch({ settings: { round, peek: 3 } }, now);
  assert.equal(p.openNote, "m1");
  assert.equal(p.peek, null);
  assert.equal(S.openNotePatch({ settings: { round }, read: { m1: true } }, now).openNote, "m4");
  assert.equal(S.openNotePatch({ settings: { round }, read: { m1: true, m4: true, m5: true } }, now).openNote, null);
});

test("strip: the start day is kept the first time, without touching the rest of the round", () => {
  const p = S.withStart({ round: { amount: "500k" }, peek: 1 }, D("2026-10-05"));
  assert.deepEqual(p.round, { amount: "500k", start: "2026-10-05" });
  assert.equal(p.peek, 1);
  assert.equal(S.withStart({}, D("2026-10-05")).round.start, "2026-10-05");
});

test("strip: marks only when the next zone changes", () => {
  assert.equal(S.shouldMark(null, "investors"), true);
  assert.equal(S.shouldMark("investors", "investors"), false);
  assert.equal(S.shouldMark("investors", "story"), true);
  assert.equal(S.shouldMark("investors", null), false);
});

// ---- Story -----------------------------------------------------------------

const ST = logic("story.html", ["guideView", "questionsView", "answerRecord", "roundView", "roundPatch", "roundIssue", "learnedView", "fillCard", "peekOf", "zoneFor", "records", "fromDiscovery", "roundOf", "phaseAt", "DISCOVERY_EMPTY"]);

test("story: the guide counts what is read, and shows This week or Reading ahead", () => {
  const r = ST.records({ read: { p1: true, m1: true, zz: true } });
  const g = ST.guideView(r, 0, null);
  assert.equal(g.total, 25);
  assert.equal(g.readCount, 2);
  assert.equal(g.readLine, "2 of 25 read");
  assert.equal(g.pct, 8);
  assert.equal(g.peeking, false);
  assert.equal(g.cap, "THIS WEEK · PREPARE");
  assert.deepEqual(g.notes.map((n) => n.id), ["p1", "p2", "p5"]);
  assert.equal(g.notes[0].read, true);
  assert.equal(g.notes[1].read, false);
  assert.equal(g.notes[2].also, "also in The round");
  assert.equal(ST.guideView(r, 1, null).notes[0].also, "");
  assert.equal(g.notes[0].also, "also in the monthly update");
  const ahead = ST.guideView(r, 0, 1);
  assert.equal(ahead.peeking, true);
  assert.equal(ahead.cap, "READING AHEAD · MEETINGS");
  assert.deepEqual(ahead.notes.map((n) => n.id), ["m1", "m4", "m5"]);
  assert.equal(ST.guideView(r, 1, 1).peeking, false);
  assert.equal(ST.guideView(r, 1, 9).shown, 1);
  assert.equal(ST.guideView(r, 1, null).phases.length, 4);
  assert.equal(ST.guideView(r, 1, null).phases.reduce((n, p) => n + p.notes.length, 0), 25);
  assert.equal(ST.guideView(r, 0, null).phases[0].readLine, "1 of 7 read");
});

test("story: See all carries each phase's dates when given the round", () => {
  const round = ST.roundOf({ round: { start: "2026-10-01" } }, D("2026-10-01"));
  assert.equal(ST.guideView(ST.records({}), 0, null, round).phases[1].dates, "Oct 21–Nov 15");
  assert.equal(ST.guideView(ST.records({}), 0, null).phases[1].dates, "");
});

test("story: hard questions are ready, need evidence or are yours to write", () => {
  const none = ST.questionsView(ST.records({}), undefined);
  assert.deepEqual(none.items.map((i) => [i.id, i.status]), [["pmf", "needs"], ["big", "needs"], ["pay", "needs"], ["why", "yours"], ["now", "yours"]]);
  assert.equal(none.readyLine, "0 of 5 ready");
  assert.equal(none.items[0].label, "Needs evidence");
  assert.equal(none.items[3].label, "Yours to write");
  const r = ST.records({
    "question:pmf": { text: "Do you have product-market fit?", answer: "Not yet.", status: "ready", evidence: "24 calls" },
    "question:big": { answer: "x", status: "needs" },
    "question:why": { answer: "We lived it." },
    "question:fees": { text: "What are your fees?", source: "meeting", status: "needs" },
  });
  const v = ST.questionsView(r, undefined);
  assert.deepEqual(v.items.map((i) => [i.id, i.status]), [["pmf", "ready"], ["big", "needs"], ["pay", "needs"], ["why", "ready"], ["now", "yours"], ["fees", "needs"]]);
  assert.equal(v.items[0].evidence, "24 calls");
  assert.equal(v.items[5].text, "What are your fees?");
  assert.equal(v.items[5].src, "Raised in a meeting");
  assert.equal(v.items[5].meeting, true);
  assert.equal(v.readyLine, "2 of 6 ready");
});

test("story: Fill answers is disabled, with a reason, until Discovery has a scored call", () => {
  const r = ST.records({});
  assert.equal(ST.questionsView(r, undefined).fill.disabled, true);
  assert.equal(ST.questionsView(r, ST.fromDiscovery({}, 0)).fill.disabled, true);
  assert.match(ST.questionsView(r, undefined).fill.reason, /Discovery/);
  const d = ST.fromDiscovery({ "call:1": { person: "p", level: 4 } }, D("2026-10-01"));
  const on = ST.questionsView(r, d);
  assert.equal(on.fill.disabled, false);
  assert.equal(on.fill.reason, "");
  assert.deepEqual(ST.fillCard({ story: "z9" }), { zone: "z9", title: "Fill answers", text: "Draft answers to the hard questions from Discovery." });
  assert.equal(ST.fillCard(undefined).zone, "story");
});

test("story: an edited answer is saved ready, and clearing it goes back", () => {
  const r = ST.records({ "question:big": { text: "How big can this get?", answer: "x", status: "needs", evidence: "e" } });
  const a = ST.answerRecord(r, "big", "  Restaurants first.  ");
  assert.deepEqual(a, { text: "How big can this get?", answer: "Restaurants first.", status: "ready", evidence: "e", source: "asked" });
  assert.equal(ST.answerRecord(r, "big", "").status, "needs");
  const w = ST.answerRecord(ST.records({}), "why", "Because.");
  assert.deepEqual(w, { text: "Why are you two the ones to build this?", answer: "Because.", status: "ready", source: "asked" });
  assert.equal("status" in ST.answerRecord(ST.records({ "question:why": { answer: "a", status: "ready" } }), "why", ""), false);
  assert.equal("id" in ST.answerRecord(r, "big", "z"), false);
});

test("story: the round shows placeholders until set, and Save merges, keeping the start", () => {
  const rv = ST.roundView({ round: { start: "2026-10-01" } }, D("2026-10-01"));
  assert.equal(rv.set, false);
  assert.deepEqual(rv.rows.map((x) => x.dd), ["[YOUR AMOUNT] on a post-money SAFE", "[YOUR CAP]", "[MONTHS] of runway to reach product-market fit", "Nov 30"]);
  assert.equal(rv.rows[3].after, "must close Dec 15");
  const patch = ST.roundPatch({ round: { start: "2026-10-01" }, peek: 2, tab: "warm" }, { amount: " $500k ", cap: "$8M", months: "18", closeBy: "2026-11-20", mustClose: "2026-12-10" }, D("2026-10-05"));
  assert.deepEqual(patch.round, { start: "2026-10-01", amount: "$500k", cap: "$8M", months: "18", closeBy: "2026-11-20", mustClose: "2026-12-10", set: true });
  assert.equal(patch.peek, 2);
  assert.equal(patch.tab, "warm");
  const after = ST.roundView(patch, D("2026-10-05"));
  assert.equal(after.set, true);
  assert.deepEqual(after.rows.map((x) => x.dd), ["$500k on a post-money SAFE", "$8M", "18 months of runway to reach product-market fit", "Nov 20"]);
  // With no start yet, today is kept, as the strip would.
  assert.equal(ST.roundPatch({}, { closeBy: "bad" }, D("2026-10-05")).round.start, "2026-10-05");
  assert.equal("closeBy" in ST.roundPatch({}, { closeBy: "bad" }, D("2026-10-05")).round, false);
});

test("story: the round's dates are checked before saving", () => {
  assert.equal(ST.roundIssue({ closeBy: "2026-11-30", mustClose: "2026-12-15" }), "");
  assert.match(ST.roundIssue({ closeBy: "2026-12-15", mustClose: "2026-11-30" }), /after close by/);
  assert.match(ST.roundIssue({ closeBy: "", mustClose: "2026-11-30" }), /Close by/);
  assert.match(ST.roundIssue({ closeBy: "2026-11-30", mustClose: "" }), /Must close/);
});

test("story: What we've learned has its empty state, and bars as shares of the calls", () => {
  assert.equal(ST.learnedView(undefined).empty, true);
  assert.equal(ST.learnedView(ST.fromDiscovery({}, 0)).text, "Nothing from Discovery yet. Calls you score in the Discovery kit on this canvas show here.");
  const d = {};
  for (let i = 0; i < 24; i++) d["call:" + i] = { person: "p" + i, level: i < 7 ? 4 : 2, commitment: i < 3 ? { what: "pilot", status: "made" } : undefined, quote: i === 0 ? "Friday a cook no-showed." : "" };
  d["person:p0"] = { name: "Lucia Ferro" };
  const v = ST.learnedView(ST.fromDiscovery(d, D("2026-10-01")));
  assert.equal(v.empty, false);
  assert.deepEqual(v.rows.map((x) => [x.label, x.n, x.filled]), [["Customer calls", 24, 12], ["Hair on fire (4–5)", 7, 4], ["Commitments", 3, 2]]);
  assert.deepEqual(v.quote, { text: "Friday a cook no-showed.", who: "Lucia Ferro" });
  assert.match(v.sharpened, /hasn’t been sharpened/);
  assert.match(ST.learnedView(ST.fromDiscovery({ ...d, "market:m": { bet: { v: 2 } } }, D("2026-10-01"))).sharpened, /sharpened once/);
});

// ---- Investors ---------------------------------------------------------------

const IV = logic("investors.html", ["rowsView", "detailView", "draftKind", "draftLabel", "namesIn", "newInvestors", "passInvestor", "findCard", "draftCard", "nextView", "kindLine", "connectorOf", "records", "advanceStep", "noteIdFor"]);
const NOW = D("2026-10-14");
const inv = (o) => ({ name: "Dana Whitfield", how: "know", step: 0, ...o });
const store = {
  "investor:np": inv({ name: "Priya Shah", firm: "Northloop", kind: "fund", stage: "pre-seed", leads: true, check: "$250–500k", how: "warm", step: 0, next: { text: "Ask Jon Park for the intro", due: "2026-10-14" } }),
  "investor:dw": inv({ step: 3, next: { text: "First meeting Thursday", due: "2026-10-16" }, lastContact: "2026-10-12" }),
  "investor:er": inv({ name: "Ellis Rowe", step: 4, lastContact: "2026-10-02" }),
  "investor:ml": inv({ name: "Marcus Lee", how: "cold", step: 0 }),
  "investor:kb": inv({ name: "Keisha Brown", how: "warm", step: 2, next: { text: "Book a first meeting", due: "2026-10-18" } }),
  "investor:tb": inv({ name: "Tom Becker", step: 3, passed: true, passedAt: "2026-09-24", bar: "come back with revenue" }),
};

test("investors: tab counts, and each tab's rows", () => {
  const r = IV.records(store);
  const all = IV.rowsView(r, "all", NOW);
  assert.deepEqual(all.tabs.map((t) => [t.key, t.n, t.on]), [["all", 5, true], ["know", 2, false], ["warm", 2, false], ["cold", 1, false], ["passed", 1, false]]);
  assert.equal(all.total, 6);
  assert.deepEqual(all.rows.map((x) => x.id), ["np", "dw", "kb", "er", "ml"]);
  assert.deepEqual(IV.rowsView(r, "warm", NOW).rows.map((x) => x.id), ["np", "kb"]);
  assert.deepEqual(IV.rowsView(r, "passed", NOW).rows.map((x) => x.id), ["tb"]);
  assert.equal(IV.rowsView(r, "all", NOW).rows[0].filled, 1);
  assert.equal(IV.rowsView(r, "all", NOW).rows[1].stage, "First meeting");
  assert.equal(all.rows[0].kind, "Northloop · pre-seed fund · leads · $250–500k");
  assert.equal(all.rows[0].howLabel, "Warm");
});

test("investors: a quiet investor reads Quiet n days, send news", () => {
  const r = IV.records(store);
  const er = IV.rowsView(r, "all", NOW).rows.find((x) => x.id === "er");
  assert.equal(er.next, "Quiet 12 days · send news");
  assert.equal(er.tone, "quiet");
  assert.equal(er.cells, "quiet");
  const np = IV.rowsView(r, "all", NOW).rows.find((x) => x.id === "np");
  assert.equal(np.next, "Ask Jon Park for the intro · today");
  assert.equal(np.tone, "hot");
  const tb = IV.rowsView(r, "passed", NOW).rows[0];
  assert.equal(tb.next, "Passed · on the monthly update");
  assert.equal(tb.stage, "Passed");
  assert.equal(IV.nextView({ step: 1 }, NOW).text, "Waiting for the intro");
  assert.equal(IV.nextView({ step: 3, next: { text: "Send the deck", due: "2026-10-20" } }, NOW).text, "Send the deck · by Oct 20");
});

test("investors: the draft kind follows the step and how; quiet comes first", () => {
  const k = (o) => IV.draftKind(inv(o), NOW);
  assert.equal(k({ step: 0, how: "warm" }), "intro");
  assert.equal(k({ step: 0, how: "cold" }), "cold");
  assert.equal(k({ step: 0, how: "know" }), "direct");
  assert.equal(k({ step: 1 }), null);
  assert.equal(k({ step: 2 }), "reply");
  assert.equal(k({ step: 3 }), "prep");
  assert.equal(k({ step: 4 }), "followup");
  assert.equal(k({ step: 5 }), null);
  assert.equal(k({ step: 4, lastContact: "2026-10-01" }), "checkin");
  assert.equal(k({ step: 3, passed: true }), null);
  assert.equal(IV.draftLabel(inv({ how: "warm", next: { text: "Ask Jon Park for the intro", due: "2026-10-14" } }), "intro"), "Draft intro request to Jon Park");
  assert.equal(IV.draftLabel(inv({}), "direct"), "Draft a note to Dana");
  assert.equal(IV.draftLabel(inv({ how: "cold" }), "cold"), "Draft a cold note");
  assert.equal(IV.draftLabel(inv({}), "prep"), "Draft a prep sheet");
});

test("investors: the detail's note per step, plus quiet and passed", () => {
  const r = IV.records({ ...store, read: { m3: true } });
  const note = (id) => IV.detailView(r.investors.find((i) => i.id === id), r, NOW).note;
  assert.equal(note("np").id, "p3");
  assert.equal(note("kb").id, "m2");
  assert.equal(note("dw").id, "m3");
  assert.equal(note("dw").read, true);
  assert.equal(note("np").read, false);
  assert.equal(note("er").id, "m8");
  assert.equal(note("tb").id, "b1");
  const steps = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((s) => IV.noteIdFor({ step: s }, NOW));
  assert.deepEqual(steps, ["p3", "p6", "m2", "m3", "m5", "m7", "c2", "c3", "c5"]);
});

test("investors: the detail's timeline, move button and the draft that lands in To send", () => {
  const r = IV.records({ ...store, "investor:dw": inv({ step: 3, dates: { 0: "2026-09-22", 3: "2026-10-12" }, next: { text: "First meeting Thursday", due: "2026-10-16" }, lastContact: "2026-10-12" }) });
  const d = IV.detailView(r.investors.find((i) => i.id === "dw"), r, NOW);
  assert.equal(d.timeline.length, 9);
  assert.deepEqual(d.timeline.slice(0, 5).map((t) => t.state), ["done", "done", "done", "now", "later"]);
  assert.equal(d.timeline[0].when, "Sep 22");
  assert.equal(d.timeline[3].label, "First meeting · now");
  assert.equal(d.move.label, "Move to Follow-up");
  assert.deepEqual(d.draft, { kind: "prep", title: "Prep sheet · Dana Whitfield", label: "Draft a prep sheet", pending: null });
  assert.deepEqual(IV.draftCard(r.investors.find((i) => i.id === "dw"), "prep", undefined), { zone: "send", title: "Prep sheet · Dana Whitfield", text: "investor: dw" });
  const tb = IV.detailView(r.investors.find((i) => i.id === "tb"), r, NOW);
  assert.equal(tb.passed, true);
  assert.equal(tb.move, null);
  assert.equal(tb.draft, null);
  assert.equal(tb.timeline[tb.timeline.length - 1].label, "Passed · keep updated");
  assert.equal(tb.timeline.length, 5);
  assert.match(tb.nextFull, /come back with revenue/);
  assert.equal(tb.path, "Passed Sep 24: “come back with revenue”");
});

test("investors: a waiting or requested draft replaces the Draft button", () => {
  const mk = (extra) => IV.records({ ...store, ...extra });
  const dw = (r) => IV.detailView(r.investors.find((i) => i.id === "dw"), r, NOW);
  assert.equal(dw(mk({ "draft:a": { kind: "prep", investor: "dw", status: "new" } })).draft.pending, "waiting");
  assert.equal(dw(mk({ "draft:a": { kind: "prep", investor: "dw", status: "sent" } })).draft.pending, null);
  assert.equal(dw(mk({ "draft:a": { kind: "followup", investor: "dw", status: "requested" } })).draft.pending, "requested");
  assert.equal(dw(mk({ "draft:a": { kind: "prep", investor: "someone-else", status: "new" } })).draft.pending, null);
});

test("investors: pasted names become step-0 records, once each, with unique keys", () => {
  const r = IV.records({ "investor:dana-whitfield": { name: "Dana Whitfield" } });
  const names = IV.namesIn("Dana Whitfield\n  Ellis   Rowe \n\nellis rowe\nTom Becker\r\n", r);
  assert.deepEqual(names, ["Ellis Rowe", "Tom Becker"]);
  const list = IV.newInvestors(["Ellis Rowe", "Dana Whitfield"], { "investor:dana-whitfield": {} }, NOW);
  assert.deepEqual(list.map((p) => p[0]), ["investor:ellis-rowe", "investor:dana-whitfield-2"]);
  assert.deepEqual(list[0][1], { name: "Ellis Rowe", how: "know", step: 0, dates: { 0: "2026-10-14" }, next: { text: "Reach out this week", due: "2026-10-16" } });
});

test("investors: moving by hand and passing write the day, and drop the old next step", () => {
  const i = inv({ step: 3, next: { text: "x", due: "2026-10-20" }, dates: { 3: "2026-10-01" } });
  const m = IV.advanceStep(i, "2026-10-14");
  assert.deepEqual([m.step, m.lastContact, m.dates[4], "next" in m], [4, "2026-10-14", "2026-10-14", false]);
  const p = IV.passInvestor(i, "2026-10-14");
  assert.deepEqual([p.passed, p.passedAt, p.lastContact, p.step, "next" in p], [true, "2026-10-14", "2026-10-14", 3, false]);
});

test("investors: Find investors lands the source and what was typed", () => {
  assert.deepEqual(IV.findCard("web", "  seed funds for restaurants ", { investors: "z2" }), { zone: "z2", title: "Find investors", text: "web: seed funds for restaurants" });
  assert.equal(IV.findCard("know", "", undefined).zone, "investors");
  assert.equal(IV.findCard("know", "", undefined).text, "know: (nothing added)");
});

// ---- To send -----------------------------------------------------------------

const TS = logic("send.html", ["draftsView", "sentPatch", "metPatch", "requestCard", "records"]);
const sendStore = {
  "investor:np": { name: "Priya Shah", step: 0, how: "warm", next: { text: "Ask Jon", due: "2026-10-14" } },
  "investor:dw": { name: "Dana Whitfield", step: 3, how: "know", dates: { 3: "2026-10-12" } },
  "investor:er": { name: "Ellis Rowe", step: 4, how: "know", lastContact: "2026-10-02" },
  "draft:a": { kind: "intro", investor: "np", to: "Jon Park", text: "Jon, would you be comfortable...", meta: "Ask first, forward second", note: "p6", advances: true, status: "new", at: "2026-10-10" },
  "draft:b": { kind: "prep", investor: "dw", lines: [{ b: "Who:", t: "ex-founder." }, { b: "End:", t: "ask for a date." }], note: "m4", status: "new", at: "2026-10-12" },
  "draft:c": { kind: "checkin", investor: "er", text: "Hi Ellis", note: "m8", advances: false, status: "new", opened: true, at: "2026-10-11" },
  "draft:d": { kind: "update", text: "Learned...", lines: [{ b: "Learned:", t: "24 calls." }], status: "sent", at: "2026-10-01" },
  "draft:e": { kind: "followup", investor: "dw", status: "requested" },
};

test("to send: drafts come newest first, a follow-up request first of all, with who, new and copy", () => {
  const v = TS.draftsView(TS.records(sendStore));
  assert.equal(v.count, 5);
  assert.deepEqual(v.items.map((i) => i.id), ["e", "b", "c", "a", "d"]);
  const e = v.items[0], b = v.items[1], a = v.items.find((i) => i.id === "a"), c = v.items.find((i) => i.id === "c"), d = v.items.find((i) => i.id === "d");
  assert.equal(e.label, "Follow-up requested");
  assert.equal(e.action, "draft");
  assert.equal(e.actionLabel, "Draft");
  assert.equal(e.canCopy, false);
  assert.equal(e.isNew, false);
  assert.equal(b.label, "Prep sheet");
  assert.equal(b.action, "met");
  assert.equal(b.canCopy, false);
  assert.equal(b.copyText, "Who: ex-founder.\nEnd: ask for a date.");
  assert.equal(a.who, "Jon Park → Priya Shah");
  assert.equal(a.isNew, true);
  assert.equal(c.isNew, false);
  assert.equal(a.actionLabel, "Sent");
  assert.equal(a.note.id, "p6");
  assert.equal(d.who, "Everyone");
  assert.equal(d.sent, true);
  assert.equal(d.action, null);
  assert.equal(d.done, "Sent");
  assert.equal(d.isNew, false);
});

test("to send: a draft with no note id falls back to its kind's note, and empty has its text", () => {
  const v = TS.draftsView(TS.records({ "draft:x": { kind: "cold", text: "hi", status: "new" } }));
  assert.equal(v.items[0].note.id, "p7");
  const dn = TS.draftsView(TS.records({ "draft:y": { kind: "direct", text: "hi", status: "new" } }));
  assert.equal(dn.items[0].note.id, "p2");
  assert.equal(dn.items[0].label, "Note");
  const e = TS.draftsView(TS.records({}));
  assert.equal(e.empty, true);
  assert.equal(e.text, "Drafts land here: intro requests, follow-ups, prep sheets and your monthly update.");
});

test("to send: Sent moves the step only when the draft advances", () => {
  const r = TS.records(sendStore);
  const adv = TS.sentPatch(r, "a", D("2026-10-14"));
  assert.equal(adv.draft.status, "sent");
  assert.equal(adv.draft.sentAt, "2026-10-14");
  assert.equal("id" in adv.draft, false);
  assert.equal(adv.investor.key, "investor:np");
  assert.deepEqual([adv.investor.value.step, adv.investor.value.lastContact, adv.investor.value.dates[1], "next" in adv.investor.value], [1, "2026-10-14", "2026-10-14", false]);
  const flat = TS.sentPatch(r, "c", D("2026-10-14"));
  assert.deepEqual([flat.investor.value.step, flat.investor.value.lastContact], [4, "2026-10-14"]);
  const upd = TS.sentPatch(r, "d", D("2026-10-14"));
  assert.equal(upd.investor, null);
  assert.equal(TS.sentPatch(r, "nope", 0), null);
});

test("to send: Met on a prep sheet moves the investor to Follow-up, never backwards", () => {
  const r = TS.records(sendStore);
  const m = TS.metPatch(r, "b", D("2026-10-14"));
  assert.equal(m.draft.status, "met");
  assert.deepEqual([m.investor.value.step, m.investor.value.lastContact, m.investor.value.dates[4]], [4, "2026-10-14", "2026-10-14"]);
  const later = TS.metPatch(TS.records({ "investor:dw": { name: "D", step: 5 }, "draft:b": { kind: "prep", investor: "dw" } }), "b", D("2026-10-14"));
  assert.equal(later.investor.value.step, 5);
});

test("to send: Draft on a follow-up request lands a Follow-up card naming the investor and the request", () => {
  const v = TS.draftsView(TS.records(sendStore));
  assert.deepEqual(TS.requestCard(v.items[0], undefined), { zone: "send", title: "Follow-up · Dana Whitfield", text: "investor: dw\nrequest: e" });
  assert.equal(TS.requestCard(v.items[0], { send: "z3" }).zone, "z3");
});

// ---- Meetings ----------------------------------------------------------------

const MT = logic("meetings.html", ["meetingsView", "records"]);
const meetStore = {
  "investor:ao": { name: "Ana Okafor", kind: "scout" },
  "investor:er": { name: "Ellis Rowe", kind: "angel" },
  "investor:tb": { name: "Tom Becker", kind: "angel" },
  "investor:dw": { name: "Dana Whitfield", kind: "angel" },
  "meeting:1": { investor: "ao", at: "2026-09-19", reading: "next", quote: "Send me three customer calls.", meaning: "Concrete step with a date.", questions: ["big", "pay"] },
  "meeting:2": { investor: "er", at: "2026-09-17", reading: "maybe", quote: "Keep me posted.", meaning: "Warm words, no next step.", questions: ["big", "big"] },
  "meeting:3": { investor: "tb", at: "2026-09-18", reading: "pass", quote: "Too early.", meaning: "A clear no.", questions: ["pay", "revenue"] },
  "meeting:4": { investor: "dw", at: "2026-09-22", reading: "intro", quote: "Let's do a proper meeting.", meaning: "Booked.", questions: ["big"] },
  "question:revenue": { text: "What is your revenue?", source: "meeting", status: "needs" },
  read: { m6: true },
};

test("meetings: newest first, with the reading's label and its note", () => {
  const v = MT.meetingsView(MT.records(meetStore));
  assert.equal(v.count, 4);
  assert.deepEqual(v.items.map((i) => i.who), ["Dana Whitfield", "Ana Okafor", "Tom Becker", "Ellis Rowe"]);
  assert.deepEqual(v.items.map((i) => i.label), ["Intro call", "Real next step", "Pass", "Maybe = no for now"]);
  assert.deepEqual(v.items.map((i) => i.note.id), ["m3", "m9", "b2", "m6"]);
  assert.equal(v.items[3].note.read, true);
  assert.equal(v.items[0].when, "angel · Sep 22");
  assert.equal(v.items[1].when, "scout · Sep 19");
  assert.equal(MT.meetingsView(MT.records({ "meeting:z": { reading: "huh" } })).items[0].label, "Maybe = no for now");
});

test("meetings: what investors push on counts meetings, once each, not mentions", () => {
  const p = MT.meetingsView(MT.records(meetStore)).push;
  assert.equal(p.after, "after 4 meetings");
  assert.deepEqual(p.rows.map((x) => [x.text, x.line]), [
    ["How big can this get?", "3 of 4"], ["Will they pay, or just complain?", "2 of 4"], ["What is your revenue?", "1 of 4"]]);
  assert.match(p.line, /How big can this get\?” came up in 3 of 4\. It’s in Hard questions/);
});

test("meetings: no meetings is empty with a hint, and no counts", () => {
  const v = MT.meetingsView(MT.records({}));
  assert.equal(v.empty, true);
  assert.match(v.hint, /drop your notes or the recording here/);
  assert.equal(v.push.rows.length, 0);
  assert.equal(v.push.line, "");
  assert.equal(MT.meetingsView(MT.records({ "meeting:1": { reading: "next" } })).push.after, "after 1 meeting");
});

test("core: zones and peek helpers the pages rely on", () => {
  assert.equal(ST.zoneFor({ story: "abc" }, "story"), "abc");
  assert.equal(ST.zoneFor({ story: 5 }, "story"), "story");
  assert.equal(ST.zoneFor(null, "send"), "send");
  assert.equal(ST.peekOf({ peek: 2 }), 2);
  assert.equal(ST.peekOf({ peek: 4 }), null);
  assert.equal(ST.peekOf({ peek: "1" }), null);
});
