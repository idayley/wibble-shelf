/* THE FUNDRAISING KIT'S SHARED RULES. Every page needs the same phase,
   the same "next for you", the same idea of quiet and the same field
   notes, or the strip, the pages and the agents drift apart. Pure
   functions, no DOM, no window. This file is the only copy:
   sync-core.mjs pastes it into each page's <script id="core">, and
   core.test.mjs runs it under node.

   Dates are ISO day strings ("2026-10-01") in the operator's local time. */

var DAY = 24 * 60 * 60 * 1000;
var QUIET_AFTER = 10;
var PREPARE_DAYS = 20;
var MEETINGS_BEFORE_CLOSE = 15;

var STEPS = ["Researched", "Intro asked", "Intro made", "First meeting", "Follow-up", "Partner meeting", "Diligence", "Terms", "Signed"];

var PHASES = [
  { name: "Prepare", why: "Story, investor list, first updates to people you know" },
  { name: "Meetings", why: "First meetings packed close so interest overlaps" },
  { name: "Close", why: "Leads first, a deadline, SAFEs signed" },
  { name: "Backup", why: "A second wave or a smaller angel round" },
];

var SRC_PG = "Paraphrasing Paul Graham, “How to Raise Money”";
var SRC_SU = "Paraphrasing Mark Suster, “Invest in Lines, Not Dots”";
var SRC_VD = "Paraphrasing Brad Feld & Jason Mendelson, Venture Deals";
var SRC_SH = "Paraphrasing Scott Kupor, Secrets of Sand Hill Road";
var SRC_HO = "Paraphrasing the Holloway Guide to Raising Venture Capital";
var SRC_CA = "Paraphrasing Jason Calacanis, Angel";
var WEEK_IDS = { p1: 1, p2: 1, p5: 1, m1: 1, m4: 1, m5: 1, c1: 1, c4: 1, c2: 1, b4: 1, b3: 1, b1: 1 };

