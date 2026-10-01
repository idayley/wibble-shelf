// The pages' own rules, run under node against each page's <script id="logic">
// block, after core -- so what is tested is what ships. Also checks that
// every page's copy of core.js is the real one (sync-core.mjs keeps it so).
//
//   node --test items/discovery-kit/

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
  assert.ok(pagesWithCore.includes("progress.html") && pagesWithCore.includes("markets.html"));
  for (const f of pagesWithCore) {
    assert.equal(block(f, "core").trim(), core.trim(), `${f}: run node items/discovery-kit/sync-core.mjs`);
    assert.ok(block(f, "logic"), `${f} has a <script id="logic"> block`);
    const html = readFileSync(new URL(f, dir), "utf8");
    assert.ok(html.indexOf('id="core"') < html.indexOf('id="logic"'), `${f}: core comes before logic`);
  }
});

test("no page uses an em dash, and notes lead with Why:", () => {
  for (const f of pageFiles) {
    const html = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(html, /—/, `${f} has an em dash`);
    if (f.startsWith("note-")) assert.match(html, /<b class="why">Why:<\/b>/, `${f} has a Why: line`);
  }
  assert.deepEqual(pageFiles.filter((f) => f.startsWith("note-")).sort(), ["note-calls.html", "note-markets.html", "note-people.html", "note-send.html"]);
});

// ---- the progress strip ----------------------------------------------------

const S = logic("progress.html", ["stepStates", "stripModel", "shouldMark", "cells"]);
const NOW = Date.parse("2026-09-30T12:00:00Z");
const bet = { v: 1, who: "Owners", pain: "Rota breaks", shown: "By hand", where: "Reddit", fromCalls: 0 };
const mk = (over = {}) => ({ name: "Restaurants", order: 0, passLine: { hits: 3, of: 10, commits: 1 }, bet, ...over });

test("strip: step states follow the current step", () => {
  assert.deepEqual(S.stepStates(2).map((s) => s.state), ["done", "done", "now", "later"]);
  assert.equal(S.stepStates(2)[0].mark, "✓");
  assert.equal(S.stepStates(2)[3].mark, "4");
});

test("strip: nothing in the store asks for the first bet and has no numbers", () => {
  const m = S.stripModel({}, NOW);
  assert.equal(m.empty, true);
  assert.equal(m.next.text, "Write your first bet");
  assert.equal(m.funnel.length, 0);
});

test("strip: tabs, the active market's funnel and its pass-line cells", () => {
  const data = {
    "settings": { active: "gym" },
    "market:rest": mk(),
    "market:gym": mk({ name: "Gyms", order: 1 }),
    "person:p1": { id: "p1", market: "gym", name: "A", status: "called", org: "X" },
    "person:p2": { id: "p2", market: "gym", name: "B", status: "asked" },
    "person:p3": { id: "p3", market: "rest", name: "C", status: "new" },
    "call:c1": { id: "c1", person: "p1", market: "gym", at: "2026-09-20T00:00:00Z", level: 5, betV: 1 },
  };
  const m = S.stripModel(data, NOW);
  assert.deepEqual(m.tabs.map((t) => [t.id, t.on, t.verdict]), [["rest", false, "Not started"], ["gym", true, "Keep talking"]]);
  assert.deepEqual(m.funnel.map((f) => [f.label, f.n]), [["Found", 2], ["Asked", 2], ["Booked", 1], ["Called", 1], ["Hair on fire", 1]]);
  assert.equal(m.funnel[0].pct, 100);
  assert.equal(m.funnel[2].pct, 50);
  assert.deepEqual(m.hits, { n: 1, of: 3, cells: [true, false, false] });
  assert.equal(m.calls.of, 10);
  assert.equal(m.calls.cells.filter(Boolean).length, 1);
});

test("strip: marks only when the next zone changes", () => {
  assert.equal(S.shouldMark(null, "markets"), true);
  assert.equal(S.shouldMark("markets", "markets"), false);
  assert.equal(S.shouldMark("markets", "people"), true);
  assert.equal(S.shouldMark("markets", null), false);
});

// ---- the Markets page ------------------------------------------------------

