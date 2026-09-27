// trim/replay.mjs -- replay real Claude Code history under no trimming, v1
// and v2, and price each (payback spec §6 "Replay"; Task 6's gate).
//
//   node items/trim/replay.mjs [projectsDir]     (default ~/.claude/projects)
//
// Reads `<projectsDir>/*/*.jsonl` (main thread only, a new thread at every
// compact_boundary) and never writes there. Each request is rebuilt the way
// Wibble would report it (wire.rs: `at` = where the message holding a result
// starts, `age` = assistant messages after it, target = the first of
// file_path/path/notebook_path/command/pattern/url/query), fed through
// main.js's own track()/plan(), and priced at BUILTIN_PRICES:
//
//   - the prompt, in tokens, is S + r x chars: chars are the serialized
//     messages, r is one tokens-per-char rate fitted on the history (growth
//     in real prompt tokens over growth in chars between consecutive
//     requests), and S (system prompt and tools) is whatever of the real
//     prompt the chars don't cover;
//   - the prefix up to the first change since the last request is a cache
//     read, the rest a write (1-hour price when the thread writes the 1 h
//     cache, as its usage shows); a gap over the cache's life (5 min, or
//     1 h) makes the whole prompt a write; a thread's first request reads
//     what it really read (the system prompt, cached by earlier sessions);
//   - a cut released on request n is applied from request n+1 (Wibble drops
//     it on the next request out); v2's cold drops are applied on the first
//     request after a cache-expiring gap, at no rewrite cost;
//   - a new tool call naming a dropped item's target is a re-read, charged
//     as savingUsd() does: the whole prompt read once more, plus the re-read
//     text written.
//
// Only input is priced: output is the same in all three runs.

import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTIN_PRICES, priceFor, track, plan, rereads, markDropped } from "./main.js";

const TARGET_KEYS = ["file_path", "path", "notebook_path", "command", "pattern", "url", "query"];
const TARGET_MAX = 300;
const FALLBACK_PRICES = BUILTIN_PRICES["anthropic/claude-opus-5.5"];
/** Tokens for the system prompt and tools when a thread has no usage to go on. */
const DEFAULT_SYSTEM_TOKENS = 20000;
/** An image's weight in chars: ~1,600 tokens at ~0.35 tokens per char. */
const IMAGE_CHARS = 4600;
const TTL_5M = 300;
const TTL_1H = 3600;

/** wire.rs's target_of(): the first target key present, as a string, ≤ 300 chars. */
export function targetOf(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of TARGET_KEYS) {
    const v = input[key];
    if (v == null) continue;
    const s = typeof v === "string" ? v : Array.isArray(v) && v.every((p) => typeof p === "string") ? v.join(" ") : JSON.stringify(v);
    return [...s].slice(0, TARGET_MAX).join("");
  }
  return "";
}

/**
 * A block's size in chars as it counts toward the prompt: its JSON, except
 * that an image counts as IMAGE_CHARS (its base64 is not what it costs) and
 * a thinking block as its text (a signature is not billed as text).
 */
function blockChars(b) {
  if (!b || typeof b !== "object") return JSON.stringify(b ?? null).length;
  if (b.type === "image") return IMAGE_CHARS;
  if (b.type === "thinking") return (b.thinking || "").length + 40;
  if (b.type === "redacted_thinking") return 40;
  if (b.type === "tool_result" && Array.isArray(b.content)) {
    return 60 + String(b.tool_use_id || "").length + b.content.reduce((n, c) => n + blockChars(c) + 1, 0);
  }
  return JSON.stringify(b).length;
}

/** A result's text length: strings, plus `text` of array blocks; images count 0. */
function resultChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) if (b && typeof b.text === "string") n += b.text.length;
  return n;
}

/**
 * A line-at-a-time transcript reader. Returns { line(text), finish() };
 * finish() gives the file's threads:
 *   { name, messages: [{ role, chars, items: [{id, tool, target, chars}] }],
 *     requests: [{ t, model, prompt, write1h, billed, nMsgs }] }
 * A request is one assistant message id; its prompt is messages[0..nMsgs).
 * `prompt` is the real prompt tokens from usage (null when absent); `billed`
 * is its [input, cache read, 5 m write, 1 h write] split, for the check line.
 */
