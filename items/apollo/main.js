// apollo/main.js
//
// Apollo people search and email reveal, for agents and for pages on the
// canvas. Searching and reading the balance cost nothing. REVEALING spends
// Apollo credits, so it exists only as a page call, and only after the
// operator presses the confirm button in the dialog the app draws. No agent
// tool reveals. Phone numbers are never requested.
//
// The API key is never in this file: requests carry the placeholder
// "{{secret:api-key}}" and the app fills it in on the way out.

const BASE = "https://api.apollo.io/api/v1";
export const SEARCH_URL = `${BASE}/mixed_people/api_search`;
export const MATCH_URL = `${BASE}/people/match`;
export const CREDITS_URL = `${BASE}/usage_stats/credit_usage_stats`;
export const MAX_REVEAL = 100;
export const MAX_PER_PAGE = 100;

// ---- pure helpers ---------------------------------------------------

function list(v) {
  if (v === undefined || v === null) return [];
  const a = Array.isArray(v) ? v : [v];
  return a.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
}

function str(v) {
  return typeof v === "string" ? v : "";
}
function num(v) {
  return Number.isFinite(v) ? v : null;
}

/** Request body for api_search. Unset filters are left out entirely. */
export function searchBody(args = {}) {
  const a = args && typeof args === "object" ? args : {};
  const body = {};
  const put = (key, v) => {
    const l = list(v);
    if (l.length) body[key] = l;
  };
  put("person_titles", a.titles);
  put("person_seniorities", a.seniorities);
  put("person_locations", a.person_locations);
  put("organization_locations", a.org_locations);
  put("organization_num_employees_ranges", a.employee_ranges);
  put("q_organization_keyword_tags", a.keywords);
  const page = Math.floor(Number(a.page));
  body.page = Number.isFinite(page) && page >= 1 ? page : 1;
  const per = Math.floor(Number(a.per_page));
  body.per_page = Number.isFinite(per) ? Math.min(MAX_PER_PAGE, Math.max(1, per)) : MAX_PER_PAGE;
  return body;
}

/** Body for people/match. Only an id: never a phone-number flag. */
export function matchBody(id) {
  return { id: String(id) };
}

/** api_search response -> the people a board needs (no emails yet). */
export function parseSearch(body) {
  const b = body && typeof body === "object" ? body : {};
  const people = (Array.isArray(b.people) ? b.people : [])
    .filter((p) => p && typeof p.id === "string" && p.id)
    .map((p) => ({
      id: p.id,
      firstName: str(p.first_name),
      lastName: str(p.last_name_obfuscated),
      title: str(p.title),
      company: str(p.organization && p.organization.name),
      hasEmail: p.has_email === true,
    }));
  const total = Number.isFinite(b.total_entries) ? b.total_entries : people.length;
  return { total, people };
}

/** people/match response -> a revealed person, or null when none found. */
export function parseMatch(body) {
  const p = body && typeof body === "object" ? body.person : null;
  if (!p || typeof p !== "object") return null;
  const org = p.organization && typeof p.organization === "object" ? p.organization : {};
  const name = str(p.name) || [str(p.first_name), str(p.last_name)].filter(Boolean).join(" ");
  return {
    id: str(p.id),
    name,
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    email: str(p.email),
    title: str(p.title),
    company: str(org.name) || str(p.organization_name),
    domain: str(org.primary_domain),
    linkedin: str(p.linkedin_url),
  };
}

/** credit_usage_stats response -> balance, or null when it has none. */
export function parseCredits(body) {
  const lead = body && body.credit_usage_stats && body.credit_usage_stats.lead_credit;
  if (!lead || typeof lead !== "object") return null;
  const cycle = body.current_credit_cycle;
  return {
    limit: num(lead.limit),
    consumed: num(lead.consumed),
    left: num(lead.left_over),
    resets: cycle && typeof cycle.end_date === "string" ? cycle.end_date : null,
  };
}

/** Plain-words reason for a failed Apollo call. */
export function errorText(status) {
  if (status === 401) return "Apollo didn't accept the API key. Check it in Settings.";
  if (status === 403) return "Apollo says this key can't do that. Credit balance needs a master key.";
  if (status === 422) return "Apollo didn't understand that search.";
  if (status === 429) return "Apollo rate-limited the request. Try again in a minute.";
  if (status >= 500) return "Apollo had a problem on its side. Try again shortly.";
  return `Apollo answered with an error (${status}).`;
}

