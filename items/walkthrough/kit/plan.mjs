// The film's decisions, as pure functions: no Chrome, no files. The recorder
// (walk.mjs) and the film (compose.mjs, compose.html) both import this, so the
// cursor the viewer sees follows the exact path the app's own mouse took.
// plan.test.mjs covers it: `node --test plan.test.mjs`.

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, u) => a + (b - a) * u;
export const eio = u => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

// ---------- pacing ----------

/// How long a captioned step stays on screen, from its start: long enough to
/// read the caption once at an easy pace.
export const readMs = say => (say ? clamp(1400 + 50 * say.length, 2000, 5500) : 0);

/// How long the pointer takes to travel `dist` px: quick for a short hop,
/// never a teleport, never a crawl.
export const moveMs = dist => clamp(280 + dist * 0.45, 350, 900);

/// Where a move is at time `t`: eased, with a slight arc the way a hand moves.
export function pointAt(m, t) {
  const u = eio(clamp((t - m.t0) / Math.max(1, m.t1 - m.t0), 0, 1));
  const [x0, y0] = m.from, [x1, y1] = m.to;
  const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy) || 1;
  const bow = Math.sin(Math.PI * u) * Math.min(40, d * 0.08);
  return [lerp(x0, x1, u) - (dy / d) * bow, lerp(y0, y1, u) + (dx / d) * bow];
}

/// The pointer at source time `t`, from the recorded moves (sorted by t0).
/// Null before the first move.
export function cursorAt(moves, t) {
  let last = null;
  for (const m of moves) {
    if (m.t0 > t) break;
    last = m;
  }
  if (!last) return null;
  return t >= last.t1 ? [...last.to] : pointAt(last, t);
}

// ---------- the timeline ----------

export const TIMING = { gapMs: 250, waitMin: 1500, waitCap: 900, fadeMs: 240, titleMs: 3400, cardMs: 2600, endMs: 2600 };

/// Turns recorded steps into the film's timeline.
///
/// `parts` is [{ reel, steps, chapter }]: the steps to show from one reel,
/// and the chapter they belong to (or null). Steps that were dropped or
/// failed are left out. Time the recorder spent waiting for the next
/// instruction (the agent thinking, in a rehearsal) is cut; a long page
/// load is sped up to `waitCap`. Every cut crossfades, so nothing jumps.
///
/// Returns { pieces, dur, steps }. A piece is
///   { kind: "video", out0, out1, reel, src0, src1, step, fade }  or
///   { kind: "card", out0, out1, card, reel, src0 }   (src0: the frame behind it)
/// and `steps` lists each kept step with its own out0/out1 and number.
export function buildTimeline(parts, { title, end = true, ...o } = {}) {
  const T = { ...TIMING, ...o };
  const pieces = [], steps = [];
  let out = 0, num = 0, lastSay = null;
  const push = p => { pieces.push(p); out = p.out1; };
  const kept = parts.map(p => ({ ...p, steps: p.steps.filter(s => s.ok && !s.dropped).sort((a, b) => a.t0 - b.t0) })).filter(p => p.steps.length);
  if (!kept.length) return { pieces, dur: 0, steps };

  if (title) push({ kind: "card", card: { type: "title", ...title }, out0: 0, out1: T.titleMs, reel: kept[0].reel, src0: kept[0].steps[0].t0 });
  let prev = null;
  kept.forEach((part, pi) => {
    if (part.chapter) {
      push({ kind: "card", card: { type: "chapter", ...part.chapter }, out0: out, out1: out + T.cardMs, reel: part.reel, src0: part.steps[0].t0 });
      prev = null;
    }
    for (const s of part.steps) {
      // Continuous with the last step only if nothing was cut between them.
      const fade = !prev || prev.reel !== part.reel || s.t0 - prev.t1 > T.gapMs;
      const src0 = fade || !prev ? s.t0 : prev.t1;
      if (s.say) { num += 1; lastSay = s.say; }
      const st = { n: s.n, num: num || 1, say: s.say || lastSay, own: !!s.say, target: s.target, do: s.do, nav: !!s.nav, reel: part.reel, chapter: part.chapter?.index ?? null, url: s.url, out0: out };
      const wait0 = s.tSettle0 ?? s.t1, wait1 = s.tSettle1 ?? s.t1;
      const segs = wait1 - wait0 > T.waitMin
        ? [[src0, wait0, null], [wait0, wait1, T.waitCap], [wait1, s.t1, null]]
        : [[src0, s.t1, null]];
      segs.forEach(([a, b, cap], k) => {
        if (b <= a) return;
        const d = cap ?? b - a;
        push({ kind: "video", out0: out, out1: out + d, reel: part.reel, src0: a, src1: b, step: s.n, fade: k === 0 && fade && pieces.length > 0 });
      });
      st.out1 = out;
      steps.push(st);
      prev = { reel: part.reel, t1: s.t1 };
    }
    if (pi === kept.length - 1 && end) {
      const last = part.steps[part.steps.length - 1];
      push({ kind: "card", card: { type: "end" }, out0: out, out1: out + T.endMs, reel: part.reel, src0: last.t1 });
    }
  });
  return { pieces, dur: out, steps };
}

