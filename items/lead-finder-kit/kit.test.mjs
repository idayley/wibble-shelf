// The kit-wide rules: the progress strip, the move into the kit store, and
// the To send page. Run under node against each page's own blocks, core
// first, so what is tested is what ships.
//
//   node --test items/lead-finder-kit/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dir = new URL("./", import.meta.url);
const core = readFileSync(new URL("core.js", dir), "utf8").replace(/\s+$/, "");

function logic(file, names) {
  const html = readFileSync(new URL(file, dir), "utf8");
  const m = html.match(/<script id="logic">([\s\S]*?)<\/script>/);
  assert.ok(m, `${file} has a <script id="logic"> block`);
  return new Function(`${core}\n${m[1]}\nreturn { ${names.join(", ")} };`)();
}

const B = logic("board.html", ["records", "sentKeyOf", "sendPayload", "moveToKit"]);
const S = logic("progress.html", ["stripModel", "shouldMark", "funnel", "nextStep"]);
const T = logic("send.html", ["sendModel", "copyText", "markSent", "draftRows"]);

const ch = (email, call, linkedin) => ({ email: !!email, call: !!call, linkedin: !!linkedin });
const person = (id, over = {}) => ({
  id, name: id, title: "CEO", company: `${id} Co`, why: "Growing fast", source: "apollo", apolloId: `ap-${id}`,
  channels: ch(), revealed: false, ...over,
});
const web = (id, over = {}) => person(id, { source: "web", apolloId: undefined, ...over });
const draft = (pid, channel, over = {}) => ({ person: pid, channel, body: `Hi from ${pid}`, at: "2026-10-01T09:00:00Z", status: "draft", ...over });
const store = (people = [], drafts = [], extra = {}) => {
  const d = { ...extra };
  people.forEach((p) => { const { id, ...rest } = p; d[`person:${id}`] = rest; });
  drafts.forEach(([id, dr]) => { d[`draft:${id}`] = dr; });
  return d;
};

// ---- the progress strip: funnel and what is next -------------------------------

test("funnel counts people, not drafts, and each count says what it counts", () => {
  const data = store(
    [web("a", { channels: ch(1, 1, 0) }), web("b", { channels: ch(0, 0, 1) }), web("c"), web("d")],
    [["a-email", draft("a", "email", { status: "sent" })], ["a-call", draft("a", "call")], ["b-linkedin", draft("b", "linkedin")]],
  );
  const f = S.funnel(B.records(data));
  assert.deepEqual(f.map((x) => [x.id, x.n]), [["found", 4], ["picked", 2], ["drafted", 2], ["sent", 1]]);
  assert.ok(f.every((x) => /people/.test(x.what)));
  assert.deepEqual(S.funnel(B.records({})).map((x) => x.n), [0, 0, 0, 0]);
});

test("funnel finds a twin once", () => {
  const data = store([person("a"), person("a2", { apolloId: "ap-a" })]);
  assert.equal(S.funnel(B.records(data))[0].n, 1);
});

test("next: nothing yet asks you to press Find people, with the reason", () => {
  const n = S.nextStep(B.records({}));
  assert.equal(n.zone, "who");
  assert.equal(n.step, 0);
  assert.match(n.text, /Say who/);
  assert.match(n.why, /Find people/);
  const asked = S.nextStep(B.records({ request: { text: "CEOs", source: "web" } }));
  assert.equal(asked.zone, "who");
  assert.match(asked.text, /Check Who to find/);
});

test("next: people but no picks asks you to pick, in Leads", () => {
  const n = S.nextStep(B.records(store([web("a"), web("b")])));
  assert.equal(n.zone, "leads");
  assert.equal(n.step, 1);
  assert.match(n.text, /Pick who to reach/);
  assert.match(n.why, /Tap nothing to skip/);
  assert.equal(n.also, "");
});

test("next: picks that need credits ask for Spend first; nothing is spent for you", () => {
  const n = S.nextStep(B.records(store([person("a", { channels: ch(1, 0, 0) }), person("b", { channels: ch(0, 0, 1) })])));
  assert.equal(n.zone, "leads");
  assert.match(n.text, /Spend 2 credits/);
  assert.match(n.why, /Nothing is spent until you press Spend/);
});