/** The reason a reveal stopped early, or "" when the status doesn't stop it. */
export function stopReason(status) {
  if (status === 401) return "Apollo didn't accept the API key.";
  if (status === 429) return "Apollo rate-limited the rest.";
  return "";
}

/** "2026-10-15T00:00:00.000Z" -> "15 Oct", or "" when unreadable. */
export function shortDate(iso) {
  if (typeof iso !== "string") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return "";
  return `${Number(m[3])} ${months[mo - 1]}`;
}

/** Unique string ids, in order, capped at MAX_REVEAL. */
export function cleanIds(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_REVEAL) break;
  }
  return out;
}

/** The dialog the operator answers before any credit is spent. */
export function confirmOptions(n, credits) {
  const lines = [`Up to ${n} email credits: Apollo charges only for people it finds.`];
  if (credits && credits.left !== null) {
    lines.push(`Left now: ${credits.left} · after: at least ${Math.max(0, credits.left - n)}`);
  } else {
    lines.push("Balance unavailable: your key can't read credit usage.");
  }
  const date = credits ? shortDate(credits.resets) : "";
  if (date) lines.push(`Resets ${date}`);
  lines.push("Apollo phone numbers aren't supported yet.");
  return {
    title: `Reveal ${n} ${n === 1 ? "person" : "people"}?`,
    lines,
    confirm: `Spend up to ${n} credits`,
  };
}

// ---- wiring ---------------------------------------------------------

class ApolloError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function post(wibble, url, body) {
  let res;
  try {
    res = await wibble.net.fetch(url, {
      method: "POST",
      headers: {
        "X-Api-Key": "{{secret:api-key}}",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "";
    if (/secret|key/i.test(msg)) {
      throw new ApolloError(401, "No Apollo API key yet. Add one in Settings → Agents → Connections.");
    }
    throw new ApolloError(0, "Couldn't reach Apollo. Check your connection.");
  }
  if (res.status < 200 || res.status >= 300) throw new ApolloError(res.status, errorText(res.status));
  try {
    return JSON.parse(res.body);
  } catch {
    throw new ApolloError(res.status, "Apollo sent something unreadable.");
  }
}

export async function search(wibble, args) {
  return parseSearch(await post(wibble, SEARCH_URL, searchBody(args)));
}

export async function credits(wibble) {
  const c = parseCredits(await post(wibble, CREDITS_URL, {}));
  if (!c) throw new ApolloError(403, "Apollo didn't report a credit balance. It needs a master API key.");
  return c;
}

let revealing = false;

/** Reveal work emails. Spends credits, so it never runs without a yes. */
export async function reveal(wibble, ids) {
  if (revealing) throw new Error("A reveal is already waiting on you.");
  revealing = true;
  try {
    const list = cleanIds(ids);
    if (list.length === 0) throw new Error("No people to reveal.");
    let bal = null;
    try {
      bal = await credits(wibble);
    } catch {
      bal = null; // the dialog says "Balance unavailable"
    }
    const yes = await wibble.confirm(confirmOptions(list.length, bal));
    if (yes !== true) throw new Error("You cancelled the spend.");
    const people = [];
    let stopped;
    for (const id of list) {
      let body;
      try {
        body = await post(wibble, MATCH_URL, matchBody(id));
      } catch (e) {
        if (e.status === 0) {
          stopped = "Couldn't reach Apollo for the rest.";
          break;
        }
        const why = stopReason(e.status);
        if (why) {
          stopped = why;
          break;
        }
        continue; // one person Apollo couldn't answer for: move on
      }
      const p = parseMatch(body);
      if (p) people.push({ ...p, id: p.id || id });
    }
    return stopped ? { people, requested: list.length, stopped } : { people, requested: list.length };
  } finally {
    revealing = false;
  }
}

export async function activate(wibble) {
  wibble.handle("tool:search", (a) => search(wibble, a));
  wibble.handle("tool:credits", () => credits(wibble));
  wibble.handle("page:search", (a) => search(wibble, a));
  wibble.handle("page:credits", () => credits(wibble));
  wibble.handle("page:reveal", (v) => reveal(wibble, v && !Array.isArray(v) ? v.ids : v));
}