export function transcriptReader(name) {
  const threads = [];
  let cur = null;
  let calls = new Map(); // tool_use id -> {tool, target}
  let lastAssistantId = null;
  const uuids = new Set(); // a resumed session can write the same records again
  const requestIds = new Set();

  function fresh() {
    cur = { name, messages: [], requests: [] };
    threads.push(cur);
    calls = new Map();
    lastAssistantId = null;
  }
  fresh();

  function line(text) {
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      return;
    }
    if (!rec || rec.isSidechain) return;
    if (rec.uuid) {
      if (uuids.has(rec.uuid)) return;
      uuids.add(rec.uuid);
    }
    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      fresh();
      return;
    }
    if (rec.type !== "user" && rec.type !== "assistant") return;
    const msg = rec.message;
    if (!msg || typeof msg !== "object") return;
    const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
    const size = blocks.reduce((n, b) => n + blockChars(b) + 1, 0);
    const msgs = cur.messages;
    const last = msgs[msgs.length - 1];

    if (rec.type === "user") {
      const items = [];
      for (const b of blocks) {
        if (b && b.type === "tool_result") {
          const call = calls.get(b.tool_use_id) || { tool: "", target: "" };
          items.push({ id: b.tool_use_id, tool: call.tool, target: call.target, chars: resultChars(b.content) });
        }
      }
      // The API sees consecutive user records as one message.
      if (last && last.role === "user") {
        last.chars += size;
        last.items.push(...items);
      } else {
        msgs.push({ role: "user", chars: size + 30, items });
      }
      return;
    }

    for (const b of blocks) if (b && b.type === "tool_use") calls.set(b.id, { tool: b.name || "", target: targetOf(b.input) });
    const id = msg.id;
    if (id && id === lastAssistantId && last && last.role === "assistant") {
      last.chars += size; // one message, streamed into several records
      return;
    }
    lastAssistantId = id;
    const real = msg.model !== "<synthetic>" && rec.timestamp && !(id && requestIds.has(id));
    if (id) requestIds.add(id);
    if (real) {
      const u = msg.usage;
      const prompt = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : 0;
      const cc = (u && u.cache_creation) || {};
      cur.requests.push({
        t: Date.parse(rec.timestamp) / 1000,
        model: msg.model || "",
        prompt: prompt > 0 ? prompt : null,
        write1h: (cc.ephemeral_1h_input_tokens || 0) > (cc.ephemeral_5m_input_tokens || 0),
        billed: u ? [u.input_tokens || 0, u.cache_read_input_tokens || 0, cc.ephemeral_5m_input_tokens || 0, cc.ephemeral_1h_input_tokens || 0] : null,
        nMsgs: msgs.length,
      });
    }
    msgs.push({ role: "assistant", chars: size + 30, items: [] });
  }

  return { line, finish: () => threads.filter((th) => th.requests.length > 0) };
}

/** Starting offset of each message, untrimmed: starts[m], starts[messages.length] = all. */
function offsets(messages) {
  const starts = new Array(messages.length + 1);
  starts[0] = 0;
  for (let m = 0; m < messages.length; m++) starts[m + 1] = starts[m] + messages[m].chars;
  return starts;
}

/**
 * Tokens per char across `threads`: Σ growth in real prompt tokens over Σ
 * growth in chars, between consecutive requests that both have usage and
 * whose chars grew. Differences cancel the system prompt, which chars don't
 * cover. Pairs outside 0.05-2 tokens/char (a system prompt changed mid-way,
 * a cache that reported oddly) are left out.
 */