/// What to draw at output time `t`: the piece, the source time in its reel,
/// and, during a crossfade, the frame being faded from.
export function frameAt(tl, t, fadeMs = TIMING.fadeMs) {
  const ps = tl.pieces;
  let i = ps.findIndex(p => t < p.out1);
  if (i < 0) i = ps.length - 1;
  const p = ps[i];
  const u = clamp((t - p.out0) / Math.max(1, p.out1 - p.out0), 0, 1);
  const src = p.kind === "video" ? lerp(p.src0, p.src1, u) : p.src0;
  let from = null;
  if (p.kind === "video" && p.fade && t - p.out0 < fadeMs && i > 0) {
    const q = ps[i - 1];
    from = { reel: q.reel, src: q.kind === "video" ? q.src1 : q.src0, a: 1 - (t - p.out0) / fadeMs };
  }
  return { i, piece: p, reel: p.reel, src, from };
}

/// The step on screen at output time `t`, or null over a card.
export const stepAt = (tl, t) => tl.steps.find(s => t >= s.out0 && t < s.out1) || null;

// ---------- zoom ----------

const ZOOMABLE = new Set(["click", "type", "select", "check", "hover"]);
// Steps that stay put: they neither earn a zoom nor end one.
const STILL = new Set(["press", "pause", "wait", "speak"]);

/// A target is worth zooming to only when it is small on screen: a link, a
/// text field, a checkbox. Big buttons are already easy to see.
export const isSmall = (r, [W, H]) => !!r && r.w * r.h < 0.004 * W * H && r.w < 0.3 * W;

/// The focus point that scales a `s`x view so the box's middle is as central
/// as it can be without the view running past the page's edge.
export function focusFor(c, s, W) {
  const span = W / s, a = clamp(c - span / 2, 0, W - span);
  return a / (1 - 1 / s);
}

/// The film's zooms, in output time. Rare and earned: only for small targets,
/// gentle (at most 1.12x), and never in-out-in. Neighbouring small targets in
/// the same place share one zoom framed to hold them all; it lets go when the
/// action moves far away or onto something big, the page changes, or a card
/// cuts in.
export function planZooms(tl, view, { max = 1.12, minMs = 1400 } = {}) {
  const [W, H] = view, zooms = [];
  let g = null;
  const close = () => {
    if (g && g.out1 - g.out0 >= minMs) {
      const pad = 24, bw = g.x1 - g.x0 + 2 * pad, bh = g.y1 - g.y0 + 2 * pad;
      const s = clamp(Math.min(max, (0.9 * W) / bw, (0.9 * H) / bh), 1, max);
      if (s >= 1.04) zooms.push({ out0: g.out0, out1: g.out1, s, fx: focusFor((g.x0 + g.x1) / 2, s, W), fy: focusFor((g.y0 + g.y1) / 2, s, H) });
    }
    g = null;
  };
  let lastCard = -1;
  for (const st of tl.steps) {
    const card = tl.pieces.filter(p => p.kind === "card" && p.out1 <= st.out0).length;
    if (card !== lastCard) { close(); lastCard = card; }
    if (STILL.has(st.do)) { if (g) g.out1 = st.out1; continue; }
    const r = st.target;
    if (st.nav || !ZOOMABLE.has(st.do) || !isSmall(r, view)) { close(); continue; }
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const near = g && g.url === st.url && Math.abs(cx - g.cx) < 0.35 * W && Math.abs(cy - g.cy) < 0.35 * H;
    if (!near) { close(); g = { out0: st.out0, out1: st.out1, cx, cy, url: st.url, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }; continue; }
    g.out1 = st.out1;
    g.x0 = Math.min(g.x0, r.x); g.y0 = Math.min(g.y0, r.y); g.x1 = Math.max(g.x1, r.x + r.w); g.y1 = Math.max(g.y1, r.y + r.h);
  }
  close();
  return zooms;
}