test("next: ready picks ask you to press Send to Outreach", () => {
  const n = S.nextStep(B.records(store([web("a", { channels: ch(1, 0, 0) }), web("b", { channels: ch(0, 1, 0) })])));
  assert.equal(n.zone, "leads");
  assert.equal(n.text, "Press Send to Outreach");
  assert.match(n.why, /2 picked people are ready/);
});

test("next: after sending, with no drafts yet, only the agent is at work: no zone is marked", () => {
  const people = [web("a", { channels: ch(1, 0, 0) })];
  const request = { text: "x", source: "web" };
  const sentKey = B.sentKeyOf(B.sendPayload(people, request));
  const n = S.nextStep(B.records(store(people, [], { request, settings: { sentKey } })));
  assert.equal(n.zone, null);
  assert.equal(n.step, 2);
  assert.match(n.text, /Wait for your drafts/);
});

test("next: unsent drafts point at To send, and the rest of what is waiting is named", () => {
  const people = [web("a", { channels: ch(1, 0, 1) }), web("b"), web("c")];
  const data = store(people, [["a-email", draft("a", "email")], ["a-linkedin", draft("a", "linkedin", { status: "sent" })]]);
  const n = S.nextStep(B.records(data));
  assert.equal(n.zone, "send");
  assert.equal(n.step, 3);
  assert.match(n.text, /Send your 1 draft$/);
  assert.match(n.why, /Wibble sends nothing/);
  assert.equal(n.also, "2 people in Leads not picked");
});

test("next: everything sent and everyone picked says nothing is waiting; unpicked people are next", () => {
  const all = store([web("a", { channels: ch(1, 0, 0) })], [["a-email", draft("a", "email", { status: "sent" })]]);
  const done = S.nextStep(B.records(all));
  assert.equal(done.zone, null);
  assert.equal(done.step, 4);
  assert.match(done.text, /Nothing is waiting/);
  const more = S.nextStep(B.records(store([web("a", { channels: ch(1, 0, 0) }), web("b")], [["a-email", draft("a", "email", { status: "sent" })]])));
  assert.equal(more.zone, "leads");
  assert.match(more.text, /Pick more people/);
});

test("next: always one zone or none, with a reason", () => {
  const cases = [{}, store([web("a")]), store([web("a", { channels: ch(1, 0, 0) })]), store([web("a", { channels: ch(1, 0, 0) })], [["a-email", draft("a", "email")]])];
  for (const c of cases) {
    const n = S.nextStep(B.records(c));
    assert.ok(n.zone === null || ["who", "leads", "outreach", "send"].includes(n.zone));
    assert.ok(n.text && n.why);
  }
});

test("strip: steps are done, now or later from the step the operator is on; marks only on a change", () => {
  const m = S.stripModel(store([web("a", { channels: ch(1, 0, 0) })], [["a-email", draft("a", "email")]]));
  assert.deepEqual(m.steps.map((s) => s.state), ["done", "done", "done", "now"]);
  assert.equal(m.steps[0].mark, "✓");
  assert.equal(m.steps[3].mark, "4");
  assert.equal(m.steps[1].what, "people you chose a way to reach");
  assert.deepEqual(S.stripModel({}).steps.map((s) => s.state), ["now", "later", "later", "later"]);
  assert.equal(S.shouldMark(undefined, "leads"), true);
  assert.equal(S.shouldMark("leads", "leads"), false);
  assert.equal(S.shouldMark("leads", "send"), true);
  assert.equal(S.shouldMark("send", null), true);
});

// ---- the one-time move into the kit store ----------------------------------------

test("move: leads kept in the board's own store are copied into an empty kit store", () => {
  const own = {
    request: { text: "CEOs", source: "web" }, filters: { chips: [] },
    "person:a": { name: "A", channels: ch(1, 0, 0) }, "person:b": { name: "B" },
    settings: { sentKey: "k" }, draft: { text: "typed, not a lead" }, kitZones: { who: "z-1" },
  };
  const patch = B.moveToKit({}, own);
  assert.deepEqual(Object.keys(patch).sort(), ["filters", "person:a", "person:b", "request", "settings"]);
  assert.deepEqual(patch["person:a"].channels, ch(1, 0, 0));
  assert.equal(own["person:a"].name, "A"); // the own copy is left alone
});

