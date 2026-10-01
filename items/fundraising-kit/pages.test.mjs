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
