// apollo/apollo.test.mjs — run with `node --test items/apollo/apollo.test.mjs`.
// Fixtures follow the shapes in Apollo's docs. No real key appears anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  searchBody, matchBody, parseSearch, parseMatch, parseCredits, errorText,
  stopReason, shortDate, cleanIds, confirmOptions, reveal, activate,
  SEARCH_URL, MATCH_URL, CREDITS_URL,
} from "./main.js";

const SEARCH = {
  total_entries: 1234,
  people: [
    { id: "p1", first_name: "Ada", last_name_obfuscated: "Lo***e", title: "Founder", has_email: true, organization: { name: "Acme" } },
    { id: "p2", first_name: "Bo", last_name_obfuscated: "Ke***y", title: null, has_email: false, organization: { name: "Beta" } },
    { first_name: "NoId" },
  ],
};
const MATCH = (id) => ({
  person: {
    id, name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace", email: "ada@acme.com",
    title: "Founder", linkedin_url: "https://linkedin.com/in/ada",
    organization: { name: "Acme", primary_domain: "acme.com" },
  },
});
const CREDITS = {
  credit_usage_stats: { lead_credit: { limit: 1000, consumed: 250, left_over: 750 } },
  current_credit_cycle: { start_date: "2026-09-15T00:00:00.000Z", end_date: "2026-10-15T00:00:00.000Z" },
};

test("searchBody maps filters, omits empties, clamps", () => {
  assert.deepEqual(searchBody({}), { page: 1, per_page: 100 });
  const b = searchBody({
    titles: ["ceo", " "], seniorities: ["founder"], person_locations: ["United States"],
    org_locations: ["Ohio"], employee_ranges: ["2,200"], keywords: ["recruiting"], page: 3, per_page: 900,
  });
  assert.deepEqual(b, {
    person_titles: ["ceo"], person_seniorities: ["founder"], person_locations: ["United States"],
    organization_locations: ["Ohio"], organization_num_employees_ranges: ["2,200"],
    q_organization_keyword_tags: ["recruiting"], page: 3, per_page: 100,
  });
  assert.equal(searchBody({ per_page: 0 }).per_page, 1);
  assert.equal(searchBody({ page: -2 }).page, 1);
});

test("matchBody is only an id, never a phone flag", () => {
  assert.deepEqual(matchBody("p1"), { id: "p1" });
});

test("parseSearch", () => {
  const r = parseSearch(SEARCH);
  assert.equal(r.total, 1234);
  assert.equal(r.people.length, 2);
  assert.deepEqual(r.people[0], { id: "p1", firstName: "Ada", lastName: "Lo***e", title: "Founder", company: "Acme", hasEmail: true });
  assert.equal(r.people[1].title, "");
  assert.deepEqual(parseSearch(null), { total: 0, people: [] });
});

test("parseMatch", () => {
  const p = parseMatch(MATCH("p1"));
  assert.equal(p.email, "ada@acme.com");
  assert.equal(p.company, "Acme");
  assert.equal(p.domain, "acme.com");
  assert.equal(parseMatch({}), null);
  assert.equal(parseMatch({ person: null }), null);
  assert.equal(parseMatch({ person: { id: "x", first_name: "A" } }).email, "");
});

test("parseCredits", () => {
  assert.deepEqual(parseCredits(CREDITS), { limit: 1000, consumed: 250, left: 750, resets: "2026-10-15T00:00:00.000Z" });
  assert.equal(parseCredits({}), null);
  assert.equal(parseCredits({ credit_usage_stats: {} }), null);
  assert.equal(parseCredits({ credit_usage_stats: { lead_credit: { left_over: 5 } } }).resets, null);
});

test("error text is plain", () => {
  assert.match(errorText(401), /key/);
  assert.match(errorText(403), /master key/);
  assert.match(errorText(429), /rate-limited/);
  assert.match(errorText(503), /its side/);
  assert.equal(stopReason(429), "Apollo rate-limited the rest.");
  assert.equal(stopReason(401).startsWith("Apollo"), true);
  assert.equal(stopReason(500), "");
});