/// The camera at output time `t`: { s, fx, fy } (scale about a focus point).
export function zoomAt(zooms, t, view, { inMs = 700, outMs = 600 } = {}) {
  const [W, H] = view;
  for (const z of zooms) {
    if (t < z.out0 || t > z.out1 + outMs) continue;
    const u = t <= z.out1 ? eio(clamp((t - z.out0) / inMs, 0, 1)) : 1 - eio(clamp((t - z.out1) / outMs, 0, 1));
    return { s: lerp(1, z.s, u), fx: z.fx, fy: z.fy };
  }
  return { s: 1, fx: W / 2, fy: H / 2 };
}

/// A point in the page, as it lands in the zoomed view.
export const throughZoom = ([x, y], z) => [z.fx + (x - z.fx) * z.s, z.fy + (y - z.fy) * z.s];

// ---------- where the caption goes ----------

/// Candidate places for a caption, as fractions of the view, best first.
export const BANDS = [
  { name: "bottom", x0: 0.22, y0: 0.86, x1: 0.78, y1: 0.97 },
  { name: "top", x0: 0.22, y0: 0.03, x1: 0.78, y1: 0.14 },
  { name: "bottom-left", x0: 0.03, y0: 0.86, x1: 0.5, y1: 0.97 },
  { name: "bottom-right", x0: 0.5, y0: 0.86, x1: 0.97, y1: 0.97 },
  { name: "top-right", x0: 0.5, y0: 0.03, x1: 0.97, y1: 0.14 },
  { name: "top-left", x0: 0.03, y0: 0.03, x1: 0.5, y1: 0.14 },
];

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/// Picks the band a caption should sit in: never over what is being used,
/// and otherwise the calmest stretch of the screen, with a lean towards the
/// bottom. `grid` is luminance 0..1 of the view, gw x gh; `avoid` is a list of
/// rects in view fractions (the target, the pointer).
export function pickBand(grid, gw, gh, avoid = [], bands = BANDS) {
  let best = null;
  bands.forEach((b, rank) => {
    if (avoid.some(r => overlaps(b, { x0: r.x0 - 0.03, y0: r.y0 - 0.04, x1: r.x1 + 0.03, y1: r.y1 + 0.04 }))) return;
    const gx0 = Math.floor(b.x0 * gw), gx1 = Math.ceil(b.x1 * gw), gy0 = Math.floor(b.y0 * gh), gy1 = Math.ceil(b.y1 * gh);
    let edge = 0, n = 0, sum = 0, sq = 0;
    for (let y = gy0; y < gy1; y++) for (let x = gx0; x < gx1; x++) {
      const v = grid[y * gw + x];
      sum += v; sq += v * v; n++;
      if (x + 1 < gx1) edge += Math.abs(v - grid[y * gw + x + 1]);
      if (y + 1 < gy1) edge += Math.abs(v - grid[(y + 1) * gw + x]);
    }
    if (!n) return;
    const mean = sum / n, busy = edge / n + Math.sqrt(Math.max(0, sq / n - mean * mean));
    const score = busy + rank * 0.012;
    if (!best || score < best.score) best = { name: b.name, score, band: b };
  });
  return best ? best.name : "bottom";
}

// ---------- splicing re-shot chapters ----------

/// For each chapter of the script, the reel that has its latest complete take.
/// `reels` is in the order they were recorded: [{ id, chapters: { [index]: complete } }].
/// Returns [{ chapter, reel }] in chapter order, and the chapters no reel has.
export function chooseReels(reels, chapterCount) {
  const picks = [], missing = [];
  for (let c = 0; c < chapterCount; c++) {
    let pick = null;
    for (const r of reels) if (r.chapters[c]) pick = r.id;
    pick ? picks.push({ chapter: c, reel: pick }) : missing.push(c);
  }
  return { picks, missing };
}

// ---------- mapping the recording onto the film ----------

