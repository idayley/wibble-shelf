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
  return rereadItems(thread, seen).reduce((sum, item) => sum + item.chars, 0);
}

/** The items rereads() charges for, so activate() can count them too. */
function rereadItems(thread, seen) {
  return seen.items.filter((item) => item.age === 0 && !thread.items.has(item.id) && !!item.target && thread.droppedTargets.has(item.target));
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
// PRICE_PER_M/dollars() above are v1's crude family fallback: activate()
// still uses them (with saving()) for a model priceFor() can't price.
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
  if (hit && hit.prices) return { slug, prices: hit.prices, source: "fetched", at: hit.at };
  const builtin = BUILTIN_PRICES[slug];
  if (builtin) return { slug, prices: builtin, source: "built-in" };
  return null;
}

/**
 * True when a stored `{prices, at}` entry (activate()'s `fetchedPrices`,
 * read back from `wibble.storage` on start) is trustworthy enough to feed
 * into dollar totals: its six numbers -- `prices.input`, `cacheRead`,
 * `write5m`, `write1h`, `output`, and the fetch's own `at` -- must all be
 * finite. `context` isn't one of the six: `parseEndpoints()` can legitimately
 * leave it `null` when a model's context length wasn't reported, and `left()`
 * already treats a falsy `context` as "no cap", so it needs no check here.
 * A storage entry can be corrupted by anything (a bad write, a manual edit,
 * a future format change) that never touches `priceEndpoint()`'s own
 * validation, so this is the load-time backstop that keeps a bad number
 * from ever reaching `saved`/`actual` and poisoning every total after it.
 */
function validPriceEntry(entry) {
  if (!entry || typeof entry.prices !== "object" || entry.prices === null) return false;
  if (!Number.isFinite(entry.at)) return false;
  const p = entry.prices;
  return ["input", "cacheRead", "write5m", "write1h", "output"].every((k) => Number.isFinite(p[k]));
}

/**
 * What a request saved, in dollars at `prices` (priceFor()'s), by having
 * removed old tool output -- saving()'s arithmetic with the model's real
 * prices in place of v1's fixed 0.1 / 1.25 / 2 (payback spec §2.6).
 *
 *   gross  = removedChars x r x (cacheRead, or the write price when the
 *            request read nothing from cache or Wibble reports it `cold`)
 *   cut    = (totalChars - firstCutChars) x r x (write - cacheRead), and
 *            nothing on a `cold` request: the whole prompt was rewritten
 *            anyway. An older Wibble never sends `cold`, so it pays v1's way.
 *   reread = P x cacheRead + rereadChars x r x write, as saving() does
 *
 * with write = the 1-hour write price when the request wrote more 1-hour
 * cache than 5-minute, else the 5-minute one.
 *
 * @returns {{ saved, actual, removedTokens, cutCost, rereadCost }} all
 *   dollars except removedTokens
 */
export function savingUsd(result, rereadChars, prices) {
  const { usage, totalChars, removedChars, firstCutChars, sentChars, cold } = result;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  const chars = typeof sentChars === "number" && sentChars > 0 ? sentChars : totalChars;
  const r = promptTokens / Math.max(1, chars);

  const write = usage.cacheWrite1h > usage.cacheWrite5m ? prices.write1h : prices.write5m;
  const unitPrice = cold || usage.cacheRead === 0 ? write : prices.cacheRead;

  const gross = removedChars * r * unitPrice;
  const cutCost = cold || firstCutChars == null ? 0 : Math.max(0, totalChars - firstCutChars) * r * (write - prices.cacheRead);
  const rereadCost = rereadChars > 0 ? promptTokens * prices.cacheRead + rereadChars * r * write : 0;
  const actual =
    usage.input * prices.input +
    usage.cacheRead * prices.cacheRead +
    usage.cacheWrite5m * prices.write5m +
    usage.cacheWrite1h * prices.write1h +
    usage.output * prices.output;

  return { saved: gross - cutCost - rereadCost, actual, removedTokens: removedChars * r, cutCost, rereadCost };
}

/** Most chats noteChat() keeps; the one seen longest ago goes first. */
export const CHATS_KEEP = 50;

