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
//   1. Never on the request path -- track()/plan() only read state
//      activate()'s handlers already collected from wibble.trim's events.
//   2. Cut in batches of BATCH calls, and only tool results older than AGE.
//   3. A local judge scores each aged item; plan() cuts only the items whose
//      cut pays back at the model's real prices (payback spec §2.3-2.5), and
//      parks the rest for a cold cache. Absent a verdict -- judge down, or
//      just hasn't reached the item yet -- the item is priced at the base
//      rate. With no prices at all, v1's fixed lines (v1Line) decide.

export const AGE = 5;
export const BATCH = 20;
/** A thread not seen for this long is forgotten (see evictIdle()). */
export const IDLE_MS = 2 * 60 * 60 * 1000;
/**
 * v1's keep line for a thread `calls` long: the judge's verdict cuts an aged
 * item when notNeeded >= v1Line(calls). plan() only uses it when it has no
 * prices for the model (an unknown model, or before any are known); with
 * prices, the line comes from them instead (payback spec §2.4).
 *
 * Chosen by cost, not by a wrong-cut cap. An aged item with no verdict is
 * cut anyway (the age rule), so the judge only decides what to KEEP. Per
 * unit of item size: keeping an unneeded item costs ~0.1 x N (a cache read
 * on each of N later calls); cutting a needed one costs 1.25 (the re-read
 * written to cache) + 0.1 x 30 (the extra request it forces reads the
 * whole prompt, taken as ~30 items' worth). Calls so far stand in for N.
 * Only two lines ever run: the first release is at 20-25 calls (N=20), and
 * every later one is past 25 (N=40).
 * calibrate.py (2026-09-27), qwen35-4b-q4, positive question, neutral
 * prompt, 150 labeled past files (AUC 0.761):
 *   N=20: best T 0.87, 45% cheaper than the age rule alone
 *   N=40: best T 0.82, 30% cheaper
 * Re-run calibrate.py after changing the model, question or prompt.
 */
export function v1Line(calls) {
  return calls <= 25 ? 0.87 : 0.82;
}

/**
 * Fold one `wibble.trim.onSeen` report into `state`, and report which items
 * are old enough to ask the judge about.
 *
 * `state.threads[sessionId + ":" + thread]` is:
 *   { calls, lastRelease, lastSeenAt, format, items: Map(id -> {
 *       tool, target, chars, at, age, head, verdict: null|{notNeeded}, asked
 *     }), dropped: Set(id), droppedTargets: Map(target -> chars),
 *     coldPending: Set(id), stats: { cuts, freeCuts, skipped } }
 *
 * `at` is the item's offset in the request, in chars; an older Wibble
 * doesn't send it, and the item keeps whatever it had (or none). onResult
 * adds r, promptTokens and write1h for plan().
 *
 * Two parallel subagents in one session whose first messages match share a
 * `thread` name, so their calls interleave here. Rare, and it fails safe:
 * batches just come irregularly, and the age rule still holds.
 *
 * @returns {{ toJudge: Array<{id: string} & object> }}
 */
export function track(state, seen, now = Date.now()) {
  if (!state.threads) state.threads = {};
  const key = seen.sessionId + ":" + seen.thread;
  let thread = state.threads[key];
  if (!thread) {
    thread = {
      calls: 0,
      lastRelease: 0,
      lastSeenAt: now,
      format: null,
      items: new Map(),
      dropped: new Set(),
      droppedTargets: new Map(),
      coldPending: new Set(), // parked for a cold cache (plan()'s `cold`)
      stats: { cuts: 0, freeCuts: 0, skipped: 0 },
    };
    state.threads[key] = thread;
  }

  thread.calls = seen.calls;
  thread.lastSeenAt = now;
  if (seen.format) thread.format = seen.format;

  for (const item of seen.items) {
    const existing = thread.items.get(item.id);
    if (existing) {
      existing.chars = item.chars;
      existing.age = item.age;
      // Offsets shift as earlier output is cut, so the latest one wins.
      if (typeof item.at === "number") existing.at = item.at;
      // Keep the head once seen: a later report that omits it (or repeats
      // the same first lines) never blanks out what we already captured.
      if (existing.head == null && item.head != null) existing.head = item.head;
    } else {
      thread.items.set(item.id, {
        tool: item.tool,
        target: item.target,
        chars: item.chars,
        at: typeof item.at === "number" ? item.at : undefined,
        age: item.age,
        head: item.head ?? null,
        verdict: null,
        asked: false,
      });
    }
  }

  const toJudge = [];
  for (const [id, entry] of thread.items) {
    if (entry.age > AGE && entry.verdict === null && !entry.asked && !thread.dropped.has(id)) {
      toJudge.push({ id, ...entry });
    }
  }

  return { toJudge };
}

