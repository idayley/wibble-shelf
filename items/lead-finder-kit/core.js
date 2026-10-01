/* THE LEAD FINDER KIT'S SHARED RULES, AND THE STORE SCHEMA. Every page and
   both agents need the same idea of who is on the board, who is picked,
   what is a draft and what is next, or the progress strip, the board, To
   send and the agents drift apart. Pure functions, no DOM, no window. This
   file is the only copy: sync-core.mjs pastes it into each page's
   <script id="core">, and core.test.mjs runs it under node.

   THE KIT STORE (window.wibble.kit, shared by every page of one placed kit;
   agents reach it with read_pin -> `kit` and set_pin_data {kit: true}).
   One key per record, so the operator and the agents never overwrite each
   other. Agents merge only; they never pass replace.

     request        Lead scout writes. { text, source: "apollo"|"web"|"list", list?, at }
     filters        Lead scout writes. { chips: [{ label, value }], apollo?: {...}, saved?: true }
     person:<id>    Lead scout adds (never overwrites); the operator sets channels on the
                    board and Apollo's reveal fills email, linkedin and revealed.
                    { name, title, company, why, linkedin?, email?, phone?, phoneNote?,
                      source: "apollo"|"web"|"list", apolloId?,
                      channels: { email, call, linkedin }  (all false when written),
                      revealed, revealFailed? }
                    <id> is "a-<apolloId>" for Apollo people, else a slug of name and company.
     draft:<id>     Outreach asker writes; the To send page marks it sent.
                    { person: <person id>, channel: "email"|"call"|"linkedin",
                      subject?  (email only), body, at: <ISO time>,
                      status: "draft"|"sent", sentAt?: <ISO time> }
                    <id> is "<person id>-<channel>", so one draft per person per channel.
                    An agent never rewrites a draft that exists.
     settings       The board writes. { sentKey, sentAt }: the picks last sent to Outreach.

   Wibble never sends, calls or messages anyone, and never spends for the
   operator: every send, call and credit is theirs to press. */

var CHANNELS = [
  { id: "email", label: "Email" },
  { id: "call", label: "Call" },
  { id: "linkedin", label: "LinkedIn" }
];
var SOURCE_NAMES = { apollo: "Apollo", web: "Web search", list: "My list" };

function str(v) { return typeof v === "string" ? v.trim() : ""; }

function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

