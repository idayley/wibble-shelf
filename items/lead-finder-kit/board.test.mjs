// The Lead finder's rules, run under node against each page's own
// <script id="logic"> block -- so what is tested is what ships.
//
//   node --test items/lead-finder-kit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("./", import.meta.url);
const core = readFileSync(new URL("core.js", dir), "utf8").replace(/\s+$/, "");

function block(file, id) {
  const html = readFileSync(new URL(file, dir), "utf8");
  const m = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`));
  return m ? m[1] : null;
}

// A page's rules, with core.js in front when the page carries it.
function logic(file, names) {
  const l = block(file, "logic");
  assert.ok(l, `${file} has a <script id="logic"> block`);
  const pre = block(file, "core") !== null ? core + "\n" : "";
  return new Function(`${pre}${l}\nreturn { ${names.join(", ")} };`)();
}

const B = logic("board.html", [
  "channelsOn", "isPicked", "needsReveal", "creditsNeeded", "revealIds", "spendMode", "balanceAfter",
  "dedupeKey", "uniquePeople", "newPeople", "readyPeople", "sendState", "sendPayload", "sentKeyOf",
  "applyReveal", "records", "spendLine", "REVEAL_CAP", "zoneFor", "moveToKit",
]);
const A = logic("ask.html", ["apolloState", "askCard", "canFind", "parseList", "SOURCES", "zoneFor"]);

test("every page that carries core.js carries it byte for byte", () => {
  const pages = readdirSync(dir).filter((n) => n.endsWith(".html") && block(n, "core") !== null);
  assert.deepEqual(pages.sort(), ["board.html", "progress.html", "send.html"]);
  for (const f of pages) {
    assert.equal(block(f, "core").trim(), core.trim(), `${f}: run node items/lead-finder-kit/sync-core.mjs`);
    const html = readFileSync(new URL(f, dir), "utf8");
    assert.ok(html.indexOf('id="core"') < html.indexOf('id="logic"'), `${f}: core comes before logic`);
  }
});

test("kit.json is valid and its zones never overlap", () => {
  const kit = JSON.parse(readFileSync(new URL("kit.json", dir), "utf8"));
  const zs = kit.zones;
  for (let i = 0; i < zs.length; i++) {
    for (let j = i + 1; j < zs.length; j++) {
      const a = zs[i], b = zs[j];
      const apart = a.dx + a.w <= b.dx || b.dx + b.w <= a.dx || a.dy + a.h <= b.dy || b.dy + b.h <= a.dy;
      assert.ok(apart, `${a.key} and ${b.key} overlap`);
    }
  }
  const keys = zs.map((z) => z.key);
  assert.deepEqual(keys, ["progress", "who", "leads", "outreach", "send"]);
  assert.equal(zs[0].dy, 0);
  for (const p of kit.pages) {
    assert.ok(keys.includes(p.zone), `${p.file} is in a zone that exists`);
    readFileSync(new URL(p.file, dir), "utf8");
  }
  const strip = kit.pages.find((p) => p.file === "progress.html");
  assert.equal(strip.size, "fill");
  assert.ok(kit.pages.some((p) => p.file === "send.html" && p.zone === "send"));
});

test("no page uses an em dash", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".html") || n === "core.js")) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /—/, `${f} has an em dash`);
  }
});

const ch = (email, call, linkedin) => ({ email: !!email, call: !!call, linkedin: !!linkedin });
const person = (id, over = {}) => ({
  id, name: id, title: "CEO", company: `${id} Co`, why: "Growing fast", source: "apollo", apolloId: `ap-${id}`,
  channels: ch(), revealed: false, ...over,
});

// ---- who counts, and what it costs -------------------------------------

test("no channel is on by default: a person with none is not picked", () => {
  assert.equal(B.isPicked(person("a")), false);
  assert.deepEqual(B.channelsOn(person("a")), []);
  assert.equal(B.isPicked(person("a", { channels: ch(0, 1, 0) })), true);
  // a record with no channels at all (an agent wrote it bare) is unpicked, not an error
  assert.equal(B.isPicked({ id: "x", name: "X" }), false);
  assert.deepEqual(B.channelsOn({ id: "x" }), []);
});

test("credits: picked Apollo people not yet revealed whose channels include email or LinkedIn", () => {
  const people = [
    person("email", { channels: ch(1, 0, 0) }),
    person("li", { channels: ch(0, 0, 1) }),
    person("both", { channels: ch(1, 0, 1) }), // one credit, not two
    person("call", { channels: ch(0, 1, 0) }), // phone comes from the web: free
    person("none"), // not picked
    person("done", { channels: ch(1, 0, 0), revealed: true }),
    person("web", { source: "web", apolloId: undefined, channels: ch(1, 0, 0) }),
  ];
  assert.equal(B.creditsNeeded(people), 3);
  assert.deepEqual(B.revealIds(people), ["ap-email", "ap-li", "ap-both"]);
  assert.equal(B.needsReveal(people[3]), false);
  assert.equal(B.needsReveal(people[6]), false);
});

test("an Apollo person with no Apollo id can't be revealed, so costs nothing", () => {
  assert.equal(B.creditsNeeded([person("a", { apolloId: undefined, channels: ch(1, 0, 0) })]), 0);
});

test("reveal ids are unique and capped at 100; the count says how many are waiting", () => {
  const many = Array.from({ length: 130 }, (_, i) => person(`p${i}`, { channels: ch(1, 0, 0) }));
  assert.equal(B.REVEAL_CAP, 100);
  assert.equal(B.creditsNeeded(many), 130);
  assert.equal(B.revealIds(many).length, 100);
  const twins = [person("a", { channels: ch(1, 0, 0) }), person("b", { apolloId: "ap-a", channels: ch(1, 0, 0) })];
  assert.deepEqual(B.revealIds(twins), ["ap-a"]);
});

test("spend mode: Apollo only when the board holds Apollo people", () => {
  assert.equal(B.spendMode([person("a")]), "apollo");
  assert.equal(B.spendMode([person("a", { source: "web" })]), "free");
  assert.equal(B.spendMode([]), "free");
});

test("balance after never goes below zero and is unknown when the balance is", () => {
  assert.equal(B.balanceAfter(1158, 3), 1155);
  assert.equal(B.balanceAfter(2, 5), 0);
  assert.equal(B.balanceAfter(null, 5), null);
});

test("spend line: cost is shown even when the balance can't be read", () => {
  assert.match(B.spendLine(3, { left: 1158, resets: "2026-10-15T00:00:00.000Z" }), /3 credits/);
  assert.match(B.spendLine(3, { left: 1158 }), /1,158 now/);
  assert.match(B.spendLine(3, { left: 1158 }), /1,155 after/);
  assert.match(B.spendLine(1, null), /1 credit\b/);
  assert.match(B.spendLine(1, null), /Balance unavailable/);
});

// ---- dedupe on re-search -----------------------------------------------

test("the same person found again is one person", () => {
  assert.equal(B.dedupeKey(person("a")), B.dedupeKey(person("b", { apolloId: "ap-a" })));
  const web = { name: "Dana Ruiz", company: "Harbor Talent", source: "web" };
  assert.equal(B.dedupeKey(web), B.dedupeKey({ name: " dana ruiz ", company: "HARBOR TALENT", source: "list" }));
  assert.equal(B.dedupeKey({ name: "A", linkedin: "https://LinkedIn.com/in/dana/" }), B.dedupeKey({ name: "B", linkedin: "linkedin.com/in/dana" }));
  assert.notEqual(B.dedupeKey(person("a")), B.dedupeKey(person("c")));
});

test("uniquePeople keeps the one the operator has already worked on", () => {
  const fresh = person("a");
  const worked = person("b", { apolloId: "ap-a", channels: ch(1, 0, 0), revealed: true });
  const out = B.uniquePeople([fresh, worked, person("c")]);
  assert.equal(out.length, 2);
  assert.equal(out.find((p) => p.apolloId === "ap-a").id, "b");
});

test("newPeople adds only who isn't on the board, and never overwrites a pick", () => {
  const board = { "person:a": person("a", { channels: ch(1, 0, 0) }) };
  const incoming = [person("a2", { apolloId: "ap-a" }), person("z"), person("z2", { apolloId: "ap-z" })];
  const { add, skipped } = B.newPeople(board, incoming);
  assert.deepEqual(add.map((p) => p.id), ["z"]);
  assert.equal(skipped, 2);
});

// ---- reveal results ------------------------------------------------------

test("a full reveal fills the people in and marks them revealed", () => {
  const people = [person("a", { channels: ch(1, 0, 1) }), person("b", { channels: ch(1, 0, 0) })];
  const r = B.applyReveal(people, ["ap-a", "ap-b"], {
    people: [
      { id: "ap-a", name: "Ada Lovelace", email: "ada@a.co", linkedin: "https://linkedin.com/in/ada", title: "Founder", company: "A Co" },
      { id: "ap-b", name: "Bo Diddley", email: "bo@b.co", linkedin: "", title: "CEO", company: "B Co" },
    ],
    requested: 2,
  });
  assert.equal(r.revealed, 2);
  assert.equal(r.line, "Revealed 2 of 2.");
  assert.equal(r.updates.a.name, "Ada Lovelace");
  assert.equal(r.updates.a.email, "ada@a.co");
  assert.equal(r.updates.a.revealed, true);
  assert.deepEqual(r.updates.a.channels, ch(1, 0, 1)); // the picks stay
  assert.equal("linkedin" in r.updates.b && r.updates.b.linkedin, false); // no empty overwrite
  assert.equal(B.creditsNeeded(people.map((p) => r.updates[p.id] || p)), 0);
});

test("a partial reveal says how many and why; people Apollo had no match for stop blocking Send", () => {
  const people = [1, 2, 3].map((n) => person(`p${n}`, { channels: ch(1, 0, 0) }));
  const r = B.applyReveal(people, ["ap-p1", "ap-p2", "ap-p3"], {
    people: [{ id: "ap-p1", name: "One", email: "1@x.co" }],
    requested: 3,
  });
  assert.equal(r.revealed, 1);
  assert.match(r.line, /^Revealed 1 of 3\. /);
  assert.match(r.line, /no match/i);
  assert.deepEqual(r.failed.sort(), ["p2", "p3"]);
  assert.equal(r.updates.p2.revealFailed, true);
  const after = people.map((p) => r.updates[p.id] || p);
  assert.equal(B.creditsNeeded(after), 0);
  assert.deepEqual(B.readyPeople(after).map((p) => p.id), ["p1"]);
});

test("Apollo stopping partway keeps the rest waiting, with its reason", () => {
  const people = [1, 2, 3].map((n) => person(`p${n}`, { channels: ch(1, 0, 0) }));
  const r = B.applyReveal(people, ["ap-p1", "ap-p2", "ap-p3"], {
    people: [{ id: "ap-p1", name: "One", email: "1@x.co" }],
    requested: 3,
    stopped: "Apollo rate-limited the rest.",
  });
  assert.equal(r.line, "Revealed 1 of 3. Apollo rate-limited the rest.");
  assert.deepEqual(r.failed, []);
  const after = people.map((p) => r.updates[p.id] || p);
  assert.equal(B.creditsNeeded(after), 2); // still there to try again
});

test("a malformed reveal answer changes nothing", () => {
  const people = [person("a", { channels: ch(1, 0, 0) })];
  const r = B.applyReveal(people, ["ap-a"], null);
  assert.deepEqual(r.updates, {});
  assert.equal(r.revealed, 0);
});

// ---- Send ---------------------------------------------------------------

test("Send is off with nothing picked, and off while a pick still needs a reveal", () => {
  assert.equal(B.sendState([person("a")], "").enabled, false);
  const waiting = [person("a", { channels: ch(1, 0, 0) })];
  const s = B.sendState(waiting, "");
  assert.equal(s.enabled, false);
  assert.match(s.why, /Spend 1 credit/);
});

test("Send is on for free people at once, and for revealed people", () => {
  const free = [person("w", { source: "web", apolloId: undefined, channels: ch(1, 1, 0) })];
  assert.equal(B.sendState(free, "").enabled, true);
  assert.equal(B.sendState(free, "").count, 1);
  const done = [person("a", { channels: ch(1, 0, 0), revealed: true })];
  assert.equal(B.sendState(done, "").enabled, true);
  // Call only on an Apollo person needs no credit
  assert.equal(B.sendState([person("c", { channels: ch(0, 1, 0) })], "").enabled, true);
});

test("after sending, Send stays off until the picks change", () => {
  const people = [person("w", { source: "web", apolloId: undefined, channels: ch(1, 0, 0) })];
  const key = B.sentKeyOf(B.sendPayload(people, { text: "x", source: "web" }));
  assert.equal(B.sendState(people, key, { text: "x", source: "web" }).enabled, false);
  const changed = [{ ...people[0], channels: ch(1, 1, 0) }];
  assert.equal(B.sendState(changed, key, { text: "x", source: "web" }).enabled, true);
});

test("send payload: a Picks card with each person, their channels and everything known", () => {
  const people = [
    person("dana", { name: "Dana Ruiz", title: "CEO", company: "Harbor Talent", why: "Grew from 30 to 42 people", channels: ch(1, 0, 1),
      email: "dana@harbor.co", linkedin: "https://linkedin.com/in/dana", revealed: true }),
    person("marcus", { name: "Marcus Webb", source: "web", apolloId: undefined, channels: ch(0, 1, 0), phone: "+1 555 014 2290", phoneNote: "company line" }),
    person("skip"), // no channel: left out
  ];
  const p = B.sendPayload(people, { text: "CEOs of recruiting firms", source: "apollo" });
  assert.equal(p.title, "Picks: 2 people");
  assert.match(p.text, /CEOs of recruiting firms/);
  assert.match(p.text, /Dana Ruiz/);
  assert.match(p.text, /Harbor Talent/);
  assert.match(p.text, /Reach by: Email, LinkedIn/);
  assert.match(p.text, /dana@harbor\.co/);
  assert.match(p.text, /linkedin\.com\/in\/dana/);
  assert.match(p.text, /Grew from 30 to 42 people/);
  assert.match(p.text, /Reach by: Call/);
  assert.match(p.text, /\+1 555 014 2290/);
  assert.doesNotMatch(p.text, /skip/);
  assert.equal(B.sendPayload([people[0]], {}).title, "Picks: 1 person");
});

test("send payload leaves out anyone still waiting on a reveal", () => {
  const people = [person("a", { channels: ch(1, 0, 0) }), person("b", { channels: ch(0, 1, 0) })];
  const p = B.sendPayload(people, {});
  assert.equal(p.title, "Picks: 1 person");
  assert.doesNotMatch(p.text, /\ba Co\b/);
});

// ---- the store -----------------------------------------------------------

test("records: request, filters, people (by key) and settings", () => {
  const data = {
    request: { text: "CEOs", source: "apollo" },
    filters: { chips: [{ label: "Title", value: "CEO" }] },
    "person:a": { name: "A", channels: ch(1, 0, 0) },
    "person:b": { id: "keep-me", name: "B" },
    settings: { sentKey: "k" },
    other: 1,
  };
  const r = B.records(data);
  assert.equal(r.request.text, "CEOs");
  assert.equal(r.filters.chips[0].label, "Title");
  assert.deepEqual(r.people.map((p) => p.id).sort(), ["a", "b"]);
  assert.equal(r.settings.sentKey, "k");
  const empty = B.records({});
  assert.deepEqual(empty.people, []);
  assert.deepEqual(empty.request, {});
});

// ---- the Ask page --------------------------------------------------------

test("Apollo state on the Ask page, from what the credits call says", () => {
  assert.equal(A.apolloState({ ok: true, value: { left: 5 } }).state, "ready");
  const gone = A.apolloState({ ok: false, error: "That extension isn't running." });
  assert.equal(gone.state, "missing");
  assert.equal(gone.note, "Install Apollo from the shelf");
  const nokey = A.apolloState({ ok: false, error: "Apollo API key isn't set. Add it in Settings → Agents → Connections." });
  assert.equal(nokey.state, "nokey");
  assert.equal(nokey.note, "Add your Apollo key in Settings → Agents → Connections");
  // a key that works for search but can't read the balance is still usable
  assert.equal(A.apolloState({ ok: false, error: "Apollo says this key can't do that. Credit balance needs a master key." }).state, "ready");
  // anything else (Apollo down, rate limit) is a hiccup, not a reason to grey the source
  assert.equal(A.apolloState({ ok: false, error: "Apollo had a problem on its side. Try again shortly." }).state, "ready");
  // no bridge at all (the page opened in a browser)
  assert.equal(A.apolloState({ ok: false, error: "" }).state, "ready");
});

test("Find people needs words, and My list needs a list", () => {
  assert.equal(A.canFind({ text: "", source: "web", list: "" }), false);
  assert.equal(A.canFind({ text: "  ", source: "web", list: "" }), false);
  assert.equal(A.canFind({ text: "CEOs", source: "web", list: "" }), true);
  assert.equal(A.canFind({ text: "CEOs", source: "list", list: "" }), false);
  assert.equal(A.canFind({ text: "CEOs", source: "list", list: "Dana Ruiz, Harbor Talent" }), true);
  assert.equal(A.canFind({ text: "CEOs", source: "apollo", list: "" }), true);
  assert.equal(A.canFind({ text: "CEOs", source: "nonsense", list: "" }), false);
});

test("the card Find people lands holds the request, the source, and only a list for My list", () => {
  const c = A.askCard({ text: "CEOs of small recruiting firms. US only.", source: "apollo", list: "ignored" });
  assert.equal(c.zone, "Who to find");
  assert.match(c.title, /CEOs of small recruiting firms/);
  assert.match(c.text, /Where to look: Apollo/);
  assert.doesNotMatch(c.text, /ignored/);
  const l = A.askCard({ text: "Who to email", source: "list", list: "Dana Ruiz, Harbor Talent\nMarcus Webb" });
  assert.match(l.text, /Where to look: My list/);
  assert.match(l.text, /Dana Ruiz, Harbor Talent/);
  assert.equal(A.askCard({ text: "x".repeat(500), source: "web", list: "" }).title.length <= 80, true);
});

test("a pasted list becomes lines, no blanks", () => {
  assert.deepEqual(A.parseList("Dana Ruiz, Harbor\n\n  Marcus Webb  \n"), ["Dana Ruiz, Harbor", "Marcus Webb"]);
  assert.deepEqual(A.parseList(""), []);
});

test("a card goes to the zone the kit placed, by id, and to the plain name without one", () => {
  const zones = { who: "z-77", outreach: "z-88" };
  assert.equal(A.askCard({ text: "CEOs", source: "web", list: "" }, zones).zone, "z-77");
  assert.equal(A.askCard({ text: "CEOs", source: "web", list: "" }).zone, "Who to find");
  assert.equal(B.zoneFor(zones, "outreach", "Outreach"), "z-88");
  assert.equal(B.zoneFor(zones, "nope", "Outreach"), "Outreach");
  assert.equal(B.zoneFor(undefined, "outreach", "Outreach"), "Outreach");
  assert.equal(B.zoneFor({ outreach: 5 }, "outreach", "Outreach"), "Outreach");
});

test("people Apollo could not answer for stay waiting, not marked as no match", () => {
  const people = [person("a"), person("b"), person("c")];
  const r = B.applyReveal(people, ["ap-a", "ap-b", "ap-c"], {
    people: [{ id: "ap-a", email: "a@x.co" }], requested: 3, skipped: ["ap-b"],
  });
  assert.deepEqual(r.failed, ["c"]);
  assert.equal(r.updates.b, undefined);
  assert.match(r.line, /could not answer for 1/);
});