/**
 * Forget every thread not seen for `maxIdleMs` -- well past the provider's
 * 1 h cache, so a thread that comes back is a cold rewrite anyway and loses
 * nothing by starting over. Without this, `state.threads` (and each
 * thread's items, with their heads) grows for as long as Wibble runs.
 *
 * @returns {string[]} the keys removed, so the caller can drop whatever
 *   else it keeps per thread.
 */
export function evictIdle(state, now, maxIdleMs = IDLE_MS) {
  const gone = [];
  for (const [key, thread] of Object.entries(state.threads || {})) {
    if (now - thread.lastSeenAt > maxIdleMs) {
      delete state.threads[key];
      gone.push(key);
    }
  }
  return gone;
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
 * `rereadChars` is rereads() for this same request, charged back; `format`
 * is the thread's dialect from onSeen ("anthropic", "responses", "chat").
 */
export function saving(result, rereadChars, format) {
  const { usage, totalChars, removedChars, firstCutChars, sentChars } = result;

  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  // Tokens per char, self-calibrating per request. promptTokens covers the
  // whole body (system prompt and tool schemas too), so divide by the whole
  // body's chars; totalChars is the messages alone and makes r too big.
  // Older Wibbles don't send sentChars, and get the overstated ratio.
  const chars = typeof sentChars === "number" && sentChars > 0 ? sentChars : totalChars;
  const r = promptTokens / Math.max(1, chars);

  // OpenAI-style providers charge no premium to write the cache.
  const writeW = format && format !== "anthropic" ? 1 : usage.cacheWrite1h > usage.cacheWrite5m ? 2 : 1.25;
  const unitPrice = usage.cacheRead > 0 ? 0.1 : writeW;

  const gross = removedChars * r * unitPrice;
  const cut = firstCutChars == null ? 0 : Math.max(0, totalChars - firstCutChars) * r * (writeW - 0.1);
  // A re-read is a request the agent wouldn't otherwise have made: charge
  // its whole prompt at the cache-read price, plus the re-read text written.
  const reread = rereadChars > 0 ? promptTokens * 0.1 + rereadChars * r * writeW : 0;

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

// ---------------------------------------------------------------------------
// Real per-token prices (docs/specs/2026-09-27-trim-payback-design.md §2.1).
// PRICE_PER_M/dollars() above are v1's crude family fallback; they stay as
// activate() still calls dollars() for its per-request dollar figure, and a
// later task moves that call over to priceFor().
// ---------------------------------------------------------------------------

// Dollars per token, from OpenRouter's endpoint lists on 2026-09-27.
export const BUILTIN_PRICES = {
  "anthropic/claude-opus-5.5": { input: 4e-6, cacheRead: 2e-7, write5m: 5e-6, write1h: 8e-6, output: 2e-5, context: 1000000 },
  "anthropic/claude-opus-5": { input: 5e-6, cacheRead: 5e-7, write5m: 6.25e-6, write1h: 1e-5, output: 2.5e-5, context: 1000000 },
  "anthropic/claude-sonnet-5": { input: 2e-6, cacheRead: 2e-7, write5m: 2.5e-6, write1h: 4e-6, output: 1e-5, context: 1000000 },
  "anthropic/claude-haiku-4.5": { input: 1e-6, cacheRead: 1e-7, write5m: 1.25e-6, write1h: 2e-6, output: 5e-6, context: 200000 },
  "openai/gpt-5.5": { input: 5e-6, cacheRead: 5e-7, write5m: 5e-6, write1h: 5e-6, output: 3e-5, context: 1050000 },
  "openai/gpt-5.3-codex": { input: 1.75e-6, cacheRead: 1.75e-7, write5m: 1.75e-6, write1h: 1.75e-6, output: 1.4e-5, context: 400000 },
};

/** OpenRouter author -> the provider_name of the model's own maker. */
export const MAKERS = { anthropic: "Anthropic", openai: "OpenAI", deepseek: "DeepSeek" };

export function slugOf(model) {
  if (!model) return null;
  let m = String(model).toLowerCase().replace(/\[.*\]$/, "").replace(/-\d{8}$/, "").replace(/^openrouter\//, "");
  if (m.includes("/")) return m;
  if (m.startsWith("claude-")) m = "anthropic/" + m;
  else if (/^(gpt-|o\d)/.test(m)) m = "openai/" + m;
  else return null;
  return m.replace(/(\d)-(?=\d)/g, "$1.");
}

/** `Number(v)`, or null when it isn't a finite, non-negative price. */
function toPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * One endpoint's prices, or null when `prompt`/`completion`, or a present
 * but unparseable `input_cache_read`, don't hold a real price. A missing
 * `input_cache_read`/`input_cache_write`/`input_cache_write_1h` costs the
 * same as `prompt` -- the spec's rule for providers (OpenAI, most
 * OpenAI-compatible) that charge no premium to write the cache.
 */
function priceEndpoint(endpoint) {
  const pricing = endpoint && endpoint.pricing;
  if (!pricing) return null;
  const input = toPrice(pricing.prompt);
  const output = toPrice(pricing.completion);
  if (input == null || output == null) return null;
  const cacheRead = pricing.input_cache_read == null ? input : toPrice(pricing.input_cache_read);
  const write5m = pricing.input_cache_write == null ? input : toPrice(pricing.input_cache_write);
  const write1h = pricing.input_cache_write_1h == null ? input : toPrice(pricing.input_cache_write_1h);
  if (cacheRead == null || write5m == null || write1h == null) return null;
  return {
    input,
    cacheRead,
    write5m,
    write1h,
    output,
    context: typeof endpoint.context_length === "number" ? endpoint.context_length : null,
  };
}

/**
 * Parse an OpenRouter `.../endpoints` response body into one price entry:
 * the endpoints whose `provider_name` is the model's own maker
 * (`MAKERS[slug's author]`), or all of them when none match, priced at the
 * lowest `input`. Anything that doesn't hold a real body -- malformed JSON,
 * no `data.endpoints`, or no endpoint left with a usable price -- is null.
 */
export function parseEndpoints(body, slug) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  const endpoints = data && data.data && data.data.endpoints;
  if (!Array.isArray(endpoints)) return null;

  const maker = slug ? MAKERS[String(slug).split("/")[0]] : undefined;
  const matched = maker ? endpoints.filter((e) => e && e.provider_name === maker) : [];
  const pool = matched.length ? matched : endpoints;

  let best = null;
  for (const endpoint of pool) {
    const priced = priceEndpoint(endpoint);
    if (priced && (!best || priced.input < best.input)) best = priced;
  }
  return best;
}

/**
 * The prices to charge `model` at: a fetch already on file for its slug
 * (`fetched[slug]`, kept by the caller as `{prices, at}`) wins; otherwise
 * the built-in table; otherwise null -- an unknown model, or one `slugOf`
 * can't place.
 */
export function priceFor(model, fetched) {
  const slug = slugOf(model);
  if (!slug) return null;
  const hit = fetched && fetched[slug];
  if (hit && hit.prices) return { slug, prices: hit.prices, source: "fetched" };
  const builtin = BUILTIN_PRICES[slug];
  if (builtin) return { slug, prices: builtin, source: "built-in" };
  return null;
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
// How long a thread runs, and the judge's scores as real odds (design doc
// §2.2, §2.4). Pure, like everything above -- Task 3's planner is the one
// that calls these; nothing here touches activate()'s wiring below.
// ---------------------------------------------------------------------------

/**
 * Median further main-thread requests for a thread that has reached
 * `calls`, measured on real history: `calibrate.py --lengths` (2026-09-27)
 * over 1410 threads long enough to count, from 6805 transcripts under
 * `~/.claude/projects`. Re-run it after enough time has passed that thread
 * lengths might have drifted.
 */
export const LEFT_TABLE = [
  [20, 105],
  [40, 132],
  [60, 128],
  [100, 164],
  [200, 154],
  [400, 231],
];

/**
 * How many more requests a thread `calls` long typically has left,
 * interpolated between `LEFT_TABLE`'s points and flat past both ends
 * (median, not mean, so a few 1,000-call threads don't drag short ones
 * up). Capped at 10 once `promptTokens` is within 15% of `context` (the
 * model's window): compaction is about to happen and would throw away
 * whatever a cut just saved anyway. `context` is `null` when unknown --
 * the cap never applies then.
 */
export function left(calls, promptTokens = 0, context = null) {
  const t = LEFT_TABLE;
  let v;
  if (calls <= t[0][0]) v = t[0][1];
  else if (calls >= t[t.length - 1][0]) v = t[t.length - 1][1];
  else {
    const i = t.findIndex(([c]) => c > calls);
    const [c0, v0] = t[i - 1], [c1, v1] = t[i];
    v = v0 + ((v1 - v0) * (calls - c0)) / (c1 - c0);
  }
  return context && promptTokens >= 0.85 * context ? Math.min(v, 10) : v;
}

/**
 * Maps the judge's raw `notNeeded` score to a real probability: the
 * judge separates needed from not-needed items only 76% of the time
 * (AUC), so its scores run hot and aren't probabilities on their own.
 * `bins` is `[[upperScore, prob], ...]` in ascending score order (the
 * last upper is 1, covering the rest of the range), non-decreasing in
 * prob by construction (`calibrate.py --curve`'s pool-adjacent-violators
 * fit over 150 labeled, scored items, today's question and prompt).
 * `baseRate` is the overall share of those items that were truly not
 * needed -- what `probNotNeeded` falls back to for an item with no
 * verdict at all (judge down, or not reached yet).
 * Re-run `calibrate.py --curve` after changing the model, question, or
 * prompt; paste both `bins` and `baseRate` in fresh.
 */
export const CALIBRATION = {
  bins: [
    [0.7549, 0.2667],
    [0.7982, 0.4],
    [0.8355, 0.4],
    [0.8808, 0.5667],
    [0.9241, 0.8222],
    [0.9526, 0.8667],
    [1, 0.9333],
  ],
  baseRate: 0.6467,
};

/**
 * `verdict`'s (or, absent one, the base rate's) real probability of being
 * not needed, per `cal` (default the module's own `CALIBRATION`; tests
 * and Task 3's planner pass an override).
 */
export function probNotNeeded(verdict, cal = CALIBRATION) {
  if (verdict == null) return cal.baseRate;
  const bin = cal.bins.find(([upper]) => verdict.notNeeded <= upper) || cal.bins[cal.bins.length - 1];
  return bin[1];
}

// ---------------------------------------------------------------------------
// The planner (design doc §2.3-2.5): which aged items to cut on this batch,
// and which to park until the cache has gone cold.
// ---------------------------------------------------------------------------

/** Mark `ids` dropped, as v1's release did: sticky, and charged if re-read. */
function markDropped(thread, ids) {
  for (const id of ids) {
    thread.dropped.add(id);
    const entry = thread.items.get(id);
    thread.droppedTargets.set(entry.target, entry.chars);
    entry.head = null; // only the judge reads it, and it's done with this one
  }
}

/**
 * Plan the next batch for one thread, if a full batch of calls has passed
 * since the last one (BATCH calls; only items older than AGE). Mutates
 * `thread` only when a batch is due.
 *
 * With prices (all in dollars per token; r = tokens per char, from the
 * thread's last result or 0.3; P = the prompt's tokens; L = left(calls);
 * write = the 1-hour write price if the last result wrote the 1-hour cache,
 * else the 5-minute one), for each aged, undropped item with p =
 * probNotNeeded(verdict):
 *
 *   keep   = chars x r x cacheRead x L          (what keeping it costs)
 *   reread = chars x r x write + P x cacheRead  (what a wrong cut costs)
 *
 * It is a candidate when p x keep >= (1 - p) x reread. Every subset of
 * candidates pays one rewrite, from its earliest item to the end, so each
 * candidate i (sorted by `at`) is tried as the earliest cut:
 *
 *   net_i = Σ_{j>=i} p_j x keep_j - Σ_{j>=i} (1 - p_j) x reread_j
 *           - (totalChars - at_i) x r x (write - cacheRead)
 *
 * The best net_i, if above zero, is cut now (`now` = candidates i..). The
 * candidates left out failed only on the rewrite's cost, which a cold cache
 * waives, so they are parked (`cold`, and thread.coldPending) for Wibble to
 * drop on the first request after the cache expires. A parked item the
 * judge has since marked needed comes back out (`withdraw`).
 *
 * `at` is missing on an older Wibble: those items sit at the smallest known
 * `at`, or 0 -- the most a cut could cost, so a guess never overspends.
 *
 * With `prices` null this is v1's release: every aged item the judge
 * hasn't marked needed (notNeeded < v1Line(calls)) is cut, nothing parked.
 *
 * @param thread  track()'s thread, plus from onResult: r, promptTokens, write1h
 * @param seen    the onSeen report that triggered this (totalChars)
 * @param prices  { input, cacheRead, write5m, write1h, output, context } or null
 * @param cal     the judge's calibration (tests pass their own)
 * @returns {{ now: string[], cold: string[], withdraw: string[], net: number }}
 *   net is the chosen cut's dollars, 0 when nothing is cut now.
 */
export function plan(thread, seen, prices, cal = CALIBRATION) {
  const nothing = { now: [], cold: [], withdraw: [], net: 0 };
  if (thread.calls - thread.lastRelease < BATCH) return nothing;
  thread.lastRelease = thread.calls;

  const aged = [];
  for (const [id, entry] of thread.items) {
    if (!thread.dropped.has(id) && entry.age > AGE) aged.push([id, entry]);
  }

  if (prices == null) {
    const line = v1Line(thread.calls);
    const now = aged.filter(([, e]) => e.verdict == null || e.verdict.notNeeded >= line).map(([id]) => id);
    markDropped(thread, now);
    return { ...nothing, now };
  }

  const r = thread.r ?? 0.3;
  const P = thread.promptTokens ?? seen.totalChars * r;
  const L = left(thread.calls, P, prices.context);
  const write = thread.write1h ? prices.write1h : prices.write5m;

  const candidates = [];
  const withdraw = [];
  for (const [id, entry] of aged) {
    const p = probNotNeeded(entry.verdict, cal);
    const keep = entry.chars * r * prices.cacheRead * L;
    const reread = entry.chars * r * write + P * prices.cacheRead;
    if (p * keep >= (1 - p) * reread) candidates.push({ id, at: entry.at, gain: p * keep, risk: (1 - p) * reread });
    else if (thread.coldPending.has(id)) withdraw.push(id);
  }

  const known = candidates.filter((c) => typeof c.at === "number").map((c) => c.at);
  const floor = known.length ? Math.min(...known) : 0;
  for (const c of candidates) if (typeof c.at !== "number") c.at = floor;
  candidates.sort((x, y) => x.at - y.at);

  // Walk from the end so each suffix's sums build up in one pass.
  let best = -1;
  let bestNet = 0;
  let gain = 0;
  let risk = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    gain += candidates[i].gain;
    risk += candidates[i].risk;
    const rewrite = Math.max(0, seen.totalChars - candidates[i].at) * r * (write - prices.cacheRead);
    const net = gain - risk - rewrite;
    if (net > bestNet) {
      bestNet = net;
      best = i;
    }
  }

  const now = best < 0 ? [] : candidates.slice(best).map((c) => c.id);
  const cold = candidates.slice(0, best < 0 ? candidates.length : best).map((c) => c.id).filter((id) => !thread.coldPending.has(id));

  markDropped(thread, now);
  // A parked item cut now is no longer waiting on a cold cache.
  for (const id of now) thread.coldPending.delete(id);
  for (const id of cold) thread.coldPending.add(id);
  for (const id of withdraw) thread.coldPending.delete(id);
  thread.stats.skipped += cold.length;

  return { now, cold, withdraw, net: bestNet };
}

// ---------------------------------------------------------------------------
// Task 2 (v1 plan): the judge client, the drop/saving wiring, and the
// top-slot pill. Everything below is driven by `activate()`, and only by it.
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
const EVICT_CHECK_MS = 60000; // idle threads are looked for at most once a minute
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
    // Under $10 shows cents, so a small week reads "$0.10 spent" rather
    // than rounding to "$0 saved" (Math.round(-0.1) is -0).
    const d = week.dollars;
    const amount = Math.abs(d) < 10 ? Math.abs(d).toFixed(2) : String(Math.round(Math.abs(d)));
    return d < 0 && amount !== "0.00" ? "$" + amount + " spent" : "$" + amount + " saved";
  }
  return formatCompactNumber(week.removedTokens) + " tokens saved";
}