test("move: never when the kit store already has leads, or the own store has none", () => {
  const own = { "person:a": { name: "A" } };
  assert.equal(B.moveToKit({ "person:x": { name: "X" } }, own), null);
  assert.equal(B.moveToKit({}, { request: { text: "CEOs" } }), null);
  assert.equal(B.moveToKit({}, {}), null);
  assert.equal(B.moveToKit(undefined, undefined), null);
});

test("move: a kit store with settings but no leads keeps its settings", () => {
  const patch = B.moveToKit({ settings: { sentKey: "kit" } }, { "person:a": { name: "A" }, settings: { sentKey: "own" } });
  assert.equal(patch.settings, undefined);
  assert.ok(patch["person:a"]);
});

test("move: running it again after the copy changes nothing", () => {
  const own = { "person:a": { name: "A" }, request: { text: "r" } };
  const kit = { ...B.moveToKit({}, own) };
  assert.equal(B.moveToKit(kit, own), null);
});

// ---- To send ------------------------------------------------------------------------

test("send: drafts still to send come newest first; sent ones are grouped apart, latest sent first", () => {
  const data = store([web("a", { name: "Dana", title: "CEO", company: "Harbor" }), web("b", { name: "Marcus" })], [
    ["a-email", draft("a", "email", { subject: "Hello", at: "2026-10-01T09:00:00Z" })],
    ["b-call", draft("b", "call", { at: "2026-10-01T10:00:00Z" })],
    ["a-linkedin", draft("a", "linkedin", { status: "sent", sentAt: "2026-10-01T11:00:00Z" })],
    ["b-email", draft("b", "email", { status: "sent", sentAt: "2026-10-01T12:00:00Z" })],
  ]);
  const m = T.sendModel(data);
  assert.equal(m.count, 4);
  assert.deepEqual(m.todo.map((r) => r.id), ["b-call", "a-email"]);
  assert.deepEqual(m.sent.map((r) => r.id), ["b-email", "a-linkedin"]);
  assert.equal(m.todo[1].who, "Dana");
  assert.equal(m.todo[1].sub, "CEO · Harbor");
  assert.deepEqual(m.todo.map((r) => r.kind), ["Call sheet", "Email"]);
  assert.equal(m.sent[1].kind, "LinkedIn note");
  assert.ok(m.sent.every((r) => r.sent) && m.todo.every((r) => !r.sent));
});

test("send: nothing in the store is the empty state; a draft for a missing person still shows", () => {
  assert.equal(T.sendModel({}).empty, true);
  assert.equal(T.sendModel({}).todo.length, 0);
  const m = T.sendModel(store([], [["z-email", draft("z", "email")]]));
  assert.equal(m.empty, false);
  assert.equal(m.todo[0].who, "Someone");
});

test("send: the empty state names the button that fills it", () => {
  const html = readFileSync(new URL("send.html", dir), "utf8");
  assert.match(html, /Nothing to send yet\.<br>Pick people on the <b>Lead board<\/b> and press <b>Send to Outreach<\/b>/);
});

test("send: Sent records the time and changes nothing else; Copy takes the subject line with the body", () => {
  const d = { id: "a-email", ...draft("a", "email", { subject: "Hello" }) };
  const s = T.markSent(d, Date.parse("2026-10-01T15:30:00Z"));
  assert.equal(s.status, "sent");
  assert.equal(s.sentAt, "2026-10-01T15:30:00.000Z");
  assert.equal(s.body, d.body);
  assert.equal(s.id, undefined);
  assert.equal(T.copyText(d), "Subject: Hello\n\nHi from a");
  assert.equal(T.copyText({ body: "Open line" }), "Open line");
});

test("send payload names each person's id so Outreach asker can key its drafts", () => {
  const p = B.sendPayload([person("a", { name: "Dana", channels: ch(0, 1, 0) })], {});
  assert.match(p.text, /^## Dana\nPerson: a\n/m);
});
