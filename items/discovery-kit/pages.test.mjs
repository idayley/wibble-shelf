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