/// Where a moment of a reel lands in the film, or null if it was cut.
export function mapTime(tl, reel, t) {
  for (const p of tl.pieces) {
    if (p.kind !== "video" || p.reel !== reel || t < p.src0 || t >= p.src1) continue;
    return p.out0 + ((t - p.src0) * (p.out1 - p.out0)) / (p.src1 - p.src0);
  }
  return null;
}

/// Captions, one per numbered step: shown from the step that says it until
/// the next caption or a card. Steps without words keep the last caption up.
export function captionRuns(tl) {
  const runs = [];
  for (const st of tl.steps) {
    const last = runs[runs.length - 1];
    const card = tl.pieces.some(p => p.kind === "card" && last && p.out0 >= last.out1 - 1 && p.out1 <= st.out0 + 1);
    if (last && !st.own && !card) { last.out1 = st.out1; last.steps.push(st); continue; }
    if (!st.say) continue;
    runs.push({ num: st.num, text: st.say, out0: st.out0, out1: st.out1, steps: [st], chapter: st.chapter });
  }
  return runs;
}

/// Caption opacity and lift at time `t` within a run.
export function captionAt(run, t, { inMs = 320, outMs = 220, delay = 120 } = {}) {
  const a = clamp((t - run.out0 - delay) / inMs, 0, 1), b = clamp((run.out1 - t) / outMs, 0, 1);
  const u = eio(Math.min(a, b));
  return { alpha: u, dy: (1 - eio(a)) * 12 - (1 - eio(b)) * 6 };
}

/// The film's sounds, as cues { t, file, gain, pan }. Soft and sparse: a tick
/// for each click, a light patter while typing, a whoosh into each chapter,
/// a chime at the end. The persona's own voice is laid in at full level.
export function soundCues(tl, reels, { view = [1440, 800] } = {}) {
  const cues = [];
  const pan = x => clamp((x / view[0] - 0.5) * 0.7, -0.6, 0.6);
  for (const p of tl.pieces) {
    if (p.kind !== "card") continue;
    if (p.card.type === "title") cues.push({ t: p.out0 + 500, file: "card-1.m4a", gain: 0.3, pan: 0 });
    if (p.card.type === "chapter") cues.push({ t: p.out0 + 60, file: "whoosh.m4a", gain: 0.22, pan: 0 });
    if (p.card.type === "end") cues.push({ t: p.out0 + 420, file: "chime-2.m4a", gain: 0.3, pan: 0 });
  }
  for (const [id, log] of Object.entries(reels)) {
    (log.clicks || []).forEach((c, i) => {
      const t = mapTime(tl, id, c.t);
      if (t != null) cues.push({ t, file: `click-${(i % 3) + 1}.m4a`, gain: 0.32, pan: pan(c.x) });
    });
    let lastKey = -1e9;
    for (const k of log.keys || []) {
      const t = mapTime(tl, id, k.t);
      if (t == null || t - lastKey < 95) continue;
      cues.push({ t, file: "type.m4a", gain: 0.1, pan: 0.05 });
      lastKey = t;
    }
    for (const v of log.voices || []) {
      const t = mapTime(tl, id, v.t);
      if (t != null) cues.push({ t, file: v.file, reel: id, gain: 0.9, pan: 0, voice: true });
    }
  }
  return cues.sort((a, b) => a.t - b.t);
}

/// Quiet kalimba under a demo cut: the same four-chord arpeggio Director
/// uses, at a slow walk and well under the clicks.
export function musicCues(dur, { beat = 520, level = 0.35 } = {}) {
  const BARS = [["a3", ["a3", "e4", "a4", "c5", "e5", "c5", "a4", "e4"]], ["f3", ["f3", "c4", "f4", "a4", "c5", "a4", "f4", "c4"]],
    ["c3", ["c3", "g3", "c4", "e4", "g4", "e4", "c4", "g3"]], ["g3", ["g3", "d4", "g4", "b4", "d5", "b4", "g4", "d4"]]];
  const cues = [];
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let b = 0, t = 600; t < dur - 1500; b++, t += 4 * beat) {
    const [root, arp] = BARS[b % 4];
    cues.push({ t, file: `note-${root}.m4a`, gain: 0.5 * level, pan: 0 });
    arp.forEach((n, k) => cues.push({ t: t + (k * beat) / 2 + (r() - 0.5) * 12, file: `note-${n}.m4a`, gain: (k % 2 ? 0.2 : 0.3) * level, pan: (r() - 0.5) * 0.4 }));
  }
  return cues;
}

export const mmss = ms => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