const M = logic("markets.html", ["findCard", "canFind", "newMarket", "slug", "cleanLine", "marketsModel", "parseList", "zoneFor", "lineText", "SOURCES", "WEAKER"]);

test("markets: pass line text, as the mockup writes it", () => {
  assert.equal(M.lineText({ hits: 3, calls: 10, commitments: 1 }), "3 at level 4–5 in 10 calls + 1 commitment");
  assert.equal(M.lineText({ hits: 2, calls: 8, commitments: 2 }), "2 at level 4–5 in 8 calls + 2 commitments");
});

test("markets: the inline warning says calls make the verdict weaker", () => {
  assert.equal(M.WEAKER, "Changing the line after calls makes the verdict weaker. Change anyway?");
});

test("markets: Find people lands a card in the markets zone id, holding the bet and the source", () => {
  const m = { id: "rest-1", name: "Restaurants", bet };
  const c = M.findCard(m, "web", "", { markets: "zone-77" });
  assert.equal(c.zone, "zone-77");
  assert.equal(c.title, "Find people: Restaurants");
  assert.match(c.text, /rest-1/);
  assert.match(c.text, /\*\*Who:\*\* Owners/);
  assert.match(c.text, /Where to look: Web search/);
  assert.doesNotMatch(c.text, /My list/);
  const l = M.findCard(m, "list", "Dana, Acme\n\n  Bo, Beta ", {});
  assert.equal(l.zone, "1 · Markets");
  assert.match(l.text, /My list:\nDana, Acme\nBo, Beta$/);
});

test("markets: Find people needs a bet, and a list when the source is a list", () => {
  assert.equal(M.canFind({ id: "a" }, "web", ""), false);
  assert.equal(M.canFind({ id: "a", bet }, "web", ""), true);
  assert.equal(M.canFind({ id: "a", bet }, "list", " \n"), false);
  assert.equal(M.canFind({ id: "a", bet }, "list", "Dana"), true);
});

test("markets: a new market starts on bet v1, unlocked, with the default line", () => {
  const n = M.newMarket("x-1", "Gyms", { who: "w", pain: "p" }, 2);
  assert.deepEqual(n.passLine, { hits: 3, of: 10, commits: 1 });
  assert.equal(n.bet.v, 1);
  assert.equal(n.bet.fromCalls, 0);
  assert.equal(n.locked, false);
  assert.equal(n.order, 2);
  assert.equal(M.slug("Mid-sized Restaurants!"), "mid-sized-restaurants");
});

test("markets: a typed pass line is made safe", () => {
  assert.deepEqual(M.cleanLine("2", "8", "0"), { hits: 2, of: 8, commits: 0 });
  assert.deepEqual(M.cleanLine("9", "4", "1"), { hits: 4, of: 4, commits: 1 });
  assert.deepEqual(M.cleanLine("x", "0", "x"), { hits: 3, of: 10, commits: 1 });
});

test("markets: the model carries the bet version, the lock and the verdict rows", () => {
  const data = {
    "settings": { active: "rest" },
    "market:rest": mk({ bet: { ...bet, v: 2, fromCalls: 4 } }),
    "person:p1": { id: "p1", market: "rest", name: "A", status: "called", org: "X" },
    "call:c1": { id: "c1", person: "p1", market: "rest", at: "2026-09-20T00:00:00Z", level: 5, betV: 1, counts: { "2": true } },
  };
  const m = M.marketsModel(data, NOW).market;
  assert.equal(m.versionTag, "v2 · from 4 calls");
  assert.equal(m.locked, true);
  assert.deepEqual(m.rows.map((r) => [r.label, r.n, r.of]), [["Calls counted", 1, 10], ["Hair on fire (4–5)", 1, 3], ["Commitments", 0, 1]]);
  assert.equal(m.verdictLabel, "Keep talking");
  assert.doesNotMatch(m.verdictLine, /%/);
  const fresh = M.marketsModel({ "market:g": mk({ name: "Gyms" }) }, NOW).market;
  assert.equal(fresh.versionTag, "");
  assert.equal(fresh.locked, false);
  assert.equal(fresh.verdictLabel, "Not started");
});

// ---- the People page -------------------------------------------------------

