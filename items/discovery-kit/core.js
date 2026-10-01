/* THE DISCOVERY KIT'S SHARED RULES. Every page needs the same count of
   calls, the same verdict and the same "what's next", or the strip, the
   Markets page and the agents drift apart. Pure functions, no DOM, no
   window. This file is the only copy: sync-core.mjs pastes it into each
   page's <script id="core">, and core.test.mjs runs it under node. */

var DAY = 24 * 60 * 60 * 1000;
var LAPSE_DAYS = 14;
var EXTENDED_CALLS = 15;
var DEFAULT_LINE = { calls: 10, hits: 3, commitments: 1 };
var VERDICTS = ["Persevere", "Pivot", "Keep talking"];
var BUYERS = ["budget holder", "decision maker"];

function toMs(t) {
  if (t == null || t === "") return NaN;
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

/* People arrive as a map (id -> person) or a list; either works. */
function peopleIndex(people) {
  if (!people) return {};
  if (Array.isArray(people)) {
    var out = {};
    for (var i = 0; i < people.length; i++) if (people[i] && people[i].id) out[people[i].id] = people[i];
    return out;
  }
  return people;
}

/* The pass line, with the kit's default filling anything left out. The
   store spells it {hits, of, commits}; the older spelling {calls, hits,
   commitments} still reads. */
function lineOf(market) {
  var p = (market && market.passLine) || {};
  function n(v, d) { v = Number(v); return isFinite(v) && v >= 0 ? Math.floor(v) : d; }
  var calls = n(p.of != null ? p.of : p.calls, DEFAULT_LINE.calls) || DEFAULT_LINE.calls;
  return {
    calls: calls,
    hits: n(p.hits, DEFAULT_LINE.hits),
    commitments: n(p.commits != null ? p.commits : p.commitments, DEFAULT_LINE.commitments),
  };
}

function targetOf(market) {
  var line = lineOf(market);
  return market && market.extended ? Math.max(EXTENDED_CALLS, line.calls) : line.calls;
}

function speakerAmbiguous(call) {
  return call.speakerAmbiguous === true || call.speaker === "ambiguous";
}

/* A call that could count, before each person is taken once: in the
   segment, not tainted by a pitch, not a friend or family member, and not
   a low-confidence call where we can't tell who said what. A call with no
   person on the board can't be checked, so it doesn't count. */
function eligible(call, byId) {
  if (!call || !call.person) return false;
  var person = byId[call.person];
  if (call.inSegment === false) return false;
  if (call.tainted) return false;
  if (person && person.relationship === "friend-family") return false;
  if (call.confidence === "low" && speakerAmbiguous(call)) return false;
  return true;
}

function callTime(call) {
  var t = toMs(call.date);
  if (isNaN(t)) t = toMs(call.at);
  return isNaN(t) ? 0 : t;
}

/* A call counts for bet v when it says so, else when it was made under
   that bet. A sharper bet carries over the calls that already described
   its pain; the rest stay with the version they were made under. */
function countsFor(call, v) {
  return call.counts && typeof call.counts[v] === "boolean" ? call.counts[v] : call.betV === v;
}

/* The calls that count toward the pass line: eligible, and each person
   once, their latest call. */
function counted(calls, people) {
  var byId = peopleIndex(people);
  var latest = {};
  var order = [];
  for (var i = 0; i < (calls || []).length; i++) {
    var c = calls[i];
    if (!eligible(c, byId)) continue;
    var prev = latest[c.person];
    if (!prev) { order.push(c.person); latest[c.person] = c; }
    else if (callTime(c) >= callTime(prev)) latest[c.person] = c;
  }
  return order.map(function (p) { return latest[p]; });
}

/* A commitment is live when it was offered or kept and hasn't lapsed. An
   unkept one lapses 14 days after its due date. */
function commitmentLapsed(commitment, now) {
  if (!commitment) return true;
  var s = commitment.status;
  if (s === "fulfilled" || s === "kept") return false;
  if (s === "lapsed" || s === "declined" || s === "withdrawn") return true;
  var due = toMs(commitment.due);
  if (isNaN(due)) return false;
  return due + LAPSE_DAYS * DAY < toMs(now);
}

function orgKey(call, person) {
  var o = (call.org || (person && person.org) || "").trim().toLowerCase();
  return o || null;
}

function marketCalls(market, calls) {
  var id = market && market.id;
  return (calls || []).filter(function (c) { return c && c.market === id; });
}

/* The version of the bet a market is on now. */
function betV(market) {
  var v = market && market.bet && market.bet.v;
  return typeof v === "number" ? v : 1;
}

/* Everything the verdict needs, for one market, from the calls that count
   for its current bet. Commitments come from any eligible call (a
   follow-up call without one doesn't erase an earlier one), one per
   person. Organisations are counted among the hits only. */
function tally(market, calls, people, now) {
  var byId = peopleIndex(people);
  var v = betV(market);
  var mine = marketCalls(market, calls).filter(function (c) { return countsFor(c, v); });
  var cs = counted(mine, byId);
  var line = lineOf(market);
  var ladder = [0, 0, 0, 0, 0, 0];
  var hits = 0, orgs = {}, buyers = 0;
  for (var i = 0; i < cs.length; i++) {
    var c = cs[i], lv = Math.max(0, Math.min(5, Math.round(Number(c.level) || 0)));
    ladder[lv]++;
    if (lv >= 4) {
      hits++;
      var p = byId[c.person];
      var k = orgKey(c, p);
      if (k) orgs[k] = true;
      if (p && BUYERS.indexOf(p.buyingRole) >= 0) buyers++;
    }
  }
  var live = {}, commitments = [];
  for (var j = 0; j < mine.length; j++) {
    var cc = mine[j];
    if (!cc.commitment || !eligible(cc, byId)) continue;
    var lapsed = commitmentLapsed(cc.commitment, now);
    commitments.push({ call: cc.id, person: cc.person, what: cc.commitment.what, currency: cc.commitment.currency, due: cc.commitment.due, status: cc.commitment.status, lapsed: lapsed });
    if (!lapsed) live[cc.person] = true;
  }
  return {
    n: cs.length,
    hits: hits,
    commits: Object.keys(live).length,
    orgs: Object.keys(orgs).length,
    buyers: buyers,
    target: targetOf(market),
    line: line,
    ladder: ladder,
    commitments: commitments,
    notCounted: mine.length - cs.length,
  };
}

/* The pass line may be edited only until the first call is counted. Any
   bet's calls lock it: a sharper bet doesn't reopen the line. */
function lineLocked(market, calls, people) {
  return counted(marketCalls(market, calls), people).length > 0;
}

/* The founder's override wins, and is shown beside the automatic
   verdict, never instead of it. */
function verdict(market, t) {
  var line = t.line || lineOf(market);
  var persevere = t.hits >= line.hits && t.commits >= line.commitments && t.orgs >= 2 && t.buyers >= 1;
  var cantMeet = t.hits + (t.target - t.n) < line.hits;
  var auto = persevere ? "Persevere" : (t.n >= t.target || cantMeet) ? "Pivot" : "Keep talking";
  var closeMiss = auto === "Pivot" && t.hits === line.hits - 1 && t.commits >= 1 && !(market && market.extended);
  var override = market && market.override && VERDICTS.indexOf(market.override.verdict) >= 0 ? market.override : null;
  var out = { auto: auto, closeMiss: closeMiss, shown: override ? override.verdict : auto };
  if (override) out.override = override;
  return out;
}

function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

/* What a tab or the verdict line calls the verdict: a market with no
   counted calls hasn't started. */
function verdictLabel(v, t) {
  return t.n === 0 && !v.override ? "Not started" : v.shown;
}

/* The verdict in one sentence, with counts and never a percentage. */
function verdictLine(market, t, v) {
  var line = t.line;
  if (v.shown === "Persevere") return "Persevere. You can hand this market to Lead finder.";
  if (v.shown === "Pivot") {
    if (v.closeMiss) {
      return "Close miss: " + t.hits + " of " + line.hits + " hair-on-fire, with a commitment. Extend to 15 calls before deciding?";
    }
    return "The pass line was not met. Sharpen the bet or try another market.";
  }
  if (t.n === 0) return "No calls yet. You can still change the pass line.";
  var need = line.hits - t.hits, left = t.target - t.n;
  if (need > 0) {
    return (need === 1 ? "One more hair-on-fire call" : plural(need, "more hair-on-fire call")) +
      " in the next " + left + " makes it Persevere. At Persevere you can hand this market to Lead finder.";
  }
  var lack = [];
  if (t.commits < line.commitments) lack.push("a commitment");
  if (t.orgs < 2) lack.push("a hit from a second organisation");
  if (t.buyers < 1) lack.push("a budget holder or decision maker");
  return "The hits are in. Still missing: " + lack.join(", ") + ".";
}

/* Records out of the store, by kind. */
function records(data) {
  var out = { markets: [], people: {}, calls: [], waves: [], drafts: [], suggest: {}, settings: (data && data.settings) || {} };
  for (var k in data || {}) {
    var v = data[k];
    if (!v || typeof v !== "object") continue;
    if (k.indexOf("market:") === 0) out.markets.push(Object.assign({ id: k.slice(7) }, v));
    else if (k.indexOf("person:") === 0) out.people[v.id || k.slice(7)] = Object.assign({ id: k.slice(7) }, v);
    else if (k.indexOf("call:") === 0) out.calls.push(Object.assign({ id: k.slice(5) }, v));
    else if (k.indexOf("draft:") === 0) out.drafts.push(Object.assign({ id: k.slice(6) }, v));
    else if (k.indexOf("suggest:") === 0) out.suggest[k.slice(8)] = v;
    else if (k.indexOf("wave:") === 0) out.waves.push(Object.assign({ key: k }, v));
  }
  out.markets.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  return out;
}

/* The market the strip and the pages show: the chosen one, else the first. */
function activeOf(r) {
  var id = r.settings && r.settings.active;
  for (var i = 0; i < r.markets.length; i++) if (r.markets[i].id === id) return r.markets[i];
  return r.markets[0] || null;
}

function peopleOf(r, market) {
  var id = market && market.id;
  return Object.keys(r.people).map(function (k) { return r.people[k]; }).filter(function (p) { return p.market === id; });
}

function isPicked(p) {
  var c = p.channels || {};
  return !!(c.email || c.li || c.call);
}

/* The funnel for one market, as counts: found, asked, booked, called, and
   how many of the counted calls were hair-on-fire (level 4 or 5). */
function funnel(market, people, calls) {
  var mine = peopleOf({ people: peopleIndex(people) }, market);
  function n(statuses) { return mine.filter(function (p) { return statuses.indexOf(p.status) >= 0; }).length; }
  var t = tally(market, calls, people, 0);
  return [
    ["Found", mine.length],
    ["Asked", n(["asked", "booked", "called"])],
    ["Booked", n(["booked", "called"])],
    ["Called", n(["called"])],
    ["Hair on fire", t.hits],
  ];
}

/* What the founder does next, for the active market, as the strip and the
   zone badge say it. zone is one of the kit's zone keys; step is which of
   the four steps in the strip is current. */
function nextStep(r, now) {
  var m = activeOf(r);
  function out(zone, text, why, step) {
    var o = { zone: zone, text: text, why: why, step: step };
    if (m && r.suggest && r.suggest[m.id] && r.suggest[m.id].status === "open") o.also = "a sharper bet, suggested in Calls";
    return o;
  }
  if (!m || !m.bet) return out("markets", "Write your first bet", "So you know what to listen for. Do it in 1 · Markets.", 0);
  var mine = peopleOf(r, m);
  if (!mine.length) return out("markets", "Press Find people", "Scout looks for people already showing this pain. It is in 1 · Markets.", 1);
  var touched = mine.some(function (p) { return isPicked(p) || p.status === "asked" || p.status === "booked" || p.status === "called"; });
  if (!touched) return out("people", "Pick who to ask", "In 2 · People, then press Draft asks.", 1);
  var unsent = (r.drafts || []).filter(function (d) { return d.market === m.id && d.status === "draft"; });
  if (unsent.length) return out("send", "Send your asks", "Send the " + unsent.length + " from 3 · To send yourself, then press Sent on each.", 2);
  var booked = mine.some(function (p) { return p.status === "booked"; });
  var scored = marketCalls(m, r.calls).length;
  if (booked && !scored) return out("calls", "Drop the recording after your call", "Debrief scores it in 4 · Calls.", 3);
  var t = tally(m, r.calls, r.people, now == null ? Date.now() : now);
  return out("calls", verdictLine(m, t, verdict(m, t)), "", 3);
}