/* The 25 field notes: [id, phase, title, text, source, where else it shows]. */
var GUIDE = [
  ["p1", 0, "Lines, not dots", "Investors trust a trend they watched more than one good meeting. Send a short update before you ask for money, so by the time you ask they’ve seen you improve.", SRC_SU, "the monthly update"],
  ["p2", 0, "Start with people who know you", "People who already know you are the fastest first meetings, and their interest makes the next investors take you seriously.", SRC_PG, "day one"],
  ["p5", 0, "What a SAFE is", "Investors give money now and get shares later, when you raise a priced round. The cap is the highest valuation their money converts at. Post-money makes ownership easy to work out up front.", SRC_VD, "The round"],
  ["p3", 0, "Choosing who", "Check two things first: does this investor lead rounds at your stage, and do they write checks your size? A round needs a lead; followers wait for one.", SRC_VD, "Researched"],
  ["p4", 0, "Not at fit yet", "Pre-seed investors back the team, an insight others missed, and how fast you learn. An honest “not yet, and here’s the evidence” reads as on track.", SRC_PG + ", and Scott Kupor, Secrets of Sand Hill Road", "Story"],
  ["p6", 0, "Asking for an intro", "Make it easy to say yes: ask the connector first if they’re comfortable, then send a short email they can forward without editing.", SRC_HO, "Intro asked"],
  ["p7", 0, "Cold notes", "Cold notes work less often than intros, so they’re the fallback. Keep it short, lead with the most surprising thing you’ve learned, and make one ask.", SRC_HO, "cold notes"],
  ["m1", 1, "Pack first meetings together", "Meet investors in a short burst rather than one at a time. Interest overlaps, investors see others are looking, and the pitch improves fast.", SRC_PG, "Meetings week"],
  ["m2", 1, "When the intro lands", "Reply within a day: thank the connector, move them to bcc, and offer two specific times.", SRC_HO, "Intro made"],
  ["m3", 1, "The first meeting", "Most of a fund’s returns come from a few huge outcomes, so investors listen for how big this could get, not how safe it is.", SRC_SH, "First meeting"],
  ["m4", 1, "Before each meeting", "Know what they’ve backed and how big their checks are. Lead with your strongest evidence, and know which hard question they’ll likely ask.", SRC_VD, "prep sheets"],
  ["m5", 1, "Follow up within a day", "Send what you promised within 24 hours. Speed here reads as how you’ll run the company.", SRC_HO, "Follow-up"],
  ["m6", 1, "Reading interest", "Investors rarely say no outright. Treat it as no until it’s an unambiguous yes, and keep meeting others meanwhile.", SRC_PG, "Meetings"],
  ["m9", 1, "A real next step", "Interest shows in actions with dates: a partner meeting, a request for customer calls. Warm words without a date don’t count yet.", SRC_PG, "Meetings"],
  ["m7", 1, "The partner meeting", "At a fund, the person you met has to win over their partners. Give them what they need to argue for you, in a form they can forward.", SRC_SH, "Partner meeting"],
  ["m8", 1, "When it goes quiet", "Silence after a meeting is common and not a verdict. Send news, not a nudge: what you learned since you last spoke.", SRC_SU, "quiet investors"],
  ["c1", 2, "Momentum", "The first commitment makes the rest easier, because investors take comfort from other investors. Put your effort where a yes is closest.", SRC_PG, "Close week"],
  ["c4", 2, "Set a close date", "Give interested investors a real date for the round. A date turns “maybe later” into a decision.", SRC_VD, "Close week"],
  ["c2", 2, "Diligence at pre-seed", "Early diligence is light: references on the founders and a few customer conversations. Your Discovery calls are those references.", SRC_VD, "Diligence"],
  ["c3", 2, "Reading the terms", "On a SAFE the numbers that matter are the amount and the cap. Have a lawyer read anything beyond the standard form, such as side letters or extra rights.", SRC_VD, "Terms"],
  ["c5", 2, "After they sign", "Thank them, add them to the monthly update, and ask who else they’d introduce you to. Investors often bring the next investor.", SRC_PG, "Signed"],
  ["b1", 3, "After a pass", "A pass now is often a yes next round. Keep them on the monthly update; they’ll have watched you improve.", SRC_SU, "Keep updated"],
  ["b2", 3, "A clear pass is useful", "Write down the bar they named, like “come back with revenue”, and tell them when you clear it.", SRC_SU, "Meetings"],
  ["b3", 3, "A smaller angel round", "Angels decide faster and write smaller checks, and several together can make a round. Useful if funds move slowly.", SRC_CA, "Backup week"],
  ["b4", 3, "The holiday slowdown", "Most investors go quiet from mid-December to early January. Aim to have signatures before then.", "Widely reported by founders; not from one book", "Backup week"],
].map(function (g) {
  return { id: g[0], phase: g[1], title: g[2], text: g[3], src: g[4], where: g[5], week: !!WEEK_IDS[g[0]] };
});

/* The five hard questions, and why each is asked. */
var WHY_THEY_ASK = [
  { id: "pmf", text: "Do you have product-market fit?", why: "They want to see you know the difference between interest and fit. An honest “not yet, here’s the evidence” is the strong answer.", src: SRC_PG },
  { id: "big", text: "How big can this get?", why: "A fund’s returns come from a few very large companies, so each investment has to be able to become one.", src: SRC_SH },
  { id: "pay", text: "Will they pay, or just complain?", why: "Commitment before a product exists is the strongest early signal you can show.", src: SRC_VD },
  { id: "why", text: "Why are you two the ones to build this?", why: "At pre-seed, the team is most of what an investor can judge.", src: SRC_PG },
  { id: "now", text: "Why now?", why: "Timing explains why nobody has solved it yet.", src: SRC_HO },
];

/* Which field note each investor step, draft kind and reading opens. */
var STEP_NOTE = { 0: "p3", 1: "p6", 2: "m2", 3: "m3", 4: "m5", 5: "m7", 6: "c2", 7: "c3", 8: "c5", quiet: "m8", passed: "b1" };
var DRAFT_NOTE = { intro: "p6", cold: "p7", reply: "m2", followup: "m5", prep: "m4", checkin: "m8", update: "p1" };
var READING_NOTE = { next: "m9", maybe: "m6", pass: "b2", intro: "m3" };

/* ---- dates --------------------------------------------------------------- */