const P = logic("people.html", ["pickSummary", "askCard", "peopleModel", "statusLabel", "initials", "toggled", "zoneFor"]);
const person = (id, name, channels = {}, over = {}) => ({
  id, market: "rest", name, role: "Owner", org: "Org " + id, where: "r/x", why: "Posts about it", wave: 1, status: "new",
  channels: { email: false, li: false, call: false, ...channels }, ...over,
});

test("people: the summary says what you picked, in the mockup's words", () => {
  assert.equal(P.pickSummary([]), "");
  assert.equal(P.pickSummary([person("a", "A")]), "");
  assert.equal(P.pickSummary([person("a", "A", { email: true })]), "1 email");
  assert.equal(P.pickSummary([person("a", "A", { call: true })]), "1 cold call");
  assert.equal(P.pickSummary([person("a", "A", { li: true })]), "1 LinkedIn note");
  assert.equal(
    P.pickSummary([person("a", "A", { email: true }), person("b", "B", { email: true, call: true }), person("c", "C", { li: true }), person("d", "D", { li: true })]),
    "2 emails, 2 LinkedIn notes, 1 cold call");
});

test("people: the ask card lists each picked person's id, name and channels", () => {
  const picked = [person("ak", "Aisha Khan", { email: true, li: true }), person("bt", "Ben Tran", { call: true })];
  const c = P.askCard(picked, { people: "zone-9" });
  assert.equal(c.zone, "zone-9");
  assert.equal(c.title, "Ask: 2 people");
  assert.match(c.text, /person: ak \| Aisha Khan \| email, LinkedIn/);
  assert.match(c.text, /person: bt \| Ben Tran \| call/);
  assert.equal(P.askCard([picked[0]], {}).title, "Ask: 1 person");
  assert.equal(P.askCard([picked[0]], {}).zone, "2 · People");
});

test("people: toggling one channel keeps the others", () => {
  const p = person("a", "A", { email: true });
  assert.deepEqual(P.toggled(p, "li"), { email: true, li: true, call: false });
  assert.deepEqual(P.toggled(p, "email"), { email: false, li: false, call: false });
});

test("people: the model shows the active market's people, picks and statuses", () => {
  const data = {
    settings: { active: "rest" },
    "market:rest": mk(), "market:gym": mk({ name: "Gyms", order: 1 }),
    "person:a": person("a", "Aisha Khan", { email: true }),
    "person:b": person("b", "Ben Tran", { call: true }),
    "person:c": person("c", "Maria Chen", {}, { status: "called" }),
    "person:d": person("d", "James Ortiz", {}, { status: "booked", bookedFor: new Date(2026, 8, 30, 14).toISOString() }),
    "person:g": person("g", "Rosa Klein", {}, { market: "gym" }),
    "call:c1": { id: "c1", person: "c", market: "rest", at: "2026-09-20T00:00:00Z", level: 4, betV: 1 },
  };
  const m = P.peopleModel(data, NOW);
  assert.equal(m.empty, false);
  assert.equal(m.rows.length, 4);
  assert.deepEqual(m.rows.map((r) => r.id), ["c", "d", "a", "b"]);
  assert.equal(m.rows[0].status, "Called · level 4");
  assert.equal(m.rows[1].status, "Booked · Wed 2 PM");
  assert.deepEqual(m.rows.slice(2).map((r) => r.toggles), [true, true]);
  assert.equal(m.rows[2].initials, "AK");
  assert.equal(m.picked.length, 2);
  assert.equal(m.summary, "1 email, 1 cold call");
  assert.equal(m.canAsk, true);
  assert.equal(m.foundLine, "4 found");
  assert.deepEqual(m.yes.map((y) => y.name), ["James Ortiz"]);
  assert.deepEqual(m.funnel.map((f) => [f.label, f.n]), [["Asked", 2], ["Booked", 2], ["Called", 1]]);
});

test("people: with no market or no people there is an empty state and no ask", () => {
  assert.equal(P.peopleModel({}, NOW).empty, true);
  const m = P.peopleModel({ "market:rest": mk() }, NOW);
  assert.equal(m.rows.length, 0);
  assert.equal(m.canAsk, false);
  assert.equal(m.foundLine, "");
});