test("shortDate", () => {
  assert.equal(shortDate("2026-10-15T00:00:00.000Z"), "15 Oct");
  assert.equal(shortDate(null), "");
  assert.equal(shortDate("nope"), "");
});

test("cleanIds dedupes, drops junk, caps at 100", () => {
  assert.deepEqual(cleanIds(["a", "b", "a", "", 3, " b "]), ["a", "b"]);
  const many = Array.from({ length: 500 }, (_, i) => `id${i}`);
  assert.equal(cleanIds(many).length, 100);
  assert.deepEqual(cleanIds("x"), []);
});

test("confirmOptions with and without balance", () => {
  const c = confirmOptions(10, { left: 750, resets: "2026-10-15T00:00:00.000Z" });
  assert.equal(c.title, "Reveal 10 people?");
  assert.equal(c.confirm, "Spend up to 10 credits");
  assert.deepEqual(c.lines, [
    "Up to 10 email credits: Apollo charges only for people it finds.",
    "Left now: 750 · after: at least 740",
    "Resets 15 Oct",
    "Apollo phone numbers aren't supported yet.",
  ]);
  const n = confirmOptions(1, null);
  assert.equal(n.title, "Reveal 1 person?");
  assert.equal(n.lines[1], "Balance unavailable: your key can't read credit usage.");
  assert.equal(confirmOptions(500, { left: 3, resets: null }).lines[1], "Left now: 3 · after: at least 0");
});

// A fake wibble: routes by URL, records calls, answers confirm as told.
function fake({ answer = true, credits = { status: 200, body: CREDITS }, match = () => ({ status: 200, body: MATCH("x") }) } = {}) {
  const w = { calls: [], confirms: [], handlers: {} };
  w.net = {
    fetch: async (url, init) => {
      w.calls.push({ url, init });
      if (url === CREDITS_URL) return { status: credits.status, headers: {}, body: JSON.stringify(credits.body) };
      if (url === MATCH_URL) {
        const r = match(JSON.parse(init.body).id, w.calls.filter((c) => c.url === MATCH_URL).length);
        return { status: r.status, headers: {}, body: JSON.stringify(r.body) };
      }
      if (url === SEARCH_URL) return { status: 200, headers: {}, body: JSON.stringify(SEARCH) };
      throw new Error("unexpected " + url);
    },
  };
  w.confirm = async (o) => { w.confirms.push(o); return typeof answer === "function" ? answer() : answer; };
  w.handle = (n, f) => { w.handlers[n] = f; };
  return w;
}

test("reveal: confirmed spend calls match once per id, in order, key by placeholder", async () => {
  const w = fake({ match: (id) => ({ status: 200, body: MATCH(id) }) });
  const r = await reveal(w, ["a", "b", "a"]);
  assert.equal(r.requested, 2);
  assert.deepEqual(r.people.map((p) => p.id), ["a", "b"]);
  assert.equal(r.stopped, undefined);
  assert.equal(w.confirms.length, 1);
  const matches = w.calls.filter((c) => c.url === MATCH_URL);
  assert.deepEqual(matches.map((c) => JSON.parse(c.init.body)), [{ id: "a" }, { id: "b" }]);
  for (const c of w.calls) assert.equal(c.init.headers["X-Api-Key"], "{{secret:api-key}}");
  assert.ok(!w.calls.some((c) => /phone/.test(c.init.body)));
});

test("reveal: cancel spends nothing", async () => {
  const w = fake({ answer: false });
  await assert.rejects(reveal(w, ["a"]), /You cancelled the spend\./);
  assert.equal(w.calls.filter((c) => c.url === MATCH_URL).length, 0);
});

test("reveal: a non-true answer is a cancel", async () => {
  const w = fake({ answer: "yes" });
  await assert.rejects(reveal(w, ["a"]), /cancelled/);
  assert.equal(w.calls.filter((c) => c.url === MATCH_URL).length, 0);
});