function pad2(n) { return (n < 10 ? "0" : "") + n; }

/* An ISO day in the operator's local time, from a time, a Date or a day. */
function isoDay(t) {
  if (typeof t === "string" && /^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  var d = t instanceof Date ? t : new Date(t == null ? Date.now() : t);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function dayNum(iso) {
  var p = String(iso).split("-");
  return Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY;
}

function fromDayNum(n) {
  var d = new Date(n * DAY);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

function addDays(iso, n) { return fromDayNum(dayNum(iso) + n); }
function diffDays(a, b) { return Math.round(dayNum(a) - dayNum(b)); }

function validDay(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(dayNum(v)); }

/* ---- records ------------------------------------------------------------- */

/* Records out of the store, by kind. read is the map of field-note ids
   the operator has read. */
function records(data) {
  var out = { settings: (data && data.settings) || {}, investors: [], drafts: [], meetings: [], questions: [], read: (data && data.read && typeof data.read === "object") ? data.read : {} };
  for (var k in data || {}) {
    var v = data[k];
    if (!v || typeof v !== "object") continue;
    if (k.indexOf("investor:") === 0) out.investors.push(Object.assign({ id: k.slice(9) }, v));
    else if (k.indexOf("draft:") === 0) out.drafts.push(Object.assign({ id: k.slice(6) }, v));
    else if (k.indexOf("meeting:") === 0) out.meetings.push(Object.assign({ id: k.slice(8) }, v));
    else if (k.indexOf("question:") === 0) out.questions.push(Object.assign({ id: k.slice(9) }, v));
  }
  return out;
}

/* ---- the round and its phases ------------------------------------------- */

function clampDay(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/* The round's dates and the four phases. Start defaults to today, close-by
   to Nov 30 and must-close to Dec 15 of the year it falls in. Prepare runs
   20 days from the start, Meetings to 15 days before close-by, Close to
   close-by, Backup to must-close. Each boundary is clamped so a phase is
   at least a day long and the phases never overlap, even when close-by
   comes early. */
function roundOf(settings, now) {
  var s = (settings && settings.round) || {};
  var today = isoDay(now);
  var start = validDay(s.start) ? s.start : today;
  var year = +start.slice(0, 4);
  var closeBy = validDay(s.closeBy) ? s.closeBy : year + "-11-30";
  var mustClose = validDay(s.mustClose) ? s.mustClose : year + "-12-15";
  if (!validDay(s.closeBy) && closeBy < start) closeBy = (year + 1) + "-11-30";
  if (!validDay(s.mustClose) && mustClose < closeBy) mustClose = closeBy.slice(0, 4) + "-12-15";
  var st = dayNum(start);
  var e3 = Math.max(dayNum(mustClose), st + 3);
  var e2 = clampDay(dayNum(closeBy), st + 2, e3 - 1);
  var e1 = clampDay(dayNum(closeBy) - MEETINGS_BEFORE_CLOSE, st + 1, e2 - 1);
  var e0 = clampDay(st + PREPARE_DAYS - 1, st, e1 - 1);
  var ends = [e0, e1, e2, e3];
  var phases = PHASES.map(function (p, i) {
    return { name: p.name, from: fromDayNum(i === 0 ? st : ends[i - 1] + 1), to: fromDayNum(ends[i]) };
  });
  return { start: start, closeBy: closeBy, mustClose: mustClose, phases: phases };
}

/* Which phase today is in: 0 to 3. Before the start is Prepare, after the
   last day is Backup. */
function phaseAt(round, now) {
  var today = isoDay(now);
  for (var i = 0; i < round.phases.length; i++) {
    if (today <= round.phases[i].to) return i;
  }
  return round.phases.length - 1;
}

/* Whole days since last contact, when the investor has gone quiet: 11 or
   more days with no next step due still ahead. Passed and signed
   investors aren't quiet. Otherwise null. */
function quietDays(inv, now) {
  if (!inv || inv.passed || inv.step === 8 || !validDay(inv.lastContact)) return null;
  var today = isoDay(now);
  var days = diffDays(today, inv.lastContact);
  if (days <= QUIET_AFTER) return null;
  if (inv.next && validDay(inv.next.due) && inv.next.due >= today) return null;
  return days;
}

/* ---- hard questions ------------------------------------------------------ */

/* "ready", "needs" or "yours". The founders' own two (why, now) are never
   drafted, so they read "yours" until something is written. A drafted
   answer that is missing, or marked needs, needs evidence. */
function questionStatus(r, id) {
  var q = null;
  for (var i = 0; i < r.questions.length; i++) if (r.questions[i].id === id) q = r.questions[i];
  var written = !!(q && typeof q.answer === "string" && q.answer.trim());
  if (id === "why" || id === "now") return written ? "ready" : "yours";
  if (q && q.status === "ready") return "ready";
  if (q && !q.status && written) return "ready";
  return "needs";
}

var DRAFTED = ["pmf", "big", "pay"];

/* The hard questions that still need evidence: the three drafted ones, and
   any a meeting added that is marked needs. */
function questionsNeeding(r) {
  var ids = DRAFTED.filter(function (id) { return questionStatus(r, id) !== "ready"; });
  r.questions.forEach(function (q) {
    if (DRAFTED.indexOf(q.id) < 0 && q.id !== "why" && q.id !== "now" && q.status === "needs") ids.push(q.id);
  });
  return ids;
}

/* ---- what to do next ----------------------------------------------------- */

function sentAny(r) { return r.drafts.some(function (d) { return d.status === "sent"; }); }

function liveInvestors(r) { return r.investors.filter(function (i) { return !i.passed; }); }

function byDue(a, b) { return a.next.due < b.next.due ? -1 : a.next.due > b.next.due ? 1 : 0; }

/* What the operator does next, as the strip and the zone ring say it.
   zone is one of the kit's zone keys (progress, story, investors, send,
   meetings). cap is the small label over it. During day one, start lists
   the three starting moves. */
function nextFor(r, now) {
  var today = isoDay(now);
  var haveInv = r.investors.length > 0;
  var roundSet = !!(r.settings.round && r.settings.round.set);
  var answered = DRAFTED.every(function (id) { return questionStatus(r, id) === "ready"; });
  var done = (haveInv ? 1 : 0) + (roundSet ? 1 : 0) + (answered ? 1 : 0);
  var dayOne = !(haveInv && roundSet && answered && sentAny(r));
  function out(zone, text, cap, start) {
    var o = { zone: zone, text: text, cap: cap || "NEXT FOR YOU" };
    if (start) o.start = start;
    return o;
  }
  if (dayOne) {
    var start = [
      { label: "Add the investors you know", done: haveInv },
      { label: "Set the round", done: roundSet },
      { label: "Fill answers from Discovery", done: answered },
    ];
    var cap = done < 3 ? "START HERE · " + done + " OF 3 DONE" : "NEXT FOR YOU";
    if (!haveInv) return out("investors", "Add the investors you already know in 2 · Investors. Names are enough.", cap, start);
    if (!roundSet) return out("story", "Set the round in 1 · Story: how much, and what it buys.", cap, start);
    if (!answered) return out("story", "Press Fill answers from Discovery in 1 · Story. Your calls already hold the evidence.", cap, start);
    if (!r.drafts.length) return out("investors", "You’re set up. Pick someone you know in 2 · Investors and draft a first note.", cap, start);
    return out("send", "Send your note from 3 · To send, then press Sent. That’s the raise started.", cap, start);
  }
  var live = liveInvestors(r);
  var byId = {};
  r.investors.forEach(function (i) { byId[i.id] = i; });
  // A follow-up request from a meeting is a step due today.
  var asks = r.drafts.filter(function (d) { return d.status === "requested"; });
  if (asks.length) {
    var who = byId[asks[0].investor];
    return out("send", "Draft the follow-up for " + (who && who.name ? who.name : "your last meeting") + " in 3 · To send. Within a day reads as how you’ll run the company.");
  }
  var due = live.filter(function (i) { return i.next && validDay(i.next.due) && i.next.due <= today; }).sort(byDue);
  if (due.length) return out("investors", due[0].name + ": " + due[0].next.text + ". Due " + (due[0].next.due === today ? "today" : "since " + due[0].next.due) + ", in 2 · Investors.");
  var needing = questionsNeeding(r);
  if (needing.length) {
    return out("story", (needing.length === 1 ? "A hard question still needs" : needing.length + " hard questions still need") + " evidence. Press Fill answers from Discovery in 1 · Story.");
  }
  var soon = live.filter(function (i) { return i.next && validDay(i.next.due); }).sort(byDue);
  if (soon.length) return out("investors", soon[0].name + ": " + soon[0].next.text + ". Due " + soon[0].next.due + ", in 2 · Investors.");
  return out("investors", "Pick an investor in 2 · Investors and set their next step.");
}

/* The quietest investor, as one line for under Next for you, or null. */
function alsoWaiting(r, now) {
  var best = null, days = 0;
  r.investors.forEach(function (i) {
    var q = quietDays(i, now);
    if (q != null && q > days) { best = i; days = q; }
  });
  return best ? best.name + " has been quiet " + days + " days" : null;
}

/* ---- field notes --------------------------------------------------------- */

/* The three This week notes for a phase. */
function weekNotes(phase) {
  return GUIDE.filter(function (g) { return g.phase === phase && g.week; });
}

/* How many of a phase's This week notes are still unread. */
function unreadWeek(r, phase) {
  return weekNotes(phase).filter(function (g) { return !r.read[g.id]; }).length;
}

/* ---- Discovery ----------------------------------------------------------- */

function commitmentLive(c, now) {
  if (!c) return false;
  var s = c.status;
  if (s === "lapsed" || s === "broken" || s === "declined" || s === "withdrawn") return false;
  if (s === "fulfilled" || s === "kept") return true;
  var due = Date.parse(c.due);
  if (isNaN(due) || !isFinite(now)) return true;
  return due + 14 * DAY >= now;
}

/* What the Story page says about Discovery, from a Discovery store: calls
   with a person, how many scored 4 or 5 (hair on fire), people holding a
   live commitment, the strongest quote with who said it, and how many
   times the bets were sharpened. any is false until there is a call. */
function fromDiscovery(data, now) {
  var calls = 0, hot = 0, sharpened = 0, best = null, who = {};
  var committed = {};
  var ms = typeof now === "number" ? now : Date.parse(now);
  for (var k in data || {}) {
    var v = data[k];
    if (!v || typeof v !== "object") continue;
    if (k.indexOf("person:") === 0) who[k.slice(7)] = v;
    else if (k.indexOf("market:") === 0) {
      var bv = v.bet && Number(v.bet.v);
      if (isFinite(bv) && bv > 1) sharpened += bv - 1;
    }
  }
  for (var k2 in data || {}) {
    if (k2.indexOf("call:") !== 0) continue;
    var c = data[k2];
    if (!c || typeof c !== "object" || !c.person) continue;
    calls++;
    var lv = Number(c.level) || 0;
    if (lv >= 4) hot++;
    if (c.commitment && commitmentLive(c.commitment, ms)) committed[c.person] = true;
    if (typeof c.quote === "string" && c.quote.trim() && (!best || lv > best.lv)) best = { lv: lv, text: c.quote.trim(), person: c.person };
  }
  var quote = null;
  if (best) {
    var p = who[best.person];
    quote = { text: best.text, who: (p && p.name) || "" };
  }
  return { calls: calls, hot: hot, commits: Object.keys(committed).length, quote: quote, sharpened: sharpened, any: calls > 0 };
}

/* ---- readings ------------------------------------------------------------ */

/* An investor after a meeting read as next, maybe, pass or intro. Returns
   a new record; the input isn't changed. next moves them a step, intro
   books the first meeting, maybe leaves the step, pass marks them
   passed. */
function applyReading(inv, reading, at) {
  var o = Object.assign({}, inv);
  var step = typeof o.step === "number" ? o.step : 0;
  var before = step;
  o.dates = Object.assign({}, o.dates);
  o.lastContact = at;
  if (reading === "next") step = Math.min(8, step + 1);
  else if (reading === "intro") step = Math.max(step, 3);
  else if (reading === "pass") { o.passed = true; o.passedAt = at; }
  if (step !== before) o.dates[step] = at;
  o.step = step;
  return o;
}