test("people: asked and booked people are not offered as picks", () => {
  const data = { "market:rest": mk(), "person:a": person("a", "A", { email: true }, { status: "asked" }) };
  const m = P.peopleModel(data, NOW);
  assert.equal(m.picked.length, 0);
  assert.equal(m.rows[0].status, "Asked");
});

// ---- the To send page ------------------------------------------------------

const T = logic("send.html", ["records", "draftsFor", "isStale", "sendModel", "kindLabel", "bookedCard", "redraftCard", "copyText"]);
const draft = (id, over = {}) => ({ id, person: "a", market: "rest", kind: "ask", channel: "email", body: "Hi " + id, betV: 1, status: "draft", at: "2026-09-25T10:00:00Z", ...over });

test("send: stale means written for an older bet than the market's now", () => {
  assert.equal(T.isStale(draft("x", { betV: 1 }), mk({ bet: { ...bet, v: 2 } })), true);
  assert.equal(T.isStale(draft("x", { betV: 2 }), mk({ bet: { ...bet, v: 2 } })), false);
  assert.equal(T.isStale(draft("x", { betV: undefined }), mk()), false);
  assert.equal(T.isStale(draft("x", { betV: undefined }), mk({ bet: { ...bet, v: 2 } })), true);
});

test("send: drafts for the active market, newest first", () => {
  const data = {
    "market:rest": mk(),
    "draft:old": draft("old", { at: "2026-09-20T10:00:00Z" }),
    "draft:new": draft("new", { at: "2026-09-28T10:00:00Z" }),
    "draft:mid": draft("mid", { at: "2026-09-24T10:00:00Z" }),
    "draft:other": draft("other", { market: "gym" }),
  };
  const r = T.records(data);
  assert.deepEqual(T.draftsFor(r, r.markets[0]).map((d) => d.id), ["new", "mid", "old"]);
  assert.deepEqual(T.draftsFor(r, null), []);
});

test("send: labels, actions and the stale tag follow the draft's kind and person", () => {
  const data = {
    settings: { active: "rest" },
    "market:rest": mk({ bet: { ...bet, v: 2 } }),
    "person:a": person("a", "Aisha Khan", {}, { status: "asked" }),
    "person:j": person("j", "James Ortiz", {}, { status: "booked", bookedFor: new Date(2026, 8, 30, 14).toISOString() }),
    "person:m": person("m", "Maria Chen", {}, { status: "called" }),
    "draft:1": draft("1", { at: "2026-09-29T10:00:00Z" }),
    "draft:2": draft("2", { person: "j", kind: "sheet", channel: undefined, betV: 2, at: "2026-09-28T10:00:00Z", body: "Open: x" }),
    "draft:3": draft("3", { person: "m", kind: "followup", channel: undefined, betV: 2, status: "sent", at: "2026-09-27T10:00:00Z" }),
    "call:c1": { id: "c1", person: "m", market: "rest", at: "2026-09-26T00:00:00Z", level: 4, betV: 1, commitment: { what: "Intro", currency: "intro", due: "2026-10-09", status: "offered" } },
  };
  const m = T.sendModel(data);
  assert.deepEqual(m.items.map((i) => i.id), ["1", "2", "3"]);
  const [ask, sheet, fu] = m.items;
  assert.equal(ask.kind, "Ask · email");
  assert.equal(ask.who, "Aisha Khan");
  assert.equal(ask.stale, true);
  assert.deepEqual(ask.actions, ["copy", "sent", "booked", "redraft"]);
  assert.equal(sheet.kind, "Call sheet");
  assert.equal(sheet.who, "James Ortiz · Wed 2 PM");
  assert.equal(sheet.stale, false);
  assert.deepEqual(sheet.actions, ["copy", "sent", "called"]);
  assert.equal(fu.kind, "Follow-up");
  assert.equal(fu.note, "From their call: commitment due Oct 9");
  assert.deepEqual(fu.actions, ["copy"]);
  assert.equal(fu.sent, true);
  assert.equal(m.count, 3);
});

test("send: Booked lands a card in the send zone, Redraft in the people zone", () => {
  const p = person("a", "Aisha Khan");
  assert.deepEqual(T.bookedCard(p, { send: "zone-s" }), { zone: "zone-s", title: "Booked: Aisha Khan", text: "person: a" });
  assert.deepEqual(T.redraftCard(p, draft("d9"), { people: "zone-p" }), { zone: "zone-p", title: "Redraft: Aisha Khan", text: "draft: d9" });
});

