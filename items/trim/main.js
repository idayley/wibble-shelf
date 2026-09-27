// trim/main.js
//
// Wibble loads an extension as ONE module worker (bootstrap text + this
// file's source, concatenated into a blob), so this file cannot import a
// sibling module. Everything Task 1 put in logic.js lives here instead, as
// plain named exports with no globals and no side effects of their own --
// importing this file in Node (as main.test.mjs does) runs none of it.
// Only `activate(wibble)`, at the bottom, does any work, and only once
// Wibble calls it with the capabilities this extension's wibble.json asked
// for.
//
// The rule (docs/specs/2026-09-26-trim-design.md §2-3):
//   1. Never on the request path -- track()/release() only read state
//      activate()'s handlers already collected from wibble.trim's events.
//   2. Cut in batches of BATCH calls, and only tool results older than AGE.
//   3. A local judge may mark an aged item "not needed" (p >= cutLine(calls));
//      absent a verdict -- judge down, or just hasn't reached the item yet
//      -- the age rule itself is the fallback, so an unverdicted aged item
//      is still cut at the next release.

export const AGE = 5;
export const BATCH = 20;
/**
 * The keep line for a thread `calls` long: the judge's verdict cuts an aged
 * item when notNeeded >= cutLine(calls). null means the judge isn't worth
 * asking -- verdicts are ignored (pure age rule) and items aren't sent.
 *
 * Chosen by cost, not by a wrong-cut cap. An aged item with no verdict is
 * cut anyway (the age rule), so the judge only decides what to KEEP. Per
 * unit of item size: keeping an unneeded item costs ~0.1 x N (a cache read
 * on each of N later calls); cutting a needed one costs ~1.25 (re-read +
 * re-cache). Calls so far stand in for N, the calls still to come.
 * calibrate.py (2026-09-27), qwen35-4b-q4, positive question, neutral
 * prompt, 150 labeled past files (AUC 0.761):
 *   N=10: best T 0.82, 33% cheaper than the age rule alone
 *   N=20: best T 0.78, 14% cheaper
 *   N=40: no threshold beats the age rule alone -> no judge past 25 calls
 * Re-run calibrate.py after changing the model, question or prompt.
 */
export function cutLine(calls) {
  if (calls <= 10) return 0.82;
  if (calls <= 25) return 0.78;
  return null;
}

/**
 * Fold one `wibble.trim.onSeen` report into `state`, and report which items
 * are old enough to ask the judge about.
 *
 * `state.threads[sessionId + ":" + thread]` is:
 *   { calls, lastRelease, items: Map(id -> {
 *       tool, target, chars, age, head, verdict: null|{notNeeded}, asked
 *     }), dropped: Set(id), droppedTargets: Map(target -> chars) }
 *
 * @returns {{ toJudge: Array<{id: string} & object> }}
 */
export function track(state, seen) {
  if (!state.threads) state.threads = {};
  const key = seen.sessionId + ":" + seen.thread;
  let thread = state.threads[key];
  if (!thread) {
    thread = { calls: 0, lastRelease: 0, items: new Map(), dropped: new Set(), droppedTargets: new Map() };
    state.threads[key] = thread;
  }

  thread.calls = seen.calls;

  for (const item of seen.items) {
    const existing = thread.items.get(item.id);
    if (existing) {
      existing.chars = item.chars;
      existing.age = item.age;
      // Keep the head once seen: a later report that omits it (or repeats
      // the same first lines) never blanks out what we already captured.
      if (existing.head == null && item.head != null) existing.head = item.head;
    } else {
      thread.items.set(item.id, {
        tool: item.tool,
        target: item.target,
        chars: item.chars,
        age: item.age,
        head: item.head ?? null,
        verdict: null,
        asked: false,
      });
    }
  }

  const toJudge = [];
  // Past the last cut line the judge's verdict would be ignored -- don't
  // spend a judge call on it.
  if (cutLine(thread.calls) === null) return { toJudge };
  for (const [id, entry] of thread.items) {
    if (entry.age > AGE && entry.verdict === null && !entry.asked && !thread.dropped.has(id)) {
      toJudge.push({ id, ...entry });
    }
  }

  return { toJudge };
}

