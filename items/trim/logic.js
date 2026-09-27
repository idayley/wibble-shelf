// trim/logic.js
//
// The rule and the saving, as pure functions. No `wibble` import, no
// network, no storage — main.js (Task 2) drives the judge queue and
// wibble.trim.drop with these; this file only decides and only counts.
//
// The rule (docs/specs/2026-09-26-trim-design.md §2-3):
//   1. Never on the request path — track()/release() only read state main.js
//      already collected from wibble.trim.onSeen/onResult.
//   2. Cut in batches of BATCH calls, and only tool results older than AGE.
//   3. A local judge may mark an aged item "not needed" (p >= NOT_NEEDED_P);
//      absent a verdict — judge down, or just hasn't reached the item yet —
//      the age rule itself is the fallback, so an unverdicted aged item is
//      still cut at the next release.

export const AGE = 5;
export const BATCH = 20;
export const NOT_NEEDED_P = 0.7;

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
 * `judgeUp` is accepted for signature parity with the spec's fallback rule
 * (spec §3: the age rule is the fallback whether the judge is down or just
 * hasn't reached an item yet) — either way an item with no verdict is always
 * cut at release, so it is not consulted in the decision below.
 *
 * @returns {string[]} ids released this call (empty if no batch is due, or
 *   nothing in the batch qualifies).
 */
export function release(thread, judgeUp) {
  if (thread.calls - thread.lastRelease < BATCH) return [];

  const ids = [];
  for (const [id, entry] of thread.items) {
    if (thread.dropped.has(id)) continue;
    if (entry.age <= AGE) continue;

    const verdictSaysDrop = entry.verdict != null && entry.verdict.notNeeded >= NOT_NEEDED_P;
    const verdictSaysNeeded = entry.verdict != null && entry.verdict.notNeeded < NOT_NEEDED_P;
    const fallbackApplies = entry.verdict == null; // judge down, or not reached yet

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
 * had already dropped. Only ids not already tracked count as "new" — call
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

/** Percentage saved of what the work would otherwise have cost. */
export function percent(totals) {
  return totals.saved / (totals.actual + totals.saved);
}