test("send: Copy takes the subject line with the body", () => {
  assert.equal(T.copyText(draft("1", { subject: "A short call?" })), "Subject: A short call?\n\nHi 1");
  assert.equal(T.copyText(draft("1")), "Hi 1");
});

// ---- the Calls page --------------------------------------------------------

const C = logic("calls.html", ["learningRows", "strongestQuote", "carrySentence", "applyUpdate", "askingNotes", "topicOf", "firstName", "whenLabel", "carriedText", "dotsOf", "tally"]);
const cpeople = { mc: person("mc", "Maria Chen"), lf: person("lf", "Lucia Ferro"), ki: person("ki", "Ken Ito"), gh: person("gh", "Greg Hale") };
const ncall = (id, p, level, said, matches, unprompted, over = {}) => ({
  id, person: p, market: "rest", at: `2026-09-2${id.slice(1)}T10:00:00Z`, level, quote: "q" + id, meaning: "m", doNow: "text a list",
  pain: { said, matchesBet: matches, unprompted }, coaching: { keep: "walk me through", change: "pitched early" }, betV: 1, ...over,
});
const NOSHOW = "Last-minute no-shows";
const ccalls = [
  ncall("c1", "mc", 4, NOSHOW, false, true),
  ncall("c2", "ki", 1, "Swaps are annoying", true, false, { doNow: "sister handles it" }),
  ncall("c3", "lf", 4, NOSHOW, false, true),
  ncall("c4", "gh", 2, NOSHOW, false, false),
];
const csuggest = { status: "open", from: 4, bet: { who: "w", pain: "Staff no-show", shown: "s", where: "x" }, rows: [{ label: "Came up on its own", text: NOSHOW, n: 3, of: 4 }], quote: { text: "q", who: "Maria Chen" }, carry: { c1: { counts: true, why: "x" }, c3: { counts: true, why: "x" }, c2: { counts: false, why: "y" }, c4: { counts: false, why: "y" } } };

test("calls: learning rows count the bet's pain, what came up unprompted and what they do now", () => {
  const rows = C.learningRows(ccalls, mk());
  assert.deepEqual(rows[0], { label: "Our bet said", text: "Rota breaks", n: 1, of: 4 });
  assert.deepEqual(rows[1], { label: "Came up on its own", text: NOSHOW, n: 2, of: 4 });
  assert.deepEqual(rows[2], { label: "What they do now", text: "text a list", n: 3, of: 4 });
  assert.equal(C.learningRows([], mk()).length, 0);
});

test("calls: the carry sentence names suggest.topic when Debrief wrote one", () => {
  const sg = { ...csuggest, topic: "No-shows" };
  assert.equal(C.topicOf(sg, ccalls, mk()), "no-shows");
  assert.equal(C.topicOf({ ...csuggest, topic: "  " }, ccalls, mk()), "last-minute no-shows");
  assert.equal(C.carrySentence(sg, ccalls, cpeople),
    "If you update, 2 of 4 earlier calls still count: Maria and Lucia described no-shows. Ken’s and Greg’s calls stay under the old bet.");
});

test("calls: the strongest quote is the highest level, the latest on a tie", () => {
  assert.deepEqual(C.strongestQuote(ccalls, cpeople), { text: "qc3", who: "Lucia Ferro" });
  assert.equal(C.strongestQuote([], cpeople), null);
});

test("calls: the carry sentence for none, one and several carried", () => {
  const sg = (ids) => ({ ...csuggest, carry: Object.fromEntries(ccalls.map((c) => [c.id, { counts: ids.includes(c.id) }])) });
  assert.equal(C.carrySentence(sg(["c1", "c3"]), ccalls, cpeople),
    "If you update, 2 of 4 earlier calls still count: Maria and Lucia described last-minute no-shows. Ken’s and Greg’s calls stay under the old bet.");
  assert.equal(C.carrySentence(sg(["c1"]), ccalls, cpeople),
    "If you update, 1 of 4 earlier calls still counts: Maria described last-minute no-shows. Ken’s, Lucia’s and Greg’s calls stay under the old bet.");
  assert.equal(C.carrySentence(sg([]), ccalls, cpeople), "If you update, none of the 4 earlier calls still count. They all stay under the old bet.");
  assert.equal(C.carrySentence(sg(["c1", "c2", "c3", "c4"]), ccalls, cpeople), "If you update, all 4 earlier calls still count.");
  assert.equal(C.carrySentence(sg([]), [], cpeople), "");
});