/**
 * Release the next batch of drops for one thread, if a full batch of calls
 * has passed since the last release. Mutates `thread` (lastRelease, dropped,
 * droppedTargets) only when a release actually happens.
 *
 * Whether the judge is up doesn't matter here (spec §3: the age rule is the
 * fallback whether the judge is down or just hasn't reached an item yet) --
 * either way an item with no verdict is cut at release.
 *
 * @returns {string[]} ids released this call (empty if no batch is due, or
 *   nothing in the batch qualifies).
 */
export function release(thread) {
  if (thread.calls - thread.lastRelease < BATCH) return [];

  const line = cutLine(thread.calls);
  const ids = [];
  for (const [id, entry] of thread.items) {
    if (thread.dropped.has(id)) continue;
    if (entry.age <= AGE) continue;

    // line === null: a long thread, pure age rule -- any verdict is ignored.
    const verdict = line === null ? null : entry.verdict;
    const verdictSaysDrop = verdict != null && verdict.notNeeded >= line;
    const verdictSaysNeeded = verdict != null && verdict.notNeeded < line;
    const fallbackApplies = verdict == null; // judge down, not reached yet, or ignored

    if (verdictSaysNeeded) continue;
    if (verdictSaysDrop || fallbackApplies) ids.push(id);
  }

  thread.lastRelease = thread.calls;
  for (const id of ids) {
    thread.dropped.add(id);
    const entry = thread.items.get(id);
    thread.droppedTargets.set(entry.target, entry.chars);
  }

  return ids;
}

/**
 * Chars to charge back because a new tool call re-read a target this thread
 * had already dropped. Only ids not already tracked count as "new" -- call
 * this with the thread's state from *before* track() merges the same
 * `seen` in, so an id is only ever new once, and so only ever charged once.
 */
export function rereads(thread, seen) {
  let chars = 0;
  for (const item of seen.items) {
    if (item.age !== 0) continue;
    if (thread.items.has(item.id)) continue;
    if (!thread.droppedTargets.has(item.target)) continue;
    chars += item.chars;
  }
  return chars;
}

/** Cost of a request's usage, in input-token units. */
export function cost(usage) {
  return usage.input * 1 + usage.cacheRead * 0.1 + usage.cacheWrite5m * 1.25 + usage.cacheWrite1h * 2 + usage.output * 5;
}

/**
 * What a request saved by having removed old tool output, in the same
 * input-token units as cost(). `result` is a `wibble.trim.onResult` report;
 * `rereadChars` is rereads() for this same request, charged back.
 */
export function saving(result, rereadChars) {
  const { usage, totalChars, removedChars, firstCutChars } = result;

  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  const r = promptTokens / Math.max(1, totalChars); // tokens per char, self-calibrating per request

  const writeW = usage.cacheWrite1h > usage.cacheWrite5m ? 2 : 1.25;
  const unitPrice = usage.cacheRead > 0 ? 0.1 : writeW;

  const gross = removedChars * r * unitPrice;
  const cut = firstCutChars == null ? 0 : Math.max(0, totalChars - firstCutChars) * r * (writeW - 0.1);
  const reread = rereadChars * r * writeW;

  return {
    saved: gross - cut - reread,
    actual: cost(usage),
    removedTokens: removedChars * r,
  };
}

export const PRICE_PER_M = { opus: 5, sonnet: 3, haiku: 1 };

/** Dollars for `units` input-token units on `model`, or null when its family is unknown. */
export function dollars(units, model) {
  const family = model ? Object.keys(PRICE_PER_M).find((k) => model.toLowerCase().includes(k)) : undefined;
  if (!family) return null;
  return (units * PRICE_PER_M[family]) / 1e6;
}

/**
 * Percentage saved of what the work would otherwise have cost. 0 (not
 * NaN) when nothing has been spent or saved yet -- a fresh install's
 * totals are `{saved: 0, actual: 0}`, and 0/0 is not a percentage.
 */
export function percent(totals) {
  const denom = totals.actual + totals.saved;
  if (denom === 0) return 0;
  return totals.saved / denom;
}