/**
 * Fold one onSeen/onResult's figures into `chats[sessionId]`:
 *   { saved, actual, calls, model, billing, lastAt, usd, units,
 *     cuts, freeCuts, skipped, rereads, rereadCost }
 * A result passes `units` (saving()'s {saved, actual}, always known) and
 * `usd` (savingUsd()'s dollars, or null when the model had no prices).
 * `saved`/`actual` are the dollars, and `usd` stays true only while every
 * result so far had them; `units` always adds up. `calls` keeps the highest
 * seen (a session's subagent threads are shorter than its main one);
 * `model`/`billing` keep the latest given. `cuts`, `freeCuts`, `skipped`,
 * `rereads` and `rereadCost` are this chat's own share of the same day
 * totals addSaving() keeps (payback spec §2.6, "per week and per chat");
 * each adds up only when the call actually names it, so a call that only
 * updates `calls`/`model`/`billing` (onSeen, most of the time) leaves them
 * untouched. Past CHATS_KEEP chats, the oldest `lastAt` is forgotten.
 */
export function noteChat(chats, sessionId, fields, now = Date.now()) {
  let chat = chats[sessionId];
  if (!chat) {
    chat = {
      saved: 0,
      actual: 0,
      calls: 0,
      model: null,
      billing: null,
      lastAt: now,
      usd: true,
      units: { saved: 0, actual: 0 },
      cuts: 0,
      freeCuts: 0,
      skipped: 0,
      rereads: 0,
      rereadCost: 0,
    };
    chats[sessionId] = chat;
  }
  if (typeof fields.calls === "number") chat.calls = Math.max(chat.calls, fields.calls);
  if (fields.model) chat.model = fields.model;
  if (fields.billing) chat.billing = fields.billing;
  if (fields.units) {
    chat.units.saved += fields.units.saved;
    chat.units.actual += fields.units.actual;
    if (fields.usd) {
      chat.saved += fields.usd.saved;
      chat.actual += fields.usd.actual;
    } else {
      chat.usd = false;
    }
  }
  if (typeof fields.cuts === "number") chat.cuts += fields.cuts;
  if (typeof fields.freeCuts === "number") chat.freeCuts += fields.freeCuts;
  if (typeof fields.skipped === "number") chat.skipped += fields.skipped;
  if (typeof fields.rereads === "number") chat.rereads += fields.rereads;
  if (typeof fields.rereadCost === "number") chat.rereadCost += fields.rereadCost;
  chat.lastAt = now;

  const ids = Object.keys(chats);
  if (ids.length > CHATS_KEEP) {
    const oldest = ids.reduce((a, b) => (chats[b].lastAt < chats[a].lastAt ? b : a));
    delete chats[oldest];
  }
  return chat;
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
 * `left()` bets on twice the median. A cut is an expected-value bet, and
 * the mean (3-5x the median: long threads run very long) is where the
 * money is, but the mean over-cuts short threads. The replay on real
 * history (replay.mjs, 2026-09-27, 99k requests) put v2's saving at 9.3%
 * with the median, 12.9% at 2x, 12.8% at 1.75x and 2.25x, 12.5% with the
 * mean table -- a flat top, so 2 is not a knife-edge.
 */
export const LEFT_SCALE = 2;

/**
 * How many more requests a thread `calls` long has left, for pricing a
 * cut: LEFT_SCALE times the median,
 * interpolated between `LEFT_TABLE`'s points and flat past both ends.
 * Capped at 10 once `promptTokens` is within 15% of `context` (the
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
  v *= LEFT_SCALE;
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

/**
 * Mark `ids` dropped, as v1's release did: sticky, and charged if re-read.
 * An id parked for a cold cache is no longer waiting on one.
 */
export function markDropped(thread, ids) {
  for (const id of ids) {
    thread.dropped.add(id);
    thread.coldPending.delete(id);
    const entry = thread.items.get(id);
    // A tool with no target (Wibble sends "") can't be re-read by name.
    if (entry.target) thread.droppedTargets.set(entry.target, entry.chars);
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
 * drop on the first request after the cache expires. A parked item comes
 * back out (`withdraw`) whenever it stops being a candidate: the judge has
 * since said keep, or fewer requests are left to pay it back (near
 * compaction, say) -- not only on a changed verdict.
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
const PRICES_KEY = "prices";
const PRICES_URL = "https://openrouter.ai/api/v1/models/";
const PRICE_FRESH_MS = 24 * 60 * 60 * 1000; // "fetched once per model per day"
const PRICE_RETRY_MS = 60 * 60 * 1000; // a failed fetch waits an hour

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
  // Under half a percent either way rounds to 0 (or -0, which fails
  // `< 0`): no sign then, or a small net cost reads "−0%" beside
  // "$0.01 more" (found live).
  if (pct === 0) return "0%";
  const sign = pct < 0 ? "+" : "−";
  return sign + Math.abs(pct) + "%";
}

/**
 * A day's totals, with every field a later version added set to 0 when a
 * day stored by an older Trim lacks it. Such a day has no dollars at real
 * prices, so it only counts as having them (`usdKnown`) if nothing was
 * spent on it at all.
 */
function normalizeDay(day) {
  for (const k of ["saved", "actual", "removedTokens", "dollars", "planActual", "apiActual", "cuts", "freeCuts", "skipped", "rereads", "rereadCost"]) {
    if (typeof day[k] !== "number") day[k] = 0;
  }
  if (typeof day.dollarsKnown !== "boolean") day.dollarsKnown = true;
  if (!day.usd || typeof day.usd.saved !== "number" || typeof day.usd.actual !== "number") {
    day.usd = { saved: 0, actual: 0 };
    if (typeof day.usdKnown !== "boolean") day.usdKnown = day.actual === 0;
  }
  if (typeof day.usdKnown !== "boolean") day.usdKnown = true;
  return day;
}

// Under $10 shows cents, so a small figure reads "$0.10" rather than
// rounding to "$0" (Math.round(-0.1) is -0).
function dollarAmountString(d) {
  const abs = Math.abs(d);
  return abs < 10 ? abs.toFixed(2) : String(Math.round(abs));
}

/** "$X saved" (or "spent" for a negative -- net cost -- figure). */
function dollarPhrase(d) {
  const amount = dollarAmountString(d);
  return d < 0 && amount !== "0.00" ? "$" + amount + " spent" : "$" + amount + " saved";
}

/**
 * A plan-billed dollar figure (payback spec §3): not real money -- the
 * session pays for the plan either way -- so it reads as an estimate at
 * API prices rather than a saving or a spend.
 */
function formatPlanDollarPhrase(d) {
  const amount = dollarAmountString(d);
  return d < 0 && amount !== "0.00" ? "≈ $" + amount + " more at API prices" : "≈ $" + amount + " at API prices";
}

function formatSavingsLabel(week) {
  if (week.dollarsKnown) return dollarPhrase(week.dollars);
  return formatCompactNumber(week.removedTokens) + " tokens saved";
}

/**
 * Model id -> display name for the hover card (payback spec §3):
 * "anthropic/claude-opus-5.5" -> "Opus 5.5", "openai/gpt-5.5" -> "GPT-5.5",
 * else the slug after "/". `slug` is `slugOf()`'s form (lowercase
 * "author/family-version"); a model `slugOf` can't place is returned as-is.
 */
function modelDisplayName(slug) {
  if (!slug) return slug;
  const at = slug.indexOf("/");
  if (at < 0) return slug;
  const author = slug.slice(0, at);
  const rest = slug.slice(at + 1);
  if (author === "anthropic" && rest.startsWith("claude-")) {
    const [family, ...version] = rest.slice("claude-".length).split("-");
    return family.charAt(0).toUpperCase() + family.slice(1) + (version.length ? " " + version.join(".") : "");
  }
  if (author === "openai" && rest.startsWith("gpt-")) {
    return "GPT-" + rest.slice("gpt-".length);
  }
  return rest;
}

/** Dollars per token -> dollars per million tokens, for the Prices row. */
function perMillion(price) {
  const v = price * 1e6;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** The Prices row's value: `model`'s display name and its per-million-token prices. */
function pricesRowValue(model, prices) {
  return (
    modelDisplayName(slugOf(model)) +
    ": $" +
    perMillion(prices.input) +
    "/M input · cache read $" +
    perMillion(prices.cacheRead) +
    " · cache write $" +
    perMillion(prices.write5m)
  );
}

/**
 * The text under the Prices row: when they were last updated. A fetch
 * under a day old is never stale by the time this renders, so "today"
 * only needs the day, not the hour.
 */
function pricesUpdatedText(source, at, now) {
  if (source !== "fetched") return "built-in prices";
  const days = Math.floor((now - at) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "updated today from openrouter.ai";
  return "updated " + days + " day" + (days === 1 ? "" : "s") + " ago";
}

/**
 * The This chat row's value: the chat's own percent (dollars when known,
 * else its units, same fallback as the chip), the dollar/units figure
 * (a plan-billed chat reads an API-price estimate instead of a saving,
 * payback spec §3), and its call count.
 */
function chatRowValue(chat) {
  const shown = chat.usd ? { saved: chat.saved, actual: chat.actual } : { saved: chat.units.saved, actual: chat.units.actual };
  const dollarPart =
    chat.billing === "plan"
      ? formatPlanDollarPhrase(chat.saved)
      : chat.usd
        ? dollarPhrase(chat.saved)
        : formatCompactNumber(chat.units.saved) + " units saved";
  return formatPercentLabel(shown) + " · " + dollarPart + " · " + chat.calls + " calls";
}

/** The chat Trim saw most recently: the one with the latest `lastAt`. */
function latestChat(chats) {
  let best = null;
  for (const chat of Object.values(chats)) {
    if (!best || chat.lastAt > best.lastAt) best = chat;
  }
  return best;
}

/**
 * The pill's hover card (payback spec §3): `view` is
 * `{ week, chat, prices, priceSource, priceAt, judgeUp, plan }` --
 * `week` is the same figures the chip's own label is built from; `chat`
 * is the chat Trim saw most recently (`null` with no chat yet, which
 * omits both the This chat row and the Prices row -- Prices names that
 * chat's model, and there is none to name); `prices`/`priceSource`/
 * `priceAt` are `priceFor()`'s for that chat's model (`prices` null for
 * an unknown model, which drops the "updated" text and reads "unknown for
 * <model>, counting tokens" instead); `judgeUp` is whether the local judge
 * answered recently; `plan` is whether plan requests were the week's
 * majority (the same flag that changes the chip's own label).
 *
 * Pure but for "today" vs "N days ago": `now` (default `Date.now()`) is
 * only for that, so a test can pass its own for a deterministic string.
 */
export function detailNode(view, now = Date.now()) {
  const { week, chat, prices, priceSource, priceAt, judgeUp, plan } = view;

  const children = [
    {
      kind: "heading",
      content: "This week  " + formatPercentLabel(week) + " · " + (plan ? formatPlanDollarPhrase(week.dollars) : formatSavingsLabel(week)),
    },
  ];

  if (chat) children.push({ kind: "row", label: "This chat", value: chatRowValue(chat) });

  children.push({ kind: "row", label: "Removed", value: formatCompactNumber(week.removedTokens) + " tokens of old tool output" });
  children.push({
    kind: "row",
    label: "Cuts",
    value: week.cuts + " made · " + week.freeCuts + " free (after a pause) · " + week.skipped + " skipped (wouldn't pay back yet)",
  });
  children.push({
    kind: "row",
    label: "Re-reads",
    value: week.rereads + ", cost $" + dollarAmountString(week.rereadCost) + " (already subtracted)",
  });

  if (chat) {
    if (prices) {
      children.push({ kind: "row", label: "Prices", value: pricesRowValue(chat.model, prices) });
      children.push({ kind: "text", content: pricesUpdatedText(priceSource, priceAt, now) });
    } else {
      children.push({ kind: "row", label: "Prices", value: "unknown for " + chat.model + ", counting tokens" });
    }
  }

  children.push({ kind: "row", label: "Judge", value: judgeUp ? "on" : "off — using the age rule" });

  return { kind: "stack", children };
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
  const pendingRereads = {}; // key (sessionId:thread) -> {chars, count} stashed for the next onResult
  const chats = {}; // sessionId -> noteChat()'s figures, in memory only
  let totals = (await wibble.storage.get(TOTALS_KEY)) || {};
  for (const day of Object.values(totals)) normalizeDay(day);
  pruneOldDays();

  // slug -> {prices, at}: the last good fetch per model, kept across
  // restarts. A read that fails, or holds something else, starts empty;
  // any entry that fails validPriceEntry() (a corrupt number, however it
  // got that way) is dropped rather than kept and fed into totals as NaN.
  let fetchedPrices = {};
  try {
    const stored = await wibble.storage.get(PRICES_KEY);
    if (stored && typeof stored === "object") {
      for (const [slug, entry] of Object.entries(stored)) {
        if (validPriceEntry(entry)) fetchedPrices[slug] = entry;
      }
    }
  } catch {
    // start with the built-in table
  }
  const priceFailedAt = {}; // slug -> when its last fetch failed
  let priceFetching = false;

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

  /**
   * Fetch `model`'s prices from openrouter.ai unless a fetch under a day
   * old is on file, one is already in flight, or its last one failed under
   * an hour ago. Only the model's slug goes out: a plain GET, no body, no
   * headers. A failure changes nothing; priceFor() keeps using what it had.
   */
  function refreshPrices(model, now) {
    const slug = slugOf(model);
    if (!slug || priceFetching) return;
    const hit = fetchedPrices[slug];
    if (hit && now - hit.at < PRICE_FRESH_MS) return;
    if (slug in priceFailedAt && now - priceFailedAt[slug] < PRICE_RETRY_MS) return;

    priceFetching = true;
    const url = PRICES_URL + slug.split("/").map(encodeURIComponent).join("/") + "/endpoints";
    (async () => {
      try {
        const res = await wibble.net.fetch(url, { method: "GET" });
        const prices = res && res.status === 200 ? parseEndpoints(res.body, slug) : null;
        if (!prices) throw new Error("no prices for " + slug);
        fetchedPrices[slug] = { prices, at: Date.now() };
        delete priceFailedAt[slug];
        await wibble.storage.set(PRICES_KEY, fetchedPrices).catch(() => {});
      } catch {
        priceFailedAt[slug] = Date.now();
      } finally {
        priceFetching = false;
      }
    })();
  }

  function todaysDay() {
    const key = dayKeyOf(new Date());
    let day = totals[key];
    if (!day) {
      day = normalizeDay({});
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

  /**
   * Add one result to today's totals. `units` is saving()'s (always known);
   * `usd` is savingUsd()'s, or null when the model had no prices -- which
   * marks the day as not all in dollars. `dollarsSaved` is v1's dollar
   * figure (usd.saved when known, else dollars() by family, or null).
   * planActual/apiActual split the day's cost (in units, the one measure
   * every result has) by how the session is billed.
   */
  function addSaving({ units, usd, dollarsSaved, plan, cuts, freeCuts, rereadCount }) {
    const day = todaysDay();
    day.saved += units.saved;
    day.actual += units.actual;
    day.removedTokens += units.removedTokens;
    if (dollarsSaved == null) {
      day.dollarsKnown = false;
    } else if (day.dollarsKnown) {
      day.dollars += dollarsSaved;
    }
    if (usd) {
      day.usd.saved += usd.saved;
      day.usd.actual += usd.actual;
      day.rereadCost += usd.rereadCost;
    } else {
      day.usdKnown = false;
    }
    if (plan) day.planActual += units.actual;
    else day.apiActual += units.actual;
    day.cuts += cuts;
    day.freeCuts += freeCuts;
    day.rereads += rereadCount;
    pruneOldDays();
  }

  function weekTotals() {
    let saved = 0;
    let actual = 0;
    let removedTokens = 0;
    let dollarsSum = 0;
    let dollarsKnown = true;
    const usd = { saved: 0, actual: 0 };
    let usdKnown = true;
    // cuts/freeCuts/skipped/rereads/rereadCost feed the hover card's Cuts
    // and Re-reads rows; planActual/apiActual (v1 units) are only ever used
    // as a ratio, to tell the hover card and the chip whether plan requests
    // were the week's majority (payback spec §3).
    let cuts = 0;
    let freeCuts = 0;
    let skipped = 0;
    let rereads = 0;
    let rereadCost = 0;
    let planActual = 0;
    let apiActual = 0;
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
      usd.saved += day.usd.saved;
      usd.actual += day.usd.actual;
      if (!day.usdKnown) usdKnown = false;
      cuts += day.cuts;
      freeCuts += day.freeCuts;
      skipped += day.skipped;
      rereads += day.rereads;
      rereadCost += day.rereadCost;
      planActual += day.planActual;
      apiActual += day.apiActual;
    }
    return { saved, actual, removedTokens, dollars: dollarsSum, dollarsKnown, usd, usdKnown, cuts, freeCuts, skipped, rereads, rereadCost, planActual, apiActual };
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
    // Dollars at real prices when every day this week has them; otherwise
    // v1's units, so a week of mixed days never adds dollars to units.
    // Even that v1 fallback's own `dollars` isn't one clean unit underneath
    // (review round 1, minor 4): addSaving() lands each result's usd.saved
    // (this model's real price) or dollars()'s cruder family guess in the
    // very same running total, so an unpriced week's figure on the chip can
    // already be a blend of exact and estimated amounts, not one or other.
    const week = weekTotals();
    const shown = week.usdKnown ? { ...week, saved: week.usd.saved, actual: week.usd.actual, dollars: week.usd.saved, dollarsKnown: true } : week;
    // "the chip label uses ≈ $41 at API prices when plan requests make up
    // more than half the week's actual cost" (payback spec §3). Only when
    // there's a dollar figure to show an estimate of -- planActual/apiActual
    // (v1 units) are used only for this ratio, never as a dollar amount.
    const plan = shown.dollarsKnown && week.planActual > week.apiActual;
    const savingsLabel = plan ? formatPlanDollarPhrase(shown.dollars) : formatSavingsLabel(shown);

    const chat = latestChat(chats);
    const priced = chat && chat.model ? priceFor(chat.model, fetchedPrices) : null;
    const view = {
      week: shown,
      chat,
      prices: priced ? priced.prices : null,
      priceSource: priced ? priced.source : null,
      priceAt: priced && priced.source === "fetched" ? priced.at : null,
      judgeUp,
      plan,
    };

    return { kind: "chip", key: "pill", label: formatPercentLabel(shown) + " · " + savingsLabel, detail: detailNode(view) };
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
    refreshPrices(seen.model, now);
    noteChat(chats, seen.sessionId, { calls: seen.calls, model: seen.model, billing: seen.billing }, now);

    // rereads() reads the thread as it was BEFORE this report is merged
    // in (see its own doc above) -- so this runs before track().
    const before = state.threads[key];
    const reread = before ? rereadItems(before, seen) : [];
    if (reread.length) {
      const pending = pendingRereads[key] || (pendingRereads[key] = { chars: 0, count: 0 });
      for (const item of reread) pending.chars += item.chars;
      pending.count += reread.length;
    }

    const { toJudge } = track(state, seen, now);
    const thread = state.threads[key];

    if (toJudge.length) {
      for (const entry of toJudge) thread.items.get(entry.id).asked = true;
      enqueueForJudge(key, seen, toJudge);
    }

    // No prices for the model (unknown, or an older Wibble that sends no
    // model): v1's release, exactly.
    const priced = priceFor(seen.model, fetchedPrices);
    const { now: cutIds, cold, withdraw } = plan(thread, seen, priced ? priced.prices : null);
    const sid = seen.sessionId;
    // withdraw() came with cold drops, so a Wibble without it has neither.
    const knowsCold = typeof wibble.trim.withdraw === "function";

    if (cutIds.length) {
      // If this fails (the session just ended, say), un-mark the ids so the
      // next batch offers them again, and a later read of them isn't
      // charged as a re-read of something that was never dropped.
      Promise.resolve(wibble.trim.drop(sid, cutIds)).catch(() => {
        const t = state.threads[key];
        if (!t) return;
        for (const id of cutIds) {
          t.dropped.delete(id);
          const entry = t.items.get(id);
          if (entry) t.droppedTargets.delete(entry.target);
        }
      });
    }
    if (cold.length) {
      todaysDay().skipped += cold.length;
      noteChat(chats, sid, { skipped: cold.length }, now);
      schedulePersist();
      // On an older Wibble they stay parked here, and each batch weighs
      // them again: cut when they pay back, withdrawn when they stop being
      // candidates (only in this thread's own bookkeeping).
      if (knowsCold) {
        // Refused: un-park them, so the next batch offers them again -- and
        // undo the skipped count charged above, since Wibble never actually
        // parked anything. Without this, coldPending losing these ids let a
        // later batch park the very same still-pending candidates again,
        // double-counting one ongoing skip as two (review round 1, minor 3).
        Promise.resolve(wibble.trim.drop(sid, cold, { when: "cold" })).catch(() => {
          const t = state.threads[key];
          if (t) for (const id of cold) t.coldPending.delete(id);
          todaysDay().skipped -= cold.length;
          noteChat(chats, sid, { skipped: -cold.length }, Date.now());
          schedulePersist();
        });
      }
    }
    if (withdraw.length && knowsCold) {
      // A failed withdraw leaves a cold drop that may yet apply; it's a cut
      // the judge would have kept, the same risk as any cut.
      Promise.resolve(wibble.trim.withdraw(sid, withdraw)).catch(() => {});
    }
  }

  function onResult(result) {
    const key = result.sessionId + ":" + result.thread;
    const pending = pendingRereads[key] || { chars: 0, count: 0 };
    delete pendingRereads[key];

    // What plan() needs of this thread's latest request: tokens per char,
    // the prompt's size, and which cache it writes.
    const thread = state.threads[key];
    const usage = result.usage;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
    if (thread && promptTokens > 0) {
      const chars = typeof result.sentChars === "number" && result.sentChars > 0 ? result.sentChars : result.totalChars;
      thread.r = promptTokens / Math.max(1, chars);
      thread.promptTokens = promptTokens;
      // A request that wrote nothing says nothing about which cache the
      // engine uses; keep the last answer.
      if (usage.cacheWrite1h + usage.cacheWrite5m > 0) thread.write1h = usage.cacheWrite1h > usage.cacheWrite5m;
    }

    // Cold drops Wibble applied on this request cost nothing to make; any
    // other id it newly removed is an ordinary cut. No `cold` flag (an
    // older Wibble): every one is ordinary. Per the payback spec §2.5, once
    // applied a cold drop "is an ordinary sticky drop" -- markDropped() it
    // here, the same as release() does for a `now` cut, so it stops being a
    // live candidate (plan() won't park or withdraw it again) and a later
    // read of its target is charged as a re-read, same as any other drop.
    const coldAppliedIds = result.cold && Array.isArray(result.coldApplied) ? result.coldApplied : [];
    if (thread && coldAppliedIds.length) markDropped(thread, coldAppliedIds.filter((id) => thread.items.has(id)));
    const coldApplied = coldAppliedIds.length;
    const newlyRemoved = typeof result.newlyRemoved === "number" ? result.newlyRemoved : 0;
    const cuts = Math.max(0, newlyRemoved - coldApplied);

    const units = saving(result, pending.chars, thread ? thread.format : null);
    const priced = priceFor(result.model, fetchedPrices);
    const usd = priced ? savingUsd(result, pending.chars, priced.prices) : null;
    const chat = chats[result.sessionId];

    addSaving({
      units,
      usd,
      dollarsSaved: usd ? usd.saved : dollars(units.saved, result.model),
      plan: !!chat && chat.billing === "plan",
      cuts,
      freeCuts: coldApplied,
      rereadCount: pending.count,
    });
    noteChat(chats, result.sessionId, {
      model: result.model,
      units,
      usd,
      cuts,
      freeCuts: coldApplied,
      rereads: pending.count,
      rereadCost: usd ? usd.rereadCost : undefined,
    }, Date.now());

    schedulePersist();
    scheduleDraw();
  }

  wibble.trim.onSeen(onSeen);
  wibble.trim.onResult(onResult);

  await probeHealth(); // "on start" -- if this fails, it arms its own re-probe via markDown()

  scheduleDraw(); // initial paint: the empty chip, or whatever storage had
}