export function fitRate(threads) {
  let dp = 0;
  let dc = 0;
  for (const th of threads) {
    const starts = offsets(th.messages);
    let prev = null;
    for (const q of th.requests) {
      if (q.prompt != null) {
        if (prev) {
          const p = q.prompt - prev.prompt;
          const c = starts[q.nMsgs] - starts[prev.nMsgs];
          if (c > 0 && p > 0 && p / c >= 0.05 && p / c <= 2) {
            dp += p;
            dc += c;
          }
        }
        prev = q;
      }
    }
  }
  return dc > 0 ? dp / dc : 0.3;
}

export function pricesOf(model) {
  const hit = priceFor(model, null);
  return hit ? hit.prices : FALLBACK_PRICES;
}

/**
 * One thread under `mode` ("none" | "v1" | "v2") at `r` tokens per char.
 * Adds dollars and counts into `tot`.
 */
export function replayThread(th, mode, r, tot) {
  const { messages, requests } = th;
  const starts = offsets(messages);
  const asst = new Array(messages.length + 1); // assistant messages before m
  asst[0] = 0;
  for (let m = 0; m < messages.length; m++) asst[m + 1] = asst[m] + (messages[m].role === "assistant" ? 1 : 0);
  const msgOf = new Map();
  for (let m = 0; m < messages.length; m++) for (const it of messages[m].items) msgOf.set(it.id, { m, it });

  const removed = new Float64Array(messages.length); // chars cut out of each message so far
  const applied = new Set();
  const state = { threads: {} };
  const key = "replay:" + th.name;
  let pending = [];
  let prev = null; // { t, tier1h, P }
  let S = null;
  let tier1h = false; // the cache this thread writes; a request that wrote nothing keeps the last one

  for (const q of requests) {
    const C = starts[q.nMsgs];
    // Not clamped at 0: with no cuts the prompt is then exactly the real one.
    if (q.prompt != null) S = q.prompt - r * C;
    else if (S == null) S = DEFAULT_SYSTEM_TOKENS;
    const prices = pricesOf(q.model);
    if (q.billed && q.billed[2] + q.billed[3] > 0) tier1h = q.billed[3] > q.billed[2];
    else if (!q.billed) tier1h = q.write1h;
    const write = tier1h ? prices.write1h : prices.write5m;
    const cold = prev != null && q.t - prev.t > (prev.tier1h ? TTL_1H : TTL_5M);
    const thread = state.threads[key];

    // What Wibble removes from this request: last batch's cuts, and on a
    // cold cache every parked cold drop (then an ordinary drop, as onResult
    // does with coldApplied).
    let toApply = pending;
    pending = [];
    tot.cuts += toApply.length;
    if (cold && thread && thread.coldPending.size) {
      const free = [...thread.coldPending];
      markDropped(thread, free);
      tot.freeCuts += free.length;
      toApply = toApply.concat(free);
    }
    let firstMsg = Infinity;
    for (const id of toApply) {
      if (applied.has(id)) continue;
      const hit = msgOf.get(id);
      applied.add(id);
      removed[hit.m] += hit.it.chars;
      if (hit.m < firstMsg) firstMsg = hit.m;
    }

    // Lay the request out as it goes: each message's start with cuts taken out.
    const at = new Float64Array(q.nMsgs + 1);
    let cut = 0;
    for (let m = 0; m < q.nMsgs; m++) {
      at[m] = starts[m] - cut;
      cut += removed[m];
    }
    const totalChars = C - cut;
    at[q.nMsgs] = totalChars;
    const P = S + r * totalChars;

    // A thread's first request reads what it really read (the system prompt
    // and tools, cached by earlier sessions); nothing is cut there yet.
    let cached = 0;
    if (!prev) cached = q.billed ? Math.min(q.billed[1], P) : 0;
    else if (!cold) {
      cached = Math.min(prev.P, P);
      if (firstMsg < q.nMsgs) cached = Math.min(cached, S + r * at[firstMsg]);
    }
    cached = Math.max(0, cached);
    tot.usd += cached * prices.cacheRead + (P - cached) * write;
    tot.requests++;
    if (q.billed) {
      const [i, rd, w5, w1] = q.billed;
      tot.billedUsd += i * prices.input + rd * prices.cacheRead + w5 * prices.write5m + w1 * prices.write1h;
    }
    prev = { t: q.t, tier1h, P };
    if (mode === "none") continue;

    const items = [];
    for (let m = 0; m < q.nMsgs; m++) {
      for (const it of messages[m].items) {
        if (applied.has(it.id)) continue;
        items.push({ id: it.id, tool: it.tool, target: it.target, chars: it.chars, at: at[m], age: asst[q.nMsgs] - asst[m + 1], head: null });
      }
    }
    const seen = { sessionId: "replay", thread: th.name, calls: asst[q.nMsgs], format: "anthropic", model: q.model, totalChars, items };

    // A re-read only counts when the call named something: two calls that
    // both name nothing are not the same target.
    if (thread) {
      const rr = rereads(thread, { items: items.filter((it) => it.target) });
      if (rr > 0) {
        const charge = P * prices.cacheRead + rr * r * write;
        tot.usd += charge;
        tot.rereadUsd += charge;
        tot.rereads++;
      }
    }

    track(state, seen, q.t * 1000);
    const t = state.threads[key];
    t.r = r;
    t.promptTokens = P;
    // As onResult: a request that wrote nothing keeps the last answer.
    if (q.billed && q.billed[2] + q.billed[3] > 0) t.write1h = q.write1h;
    const out = plan(t, seen, mode === "v2" ? prices : null);
    pending = out.now;
  }
}