function toMs(t) {
  if (t == null || t === "") return NaN;
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

/* The channels the operator switched on, in a fixed order. */
function channelsOn(p) {
  var c = (p && p.channels) || {};
  return CHANNELS.filter(function (ch) { return c[ch.id] === true; }).map(function (ch) { return ch.id; });
}

function isPicked(p) { return channelsOn(p).length > 0; }

function labelOf(id) {
  for (var i = 0; i < CHANNELS.length; i++) if (CHANNELS[i].id === id) return CHANNELS[i].label;
  return id;
}

/* Email and LinkedIn come from Apollo's reveal, at one credit a person
   whichever of the two (or both) is picked. Call never costs: a phone
   number comes from a public page Lead scout found, not from Apollo. */
function needsReveal(p) {
  if (!p || p.source !== "apollo" || !p.apolloId || p.revealed || p.revealFailed) return false;
  var on = channelsOn(p);
  return on.indexOf("email") >= 0 || on.indexOf("linkedin") >= 0;
}

/* Apollo ids to reveal: once each. */
function allRevealIds(people) {
  var seen = {}, out = [];
  (people || []).forEach(function (p) {
    if (needsReveal(p) && !seen[p.apolloId]) { seen[p.apolloId] = true; out.push(p.apolloId); }
  });
  return out;
}
function creditsNeeded(people) { return allRevealIds(people).length; }

/* ---- the same person, found again -------------------------------------- */

function linkedinKey(u) {
  return str(u).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function words(s) { return str(s).toLowerCase().replace(/\s+/g, " "); }

/* Apollo id first, then LinkedIn, then name and company. The scout uses
   the same order when it decides whether to add someone. */
function dedupeKey(p) {
  if (p && p.apolloId) return "a:" + p.apolloId;
  var li = linkedinKey(p && p.linkedin);
  if (li) return "l:" + li;
  return "n:" + words(p && p.name) + "|" + words(p && p.company);
}

/* One of each person, keeping the one the operator has already worked on
   (revealed, then picked), else the first. Order of first appearance. */
function uniquePeople(list) {
  var best = {}, order = [];
  (list || []).forEach(function (p) {
    var k = dedupeKey(p);
    var score = (p.revealed ? 2 : 0) + (isPicked(p) ? 1 : 0);
    if (!(k in best)) { best[k] = { p: p, score: score }; order.push(k); }
    else if (score > best[k].score) best[k] = { p: p, score: score };
  });
  return order.map(function (k) { return best[k].p; });
}

/* Records out of the store. */
function records(data) {
  var out = { request: {}, filters: {}, people: [], drafts: [], settings: {} };
  var d = data || {};
  if (d.request && typeof d.request === "object") out.request = d.request;
  if (d.filters && typeof d.filters === "object") out.filters = d.filters;
  if (d.settings && typeof d.settings === "object") out.settings = d.settings;
  for (var k in d) {
    var v = d[k];
    if (!v || typeof v !== "object") continue;
    if (k.indexOf("person:") === 0) out.people.push(Object.assign({}, v, { id: k.slice(7) }));
    else if (k.indexOf("draft:") === 0) out.drafts.push(Object.assign({}, v, { id: k.slice(6) }));
  }
  return out;
}

/* ---- one-time move from the board's own store into the kit store -------- */

/* The board used to keep everything in its own pin store. When the kit
   store has no leads yet and the board's own store does, this is the patch
   that copies request, filters, settings and the people into the kit
   store. The own copy is left as it is: nothing is ever deleted. Returns
   null when there is nothing to move. */
function moveToKit(kitData, ownData) {
  var kit = kitData || {}, own = ownData || {};
  function hasPeople(d) { for (var k in d) if (k.indexOf("person:") === 0 && d[k] && typeof d[k] === "object") return true; return false; }
  if (hasPeople(kit) || !hasPeople(own)) return null;
  var patch = {};
  for (var k in own) {
    var v = own[k];
    if (!v || typeof v !== "object") continue;
    if (k.indexOf("person:") === 0) patch[k] = v;
    else if ((k === "request" || k === "filters" || k === "settings") && !(k in kit)) patch[k] = v;
  }
  return patch;
}

/* ---- Send to Outreach ------------------------------------------------------ */

/* Picked, and nothing left to reveal for them. */
function readyPeople(people) {
  return (people || []).filter(function (p) { return isPicked(p) && !needsReveal(p) && !p.revealFailed; });
}

/* The Picks card Outreach asker reads: each picked person, how the
   operator wants to reach them, and everything known. */
function sendPayload(people, request) {
  var ready = readyPeople(people);
  var req = request || {};
  var lines = [];
  if (str(req.text)) lines.push("Request: " + str(req.text));
  if (SOURCE_NAMES[req.source]) lines.push("Where to look: " + SOURCE_NAMES[req.source]);
  ready.forEach(function (p) {
    lines.push("");
    lines.push("## " + (str(p.name) || "Unnamed"));
    lines.push("Person: " + p.id);
    var who = [str(p.title), str(p.company)].filter(Boolean).join(", ");
    if (who) lines.push(who);
    lines.push("Reach by: " + channelsOn(p).map(labelOf).join(", "));
    if (str(p.email)) lines.push("Email: " + str(p.email));
    if (str(p.linkedin)) lines.push("LinkedIn: " + str(p.linkedin));
    if (str(p.phone)) lines.push("Phone: " + str(p.phone) + (str(p.phoneNote) ? " (" + str(p.phoneNote) + ")" : ""));
    if (str(p.why)) lines.push("Why: " + str(p.why));
  });
  return { zone: "Outreach", title: "Picks: " + plural(ready.length, "person", "people"), text: lines.join("\n").replace(/^\n+/, "") };
}

function sentKeyOf(payload) {
  var s = payload.title + "\n" + payload.text, h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* Whether Send to Outreach is on, and if not why. */
function sendState(people, sentKey, request) {
  var need = creditsNeeded(people);
  var ready = readyPeople(people);
  if (need > 0) return { enabled: false, count: ready.length, why: "Spend " + plural(need, "credit") + " first, or turn Email and LinkedIn off for those people." };
  if (ready.length === 0) return { enabled: false, count: 0, why: "Pick Email, Call or LinkedIn for at least one person." };
  if (sentKey && sentKey === sentKeyOf(sendPayload(people, request))) {
    return { enabled: false, count: ready.length, sent: true, why: "Already sent. Change a pick to send again." };
  }
  return { enabled: true, count: ready.length, why: "" };
}

/* ---- drafts ------------------------------------------------------------------ */

function isSentDraft(d) { return !!d && d.status === "sent"; }

/* What Copy puts on the clipboard: the subject line, then the body. */
function copyText(d) {
  return (str(d && d.subject) ? "Subject: " + str(d.subject) + "\n\n" : "") + ((d && d.body) || "");
}

/* "Email", "Call sheet" or "LinkedIn note": what the draft is. */
function draftKind(d) {
  if (d && d.channel === "call") return "Call sheet";
  if (d && d.channel === "linkedin") return "LinkedIn note";
  return "Email";
}

/* The record the Sent button writes: status and time, nothing else changed. */
function markSent(d, now) {
  var out = Object.assign({}, d, { status: "sent", sentAt: new Date(now == null ? Date.now() : now).toISOString() });
  delete out.id;
  return out;
}

function byTimeDesc(key) {
  return function (a, b) {
    var x = toMs(a[key]), y = toMs(b[key]);
    if (isNaN(x)) x = 0;
    if (isNaN(y)) y = 0;
    return y - x || String(a.id).localeCompare(String(b.id));
  };
}

/* The drafts as rows for To send: still to send (newest first), and sent
   (latest sent first), each with the person it is for. */
function draftRows(r) {
  var byId = {};
  (r.people || []).forEach(function (p) { byId[p.id] = p; });
  function row(d) {
    var p = byId[d.person] || null;
    return {
      id: d.id, person: d.person, who: (p && str(p.name)) || "Someone",
      sub: p ? [str(p.title), str(p.company)].filter(Boolean).join(" · ") : "",
      channel: d.channel, kind: draftKind(d), subject: str(d.subject), body: d.body || "",
      sent: isSentDraft(d), sentAt: d.sentAt || "", at: d.at || ""
    };
  }
  var all = (r.drafts || []).slice();
  var todo = all.filter(function (d) { return !isSentDraft(d); }).sort(byTimeDesc("at")).map(row);
  var done = all.filter(isSentDraft).sort(byTimeDesc("sentAt")).map(row);
  return { todo: todo, sent: done, count: all.length };
}

/* ---- the funnel and what is next --------------------------------------------- */

/* Found, picked, drafted, sent: each counts people, never drafts, and each
   says what it counts. */
function funnel(r) {
  var people = uniquePeople(r.people);
  var drafted = {}, sent = {};
  (r.drafts || []).forEach(function (d) {
    if (!d.person) return;
    drafted[d.person] = true;
    if (isSentDraft(d)) sent[d.person] = true;
  });
  return [
    { id: "found", label: "Found", n: people.length, what: "people on the Lead board" },
    { id: "picked", label: "Picked", n: people.filter(isPicked).length, what: "people you chose a way to reach" },
    { id: "drafted", label: "Drafted", n: Object.keys(drafted).length, what: "people with a draft in To send" },
    { id: "sent", label: "Sent", n: Object.keys(sent).length, what: "people you pressed Sent for" }
  ];
}

/* How many ready people have a chosen channel with no draft yet. */
function undrafted(people, drafts) {
  var have = {};
  (drafts || []).forEach(function (d) { have[d.person + ":" + d.channel] = true; });
  return readyPeople(people).filter(function (p) {
    return channelsOn(p).some(function (c) { return !have[p.id + ":" + c]; });
  }).length;
}

/* Everything waiting on the operator, in the order of the kit's zones
   (Who to find, Leads, Outreach, To send). The first is what is next; the
   second, if any, is what else is waiting. zone is a kit zone key, or null
   when the only thing happening is an agent at work. step is the funnel
   step the operator is on (0 found .. 3 sent, 4 when everything is sent). */
function waiting(r) {
  var people = uniquePeople(r.people);
  var picked = people.filter(isPicked);
  var unpicked = people.length - picked.length;
  var drafts = r.drafts || [];
  var todo = drafts.filter(function (d) { return !isSentDraft(d); });
  var out = [];
  function add(zone, step, text, why, short) { out.push({ zone: zone, step: step, text: text, why: why, also: short }); }
  if (!people.length) {
    if (str((r.request || {}).text)) add("who", 0, "Check Who to find", "Lead scout has your request but nobody is on the board yet. If it has finished, ask again with wider words.", "Who to find, nobody was found yet");
    else add("who", 0, "Say who you want to reach", "Lead scout can only look once you press Find people in Who to find.", "Find people in Who to find");
  } else if (!picked.length) {
    add("leads", 1, "Pick who to reach", "Tap Email, Call or LinkedIn on each person in Leads. Tap nothing to skip someone.", "Pick people in Leads");
  } else {
    var st = sendState(people, (r.settings || {}).sentKey, r.request);
    var need = creditsNeeded(people);
    if (need > 0) add("leads", 1, "Spend " + plural(need, "credit") + ", or turn off Email and LinkedIn", "Those people need an Apollo reveal before they can go to Outreach. Nothing is spent until you press Spend.", "Spend or skip in Leads");
    else if (st.enabled && undrafted(people, drafts) > 0) {
      var left = undrafted(people, drafts);
      add("leads", 1, "Press Send to Outreach", plural(left, "picked person", "picked people") + " " + (left === 1 ? "is" : "are") + " ready for Outreach asker to draft. Nothing goes to them.", "Send to Outreach in Leads");
    }
    else if (st.count === 0) add("leads", 1, "Pick someone else", "Apollo had no match for the people you picked.", "Pick someone else in Leads");
    else if (st.sent && !drafts.length) add(null, 2, "Wait for your drafts", "Outreach asker is writing them. They show up in To send.", "");
  }
  if (todo.length) add("send", 3, "Send your " + plural(todo.length, "draft"), "Copy each in To send, send it yourself, then press Sent. Wibble sends nothing.", plural(todo.length, "draft") + " in To send");
  if (people.length && picked.length && unpicked > 0) {
    add("leads", 1, "Pick more people", plural(unpicked, "person", "people") + " in Leads " + (unpicked === 1 ? "has" : "have") + " no way to reach them picked yet.", plural(unpicked, "person", "people") + " in Leads not picked");
  }
  return out;
}

/* What the operator does next: the first thing waiting, with its reason and
   what else is waiting. With nothing waiting, it says so. */
function nextStep(r) {
  var w = waiting(r);
  if (!w.length) {
    var all = (r.drafts || []).length > 0;
    return { zone: null, step: 4, text: "Nothing is waiting for you", why: all ? "Every draft is sent. Ask for more people in Who to find whenever you like." : "Ask for more people in Who to find whenever you like.", also: "" };
  }
  var first = w[0];
  return { zone: first.zone, step: first.step, text: first.text, why: first.why, also: w[1] ? w[1].also : "" };
}

/* Ring a zone only when the next step moves to a different one. */
function shouldMark(prevZone, zone) {
  return zone !== prevZone;
}