test("reveal: 500 ids are capped at 100 and the dialog says so", async () => {
  const w = fake({ match: (id) => ({ status: 200, body: MATCH(id) }) });
  const r = await reveal(w, Array.from({ length: 500 }, (_, i) => `id${i}`));
  assert.equal(r.requested, 100);
  assert.equal(w.confirms[0].title, "Reveal 100 people?");
  assert.equal(w.calls.filter((c) => c.url === MATCH_URL).length, 100);
});

test("reveal: balance unavailable still asks, and says so", async () => {
  const w = fake({ credits: { status: 403, body: {} }, match: (id) => ({ status: 200, body: MATCH(id) }) });
  await reveal(w, ["a"]);
  assert.match(w.confirms[0].lines[1], /^Balance unavailable/);
});

test("reveal: stops on 429 and reports how far it got", async () => {
  const w = fake({ match: (id, n) => (n <= 2 ? { status: 200, body: MATCH(id) } : { status: 429, body: {} }) });
  const r = await reveal(w, ["a", "b", "c", "d"]);
  assert.equal(r.people.length, 2);
  assert.equal(r.requested, 4);
  assert.equal(r.stopped, "Apollo rate-limited the rest.");
  assert.equal(w.calls.filter((c) => c.url === MATCH_URL).length, 3);
});

test("reveal: stops on 401; a person with no match is skipped, not fatal", async () => {
  const w = fake({ match: (id, n) => (n === 1 ? { status: 200, body: {} } : n === 2 ? { status: 200, body: MATCH(id) } : { status: 401, body: {} }) });
  const r = await reveal(w, ["a", "b", "c"]);
  assert.deepEqual(r.people.map((p) => p.id), ["b"]);
  assert.match(r.stopped, /key/);
});

test("reveal: a second reveal while one waits is refused, then allowed after", async () => {
  let release;
  const gate = new Promise((res) => (release = res));
  const w = fake({ answer: () => gate, match: (id) => ({ status: 200, body: MATCH(id) }) });
  const first = reveal(w, ["a"]);
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(reveal(w, ["b"]), /A reveal is already waiting on you\./);
  release(true);
  assert.equal((await first).people.length, 1);
  w.confirm = async () => true;
  assert.equal((await reveal(w, ["c"])).requested, 1);
});

test("reveal: empty input is refused before any request", async () => {
  const w = fake();
  await assert.rejects(reveal(w, []), /No people/);
  assert.equal(w.calls.length, 0);
});

test("activate: tools never reveal; only page:reveal does", async () => {
  const w = fake();
  await activate(w);
  assert.deepEqual(Object.keys(w.handlers).sort(), ["page:credits", "page:reveal", "page:search", "tool:credits", "tool:search"]);
  const r = await w.handlers["tool:search"]({ titles: ["ceo"] });
  assert.equal(r.people.length, 2);
  const c = await w.handlers["tool:credits"]();
  assert.equal(c.left, 750);
  assert.equal(w.calls.filter((x) => x.url === MATCH_URL).length, 0);
});

test("errors are plain for 401 and 429 on search", async () => {
  const w = fake();
  w.net.fetch = async () => ({ status: 401, headers: {}, body: "{}" });
  await activate(w);
  await assert.rejects(w.handlers["tool:search"]({}), /didn't accept the API key/);
  w.net.fetch = async () => ({ status: 429, headers: {}, body: "{}" });
  await assert.rejects(w.handlers["tool:credits"](), /rate-limited/);
  w.net.fetch = async () => { throw new Error("no secret set"); };
  await assert.rejects(w.handlers["tool:search"]({}), /No Apollo API key/);
});

test("manifest shape and no key in files", () => {
  const m = JSON.parse(readFileSync(new URL("./wibble.json", import.meta.url), "utf8"));
  assert.deepEqual(m.capabilities, ["net.fetch", "confirm", "agent.tools", "page.calls"]);
  assert.deepEqual(m.hosts, ["api.apollo.io"]);
  assert.equal(m.secrets[0].name, "api-key");
  assert.deepEqual(m.tools.map((t) => t.name), ["search", "credits"]);
  assert.deepEqual(m.pageCalls, ["credits", "reveal", "search"]);
  const src = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  assert.ok(!/reveal_phone/.test(src));
});