function blank() {
  return { usd: 0, billedUsd: 0, requests: 0, cuts: 0, freeCuts: 0, rereads: 0, rereadUsd: 0 };
}

/** All three runs over `threads`; r is fitted unless given. */
export function replay(threads, r = fitRate(threads)) {
  const runs = { none: blank(), v1: blank(), v2: blank() };
  for (const th of threads) for (const mode of ["none", "v1", "v2"]) replayThread(th, mode, r, runs[mode]);
  return { r, threads: threads.length, runs };
}

export function report({ r, threads, runs }, files) {
  const base = runs.none.usd;
  const pct = (run) => (base > 0 ? ((base - run.usd) / base) * 100 : 0);
  const usd = (n) => "$" + n.toFixed(2);
  const lines = [
    `${files != null ? files + " transcripts, " : ""}${threads} threads, ${runs.none.requests} requests, r = ${r.toFixed(4)} tokens/char`,
    `no trimming  ${usd(runs.none.usd)}  (the same requests as actually billed: ${usd(runs.none.billedUsd)})`,
    `v1           ${usd(runs.v1.usd)}  saved ${usd(base - runs.v1.usd)} (${pct(runs.v1).toFixed(1)}%)  cuts ${runs.v1.cuts}, re-reads ${runs.v1.rereads} (${usd(runs.v1.rereadUsd)})`,
    `v2           ${usd(runs.v2.usd)}  saved ${usd(base - runs.v2.usd)} (${pct(runs.v2).toFixed(1)}%)  cuts ${runs.v2.cuts}, free cuts ${runs.v2.freeCuts}, re-reads ${runs.v2.rereads} (${usd(runs.v2.rereadUsd)})`,
    pct(runs.v2) >= pct(runs.v1) ? "gate: PASS (v2 saved % >= v1 saved %)" : "gate: FAIL (v2 saved % < v1 saved %)",
  ];
  return lines.join("\n");
}

async function readThreads(dir) {
  const threads = [];
  let files = 0;
  for (const project of readdirSync(dir)) {
    const pdir = join(dir, project);
    if (!statSync(pdir).isDirectory()) continue;
    for (const f of readdirSync(pdir)) {
      if (!f.endsWith(".jsonl")) continue;
      files++;
      const reader = transcriptReader(project + "/" + f);
      const rl = createInterface({ input: createReadStream(join(pdir, f)), crlfDelay: Infinity });
      for await (const text of rl) reader.line(text);
      threads.push(...reader.finish());
    }
  }
  return { threads, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || join(homedir(), ".claude", "projects");
  const { threads, files } = await readThreads(dir);
  console.log(report(replay(threads), files));
}