// ---------------------------------------------------------------------------
// Task 2: the judge client, the drop/saving wiring, and the top-slot pill.
// Everything below is driven by `activate()`, and only by it.
// ---------------------------------------------------------------------------

const JUDGE_ORIGIN = "http://127.0.0.1:8791";
const JUDGE_URL = JUDGE_ORIGIN + "/v1/systemone";
const HEALTH_URL = JUDGE_ORIGIN + "/health";
const HEALTH_PROBE_INTERVAL_MS = 60000; // 60 s from the failure, not from a fixed schedule -- see scheduleHealthProbe()
const QUEUE_CAP = 200;
export const JUDGE_QUESTION =
  "Will the agent still need this tool output to finish the operator's current request?";

const CAP_LAST_USER = 1500;
const CAP_RECENT_ASSISTANT = 1500;
const CAP_HEAD = 1200;
const TOTALS_KEY = "totals";
const TOTALS_KEEP_DAYS = 14;
const PERSIST_INTERVAL_MS = 5000; // "at most every 5 s"
const REDRAW_INTERVAL_MS = 1000; // "at most once a second"
const WEEK_DAYS = 7;

function cap(text, n) {
  const s = text || "";
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * `timer.unref()` when the runtime has it (Node), a no-op otherwise (a
 * Worker's setInterval/setTimeout return a plain number with no such
 * method). None of this extension's timers should be a reason the process
 * hosting it stays alive -- in Node that matters for a clean exit (tests,
 * a script run), and in the worker it costs nothing to ask.
 */
function unref(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

/** The judge's `state` text for one item, per the brief's exact layout. */
function stateText(item, seen) {
  const lastUser = cap(seen.lastUser, CAP_LAST_USER);
  const recentAssistant = cap(seen.recentAssistant, CAP_RECENT_ASSISTANT);
  const head = item.head != null ? cap(item.head, CAP_HEAD) : "(content not shown)";
  return (
    "Operator's latest request:\n" +
    lastUser +
    "\n\nAgent's recent messages:\n" +
    recentAssistant +
    "\n\nTool output under question:\n" +
    item.tool +
    " " +
    item.target +
    "\n" +
    head
  );
}

function dayKeyOf(date) {
  return date.toISOString().slice(0, 10);
}

function formatCompactNumber(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return Math.round(n).toString();
}

/**
 * The brief's literal example is only the saving case ("−24%"), but
 * Task 1's saving() can legitimately be negative for a week (a "cut"
 * request costs before later requests pay it back -- see logic.js's own
 * three-request-sequence test) -- a week can be net cost, not net saving.
 * Sign convention, undocumented in the brief, chosen here: a non-negative
 * percent is a saving and gets the real minus sign the brief shows
 * ("−24%"); a negative percent is a net cost for the week and gets
 * "+NN%" instead, so the sign always reads as "this many percent more
 * (or less) than doing nothing would have cost" rather than a saving
 * label with a confusing negative number in it.
 */
function formatPercentLabel(week) {
  const pct = Math.round(percent({ saved: week.saved, actual: week.actual }) * 100);
  const sign = pct < 0 ? "+" : "−";
  return sign + Math.abs(pct) + "%";
}

function formatSavingsLabel(week) {
  if (week.dollarsKnown) {
    const amount = Math.round(week.dollars);
    return amount < 0 ? "$" + Math.abs(amount) + " spent this week" : "$" + amount + " saved this week";
  }
  return formatCompactNumber(week.removedTokens) + " tokens saved this week";
}

export async function activate(wibble) {
  // RULING: the Wibble side of wibble.trim/wibble.net is built separately
  // and concurrently. An older Wibble without it gets a chip saying so,
  // and nothing else runs -- no storage read, no judge, no timers.
  if (!wibble.trim) {
    await wibble.panel.set("Trim", { kind: "chip", label: "Trim needs a newer Wibble" });
    return;
  }

  const state = { threads: {} };
  const pendingRereads = {}; // key (sessionId:thread) -> chars stashed for the next onResult
  let totals = (await wibble.storage.get(TOTALS_KEY)) || {};
  pruneOldDays();

  let judgeUp = true;
  const queue = []; // {key, id, item, seen}, newest thread at the front
  let busy = false;

  // FIX (review round 1, Important): a free-running setInterval ticking
  // on a fixed 60s cadence from activate()'s own start time does not
  // give a failure a full 60s cooldown -- a failure landing just before
  // a scheduled tick got probed again almost immediately. `healthTimer`
  // is a ONE-SHOT timer, always cleared and re-armed from `markDown()`
  // itself, so "60s of no query and no probe" is always anchored to the
  // moment of the failure that caused it, never to a stale schedule.
  let healthTimer = null;

  function scheduleHealthProbe() {
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = unref(
      setTimeout(() => {
        healthTimer = null;
        probeHealth();
      }, HEALTH_PROBE_INTERVAL_MS),
    );
  }

  function markDown() {
    const wasUp = judgeUp;
    judgeUp = false;
    if (wasUp) scheduleDraw();
    scheduleHealthProbe(); // fresh 60s window, anchored to THIS failure
  }

  async function probeHealth() {
    try {
      const res = await wibble.net.fetch(HEALTH_URL, { method: "GET" });
      if (res.status === 200) {
        const wasDown = !judgeUp;
        judgeUp = true;
        if (wasDown) {
          pump();
          scheduleDraw();
        }
        return;
      }
    } catch (e) {
      // fall through: still down
    }
    // Still down (or down for the first time, from a failed on-start
    // probe): markDown() arms the next probe 60s from now.
    markDown();
  }

  async function ask(item, seen) {
    const body = JSON.stringify({
      model: "openjev",
      state: stateText(item, seen),
      questions: {
        stale: {
          type: "noul",
          // Positive polarity on purpose: asked "how likely is it NOT
          // needed", the judge ran hot toward "not needed" (task 3 measured
          // a clearly-needed item at 0.905). The server answers P(Yes), so
          // noul here is P(still needed) and we invert it below.
          instructions: JUDGE_QUESTION,
        },
      },
    });
    const res = await wibble.net.fetch(JUDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.status !== 200) throw new Error("judge responded " + res.status);
    const parsed = JSON.parse(res.body);
    return { notNeeded: 1 - parsed.answers.stale.noul };
  }

  function pump() {
    if (busy) return;
    busy = true;
    (async () => {
      try {
        while (judgeUp && queue.length) {
          const next = queue.shift();
          // The thread may have grown past the last cut line while this
          // waited; its verdict would be ignored, so skip the judge call.
          const waiting = state.threads[next.key];
          if (!waiting || cutLine(waiting.calls) === null) continue;
          try {
            const verdict = await ask(next.item, next.seen);
            const thread = state.threads[next.key];
            if (thread && thread.items.has(next.id)) {
              thread.items.get(next.id).verdict = verdict;
            }
          } catch (e) {
            // "A failure or non-200 marks the judge down for 60 s, and
            // nothing is retried in that window." -- stop draining; the
            // health probe below resumes pump() once it is back.
            markDown();
            break;
          }
        }
      } finally {
        busy = false;
      }
    })();
  }

  function enqueueForJudge(key, seen, items) {
    if (!items.length) return;
    const additions = items.map((item) => ({ key, id: item.id, item, seen }));
    // Newest thread first: this batch goes to the front of the queue.
    queue.unshift(...additions);
    while (queue.length > QUEUE_CAP) queue.pop(); // cap 200, drop oldest
    pump();
  }

  function todaysDay() {
    const key = dayKeyOf(new Date());
    let day = totals[key];
    if (!day) {
      day = { saved: 0, actual: 0, removedTokens: 0, dollars: 0, dollarsKnown: true };
      totals[key] = day;
    }
    return day;
  }

  function pruneOldDays() {
    const keys = Object.keys(totals).sort();
    while (keys.length > TOTALS_KEEP_DAYS) {
      delete totals[keys.shift()];
    }
  }

  function addSaving(saved, actual, removedTokens, dollarsSaved) {
    const day = todaysDay();
    day.saved += saved;
    day.actual += actual;
    day.removedTokens += removedTokens;
    if (dollarsSaved == null) {
      day.dollarsKnown = false;
    } else if (day.dollarsKnown) {
      day.dollars += dollarsSaved;
    }
    pruneOldDays();
  }

  function weekTotals() {
    let saved = 0;
    let actual = 0;
    let removedTokens = 0;
    let dollarsSum = 0;
    let dollarsKnown = true;
    const now = new Date();
    for (let i = 0; i < WEEK_DAYS; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const day = totals[dayKeyOf(d)];
      if (!day) continue;
      saved += day.saved;
      actual += day.actual;
      removedTokens += day.removedTokens;
      if (day.dollarsKnown) dollarsSum += day.dollars;
      else dollarsKnown = false;
    }
    return { saved, actual, removedTokens, dollars: dollarsSum, dollarsKnown };
  }

  // Persist "totals" to storage at most once every PERSIST_INTERVAL_MS,
  // with a trailing flush so the last write is never lost.
  let lastPersistAt = 0;
  let persistPending = false;

  async function persistNow() {
    lastPersistAt = Date.now();
    persistPending = false;
    await wibble.storage.set(TOTALS_KEY, totals);
  }

  function schedulePersist() {
    const elapsed = Date.now() - lastPersistAt;
    if (elapsed >= PERSIST_INTERVAL_MS) {
      persistNow();
      return;
    }
    if (persistPending) return;
    persistPending = true;
    unref(setTimeout(persistNow, PERSIST_INTERVAL_MS - elapsed));
  }

  // Redraw the panel at most once every REDRAW_INTERVAL_MS, same pattern.
  let lastDrawAt = 0;
  let drawPending = false;

  function buildPanelNode() {
    if (Object.keys(totals).length === 0) {
      return { kind: "chip", label: "Trim", tone: "faint" };
    }
    const week = weekTotals();
    const children = [
      { kind: "chip", key: "pct", label: formatPercentLabel(week) },
      { kind: "text", key: "saved", content: formatSavingsLabel(week) },
    ];
    if (!judgeUp) {
      children.push({ kind: "text", key: "rule", content: "age rule" });
    }
    return { kind: "stack", children };
  }

  async function drawNow() {
    lastDrawAt = Date.now();
    drawPending = false;
    await wibble.panel.set("Trim", buildPanelNode());
  }

  function scheduleDraw() {
    const elapsed = Date.now() - lastDrawAt;
    if (elapsed >= REDRAW_INTERVAL_MS) {
      drawNow();
      return;
    }
    if (drawPending) return;
    drawPending = true;
    unref(setTimeout(drawNow, REDRAW_INTERVAL_MS - elapsed));
  }

  function onSeen(seen) {
    const key = seen.sessionId + ":" + seen.thread;

    // rereads() reads the thread as it was BEFORE this report is merged
    // in (see its own doc above) -- so this runs before track().
    const before = state.threads[key];
    const rereadChars = before ? rereads(before, seen) : 0;
    if (rereadChars > 0) {
      pendingRereads[key] = (pendingRereads[key] || 0) + rereadChars;
    }

    const { toJudge } = track(state, seen);
    const thread = state.threads[key];

    if (toJudge.length) {
      for (const entry of toJudge) thread.items.get(entry.id).asked = true;
      enqueueForJudge(key, seen, toJudge);
    }

    const releasedIds = release(thread);
    if (releasedIds.length) {
      wibble.trim.drop(seen.sessionId, releasedIds);
    }
  }

  function onResult(result) {
    const key = result.sessionId + ":" + result.thread;
    const rereadChars = pendingRereads[key] || 0;
    delete pendingRereads[key];

    const { saved, actual, removedTokens } = saving(result, rereadChars);
    const dollarsSaved = dollars(saved, result.model);
    addSaving(saved, actual, removedTokens, dollarsSaved);

    schedulePersist();
    scheduleDraw();
  }

  wibble.trim.onSeen(onSeen);
  wibble.trim.onResult(onResult);

  await probeHealth(); // "on start" -- if this fails, it arms its own re-probe via markDown()

  scheduleDraw(); // initial paint: the empty chip, or whatever storage had
}