export async function activate(wibble) {
  // For Wibbles before the activation-epilogue fix: they call activate()
  // from above this file's own text, before the `const`s at the top of it
  // have run, so touching one first thing throws "Cannot access
  // 'TOTALS_KEY' before initialization". One await lets the rest of the
  // module finish first. Harmless on a Wibble that calls it last.
  await null;

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
          if (!state.threads[next.key]) continue; // forgotten while it waited
          try {
            const verdict = await ask(next.item, next.seen);
            const thread = state.threads[next.key];
            if (thread && thread.items.has(next.id)) {
              const entry = thread.items.get(next.id);
              entry.verdict = verdict;
              entry.head = null; // asked once; nothing reads it again
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
    // A failed write is retried by the next one; nothing to do here.
    await wibble.storage.set(TOTALS_KEY, totals).catch(() => {});
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
    // One chip, this week's figures: the top band is shared with every
    // other extension's pill, and three pills (percent, dollars, a judge
    // note) crowded it off the edge in the live check. Whether the judge
    // is up is the README's business, not the pill's.
    const week = weekTotals();
    return { kind: "chip", key: "pill", label: formatPercentLabel(week) + " · " + formatSavingsLabel(week) };
  }

  async function drawNow() {
    lastDrawAt = Date.now();
    drawPending = false;
    await wibble.panel.set("Trim", buildPanelNode()).catch(() => {});
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

  let lastEvictAt = Date.now();

  function forgetIdle(now) {
    if (now - lastEvictAt < EVICT_CHECK_MS) return;
    lastEvictAt = now;
    const gone = new Set(evictIdle(state, now));
    if (!gone.size) return;
    for (const key of gone) delete pendingRereads[key];
    for (let i = queue.length - 1; i >= 0; i--) if (gone.has(queue[i].key)) queue.splice(i, 1);
  }

  function onSeen(seen) {
    const key = seen.sessionId + ":" + seen.thread;
    const now = Date.now();
    forgetIdle(now);

    // rereads() reads the thread as it was BEFORE this report is merged
    // in (see its own doc above) -- so this runs before track().
    const before = state.threads[key];
    const rereadChars = before ? rereads(before, seen) : 0;
    if (rereadChars > 0) {
      pendingRereads[key] = (pendingRereads[key] || 0) + rereadChars;
    }

    const { toJudge } = track(state, seen, now);
    const thread = state.threads[key];

    if (toJudge.length) {
      for (const entry of toJudge) thread.items.get(entry.id).asked = true;
      enqueueForJudge(key, seen, toJudge);
    }

    // No prices yet: v1's release, exactly. Task 4 passes the model's.
    const releasedIds = plan(thread, seen, null).now;
    if (releasedIds.length) {
      // If this fails (the session just ended, say), un-mark the ids so the
      // next batch offers them again, and a later read of them isn't
      // charged as a re-read of something that was never dropped.
      Promise.resolve(wibble.trim.drop(seen.sessionId, releasedIds)).catch(() => {
        const t = state.threads[key];
        if (!t) return;
        for (const id of releasedIds) {
          t.dropped.delete(id);
          const entry = t.items.get(id);
          if (entry) t.droppedTargets.delete(entry.target);
        }
      });
    }
  }

  function onResult(result) {
    const key = result.sessionId + ":" + result.thread;
    const rereadChars = pendingRereads[key] || 0;
    delete pendingRereads[key];

    const format = state.threads[key] ? state.threads[key].format : null;
    const { saved, actual, removedTokens } = saving(result, rereadChars, format);
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