test("calls: applyUpdate bumps v, keeps the old bet and sets counts from the toggles", () => {
  const m = mk({ id: "rest" });
  const out = C.applyUpdate(m, csuggest, { c4: true }, ccalls, "2026-09-30T12:00:00Z");
  assert.equal(out.market.bet.v, 2);
  assert.equal(out.market.bet.pain, "Staff no-show");
  assert.equal(out.market.bet.fromCalls, 4);
  assert.equal(out.market.bets.length, 1);
  assert.deepEqual(out.market.bets[0], { ...bet, until: "2026-09-30T12:00:00.000Z" });
  const by = Object.fromEntries(out.calls.map((c) => [c.id, c]));
  assert.deepEqual([by.c1.counts[2], by.c2.counts[2], by.c3.counts[2], by.c4.counts[2]], [true, false, true, true]);
  assert.equal(ccalls[0].counts, undefined, "inputs are not mutated");
  assert.equal(m.bet.v, 1);
});

test("calls: after an update the tally counts carried calls plus new v2 calls only", () => {
  const m = mk({ id: "rest" });
  const out = C.applyUpdate(m, csuggest, {}, ccalls, NOW);
  const fresh = { id: "c9", person: "nw", market: "rest", at: "2026-09-30T10:00:00Z", level: 5, betV: 2, pain: { said: NOSHOW, matchesBet: true, unprompted: true } };
  const people = { ...cpeople, nw: person("nw", "New", {}, { org: "Z" }) };
  assert.equal(C.tally(m, ccalls, people, NOW).n, 4);
  const t = C.tally(out.market, [...out.calls, fresh], people, NOW);
  assert.equal(t.n, 3);
  assert.equal(t.hits, 3);
});

test("calls: the confirmation and the topic read from the store", () => {
  const m = mk({ id: "rest" });
  const out = C.applyUpdate(m, csuggest, {}, ccalls, NOW);
  assert.equal(C.topicOf(csuggest, ccalls, m), "last-minute no-shows");
  assert.equal(C.carriedText(out.market, out.calls, csuggest, m),
    "Bet is now v2. 2 earlier calls carried over; 2 stay under v1. New call sheets ask about last-minute no-shows.");
});

test("calls: Your asking takes the most frequent note, the most recent on a tie", () => {
  const cs = [
    ncall("c1", "mc", 4, "x", true, true, { coaching: { keep: "Walk me through last Friday", change: "Pitched early" } }),
    ncall("c2", "ki", 1, "x", true, true, { coaching: { keep: "walk me through last friday", change: "Asked would you use" } }),
    ncall("c3", "lf", 4, "x", true, true, { coaching: { keep: "Dug into the cost", change: "Asked would you use" } }),
    ncall("c4", "gh", 4, "x", true, true, { coaching: { keep: "Stayed quiet", change: "Pitched early" } }),
  ];
  const a = C.askingNotes(cs);
  assert.equal(a.keep, "Walk me through last Friday");
  assert.equal(a.change, "Pitched early");
  assert.deepEqual(C.askingNotes([]), { keep: "", change: "" });
});

test("calls: dots are green at 4 and 5, gray below; dates read as the mockup's", () => {
  assert.deepEqual(C.dotsOf(4), ["hot", "hot", "hot", "hot", "off"]);
  assert.deepEqual(C.dotsOf(2), ["on", "on", "off", "off", "off"]);
  const now = new Date("2026-09-30T12:00:00").getTime();
  assert.equal(C.whenLabel("2026-09-29T12:00:00", now), "Tue");
  assert.equal(C.whenLabel("2026-09-24T12:00:00", now), "last Thu");
  assert.equal(C.firstName("Maria Chen"), "Maria");
});
