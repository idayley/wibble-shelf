// Director's motion kit. A film is one HTML page: scenes on a timeline,
// drawn from a single clock, so the same page plays live on the canvas and
// renders frame-exact to MP4. Every sound is a cue placed from that same
// timeline -- by hand, or by the characters' own verbs -- so the picture and
// the soundtrack cannot drift apart.
//
// See GUIDE.md for the API. The short version:
//
//   const F = film({ title: "Hello", end: 12000 });
//   scene(0, 6000, (root, at) => { ...build...; return lt => { ...draw at local time lt... }; });
//   captions([[300, 2800, "Hello, *world.*"]]);
//
// Everything here is global on purpose: a film is a short script, not an app.
(() => {
"use strict";
const me = document.currentScript;
const KIT = me ? me.src.replace(/[^/]*$/, "") : "./";
const q = new URLSearchParams(location.search);
const RENDER = q.has("render");

// ---------- small maths ----------
const lerp = (a, b, u) => a + (b - a) * u;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const tl = (t, a, b) => clamp((t - a) / (b - a));
const eo3 = u => 1 - Math.pow(1 - u, 3);
const eio = u => -(Math.cos(Math.PI * u) - 1) / 2;
const eob = u => { const c = 1.7; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); };
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0xffffffff; }; }
const $ = id => document.getElementById(id);
function el(tag, cls, parent, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; if (parent) parent.appendChild(e); return e; }
function pos(e, x, y, w, h) { e.style.left = x + "px"; e.style.top = y + "px"; if (w != null) e.style.width = w + "px"; if (h != null) e.style.height = h + "px"; return e; }
function svgEl(parent, cls, w, h) { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", cls || ""); if (w) { s.setAttribute("viewBox", `0 0 ${w} ${h}`); s.style.width = w + "px"; s.style.height = h + "px"; s.style.left = s.style.top = "0"; s.style.overflow = "visible"; } parent.appendChild(s); return s; }
function vis(e, on) { e.style.visibility = on ? "visible" : "hidden"; }
// Pops an element in with an overshoot and a squash, or hides it before it starts.
function popIn(e, u, rot = 0, dy = -60, extra = "") {
  if (u <= 0) { vis(e, false); return; }
  vis(e, true);
  const k = eob(clamp(u)), sq = u < 1 ? Math.sin(Math.PI * u) * 0.12 : 0;
  e.style.transform = `${extra} translateY(${(1 - Math.min(1, k)) * dy}px) rotate(${rot}deg) scale(${k * (1 + sq)}, ${k * (1 - sq)})`;
}
// The scale of a speech bubble `age` ms after it appears: up, a little over, settle.
const popBub = age => age < 0 ? 0 : age < 260 ? Math.max(0, 1 + 0.12 * Math.sin((age / 260) * Math.PI) - (1 - eo3(age / 260))) : 1;
// Keyframes: [[u, {prop: v}], ...] eased in-out between each pair.
function kf(frames, u) {
  for (let i = 0; i < frames.length - 1; i++) {
    const [p0, a] = frames[i], [p1, b] = frames[i + 1];
    if (u <= p1) { const k = eio(clamp((u - p0) / (p1 - p0 || 1))); const o = {}; for (const key in a) o[key] = lerp(a[key], b[key] ?? a[key], k); return o; }
  }
  return { ...frames[frames.length - 1][1] };
}

// ---------- wibblets ----------
const ASPECT = {
  A: 0.9124, B: 0.7381, C: 0.845, D: 0.801, E: 0.829, F: 0.7662, G: 0.8768, H: 0.8077, I: 0.4245, J: 0.7788, K: 0.8261, L: 0.7225, M: 0.9519,
  N: 0.8125, O: 0.8821, P: 0.7333, Q: 0.8796, R: 0.7826, S: 0.7101, T: 0.9163, U: 0.8244, V: 0.9275, W: 1.2995, X: 0.9175, Y: 0.9034, Z: 0.8382,
  director: 0.9034,
};
// The W is the logo and always wears the logo's red; everyone else takes a slot.
const LOGO = ["oklch(66% 0.22 28)", "oklch(66% 0.22 7.5)"];
const slotTint = slot => { const h = 90 + (210 * (((slot % 8) + 8) % 8)) / 7; return [`oklch(66% 0.2 ${h.toFixed(1)})`, `oklch(66% 0.21 ${(h + 22).toFixed(1)})`]; };
function mkW(parent, letter, o = {}) {
  if (!ASPECT[letter]) throw new Error(`No wibblet "${letter}". Use A-Z or "director".`);
  const h = o.h || 120, w = h * ASPECT[letter];
  const sh = el("div", "mo-sh", parent); sh.style.width = `${w * 0.8}px`;
  const e = el("div", "mo-wb", parent);
  e.dataset.l = letter;
  e.style.width = `${w}px`; e.style.height = `${h}px`;
  const [t1, t2] = o.tint ? [o.tint, o.tint2 || o.tint] : (o.logo ?? letter === "W") ? LOGO : slotTint(o.slot || 0);
  e.style.setProperty("--tint", t1); e.style.setProperty("--tint2", t2);
  return { el: e, sh, w, h, letter };
}
// Places a wibblet with its feet at (x, gy), in pose p -- or hides it when p is null.
function put(o, x, gy, p) {
  if (!p) { o.el.style.display = o.sh.style.display = "none"; return; }
  o.el.style.display = o.sh.style.display = "block";
  const y = p.y || 0, sx = p.sx ?? 1.055, sy = p.sy ?? 0.945;
  o.el.style.transform = `translate(${x - o.w / 2}px, ${gy - o.h + y}px) rotate(${p.rot || 0}deg) scale(${sx}, ${sy})`;
  const lift = clamp(-y / 220);
  o.sh.style.opacity = String((1 - lift) * (p.shadow ?? 1));
  o.sh.style.transform = `translate(${x - o.w * 0.4}px, ${gy - 9}px) scale(${(1 - lift * 0.6) * sx}, 1)`;
}
function breathe(t, ph) { const s = (Math.sin((t / 5200 + ph) * 2 * Math.PI) + 1) / 2; return { sx: 1.055 + 0.03 * s, sy: 0.945 - 0.027 * s }; }
const REST = { y: 0, sx: 1.055, sy: 0.945 };

// One character's timeline, written as a chain of verbs. Times are ms in the
// scene's own clock; x is where the feet are; y is height above the ground (negative is up).
class Actor {
  constructor(o, gy, ph) { this.o = o; this.gy = gy; this.ph = ph ?? Math.random(); this.segs = []; this.t = 0; this.x = 0; this.y = 0; this.rot = 0; }
  push(type, ms, p) { const g = { type, t0: this.t, t1: this.t + ms, x: this.x, y: this.y, rot: this.rot, ...p }; this.segs.push(g); this.t += ms; return g; }
  at(t, x, y = 0) { this.t = t; this.x = x; this.y = y; return this; }
  run(x1, ms, o = {}) {
    const dist = Math.abs(x1 - this.x);
    this.push("run", ms, { x0: this.x, x1, strides: o.strides || Math.max(1, Math.round(dist / (o.stride || 170))), jump: o.jump ?? 26, dir: Math.sign(x1 - this.x) || 1, dust: o.dust });
    this.x = x1; this.rot = 0; return this;
  }
  skid(x1, ms = 380) { this.push("skid", ms, { x0: this.x, x1, dir: Math.sign(x1 - this.x) || 1 }); this.x = x1; return this; }
  hold(ms) { this.push("hold", ms, {}); return this; }
  until(t) { if (t > this.t) this.hold(t - this.t); return this; }
  hop(ms = 620, o = {}) { const x1 = o.to ?? this.x; this.push("hop", ms, { x0: this.x, x1, H: o.H ?? 46 }); this.x = x1; return this; }
  arc(x1, y1, ms, o = {}) { this.push("arc", ms, { x0: this.x, y0: this.y, x1, y1, peak: o.peak ?? 160, spin: o.spin ?? 0, rot0: this.rot }); this.x = x1; this.y = y1; this.rot = 0; return this; }
  plop(ms = 460, o = {}) { this.push("plop", ms, { big: o.big }); return this; }
  startle(ms = 320) { this.push("startle", ms, {}); return this; }
  lean(deg, ms = 600) { this.push("lean", ms, { deg }); return this; }
  wobble(ms = 700) { this.push("wobble", ms, {}); return this; }
  gone() { this.push("gone", 1, {}); return this; }
}
const POSE = {
  hold(g, u, t, a) { const b = breathe(t, a.ph); return { x: g.x, y: g.y, sx: b.sx, sy: b.sy, rot: 0 }; },
  run(g, u) { const ph = (u * g.strides) % 1, s = Math.sin(Math.PI * ph); return { x: lerp(g.x0, g.x1, u), y: g.y - g.jump * s, sx: lerp(1.17, 0.92, s), sy: lerp(0.85, 1.1, s), rot: g.dir * 7 }; },
  skid(g, u) { const k = eo3(u); return { x: lerp(g.x0, g.x1, k), y: g.y, sx: lerp(1.26, 1.055, k), sy: lerp(0.78, 0.945, k), rot: -g.dir * 17 * (1 - k) }; },
  hop(g, u) {
    const p = kf([[0, REST], [0.12, { y: 0, sx: 1.22, sy: 0.78 }], [0.3, { y: -0.8 * g.H, sx: 0.86, sy: 1.17 }], [0.45, { y: -g.H, sx: 1, sy: 1 }],
      [0.68, { y: 0, sx: 1.24, sy: 0.76 }], [0.8, { y: -0.08 * g.H, sx: 0.96, sy: 1.06 }], [0.9, { y: 0, sx: 1.1, sy: 0.9 }], [1, REST]], u);
    const m = eio(clamp((u - 0.12) / 0.56));
    return { x: lerp(g.x0, g.x1, m), ...p, y: g.y + p.y, rot: 0 };
  },
  arc(g, u) { const s = Math.sin(Math.PI * u); return { x: lerp(g.x0, g.x1, u), y: lerp(g.y0, g.y1, u) - g.peak * 4 * u * (1 - u), sx: lerp(1, 0.88, s), sy: lerp(1, 1.14, s), rot: g.rot0 + g.spin * eio(u) }; },
  plop(g, u) {
    const p = g.big
      ? kf([[0, { sx: 1.5, sy: 0.55 }], [0.35, { sx: 0.9, sy: 1.14 }], [0.65, { sx: 1.1, sy: 0.9 }], [1, { sx: 1.055, sy: 0.945 }]], u)
      : kf([[0, { sx: 1.38, sy: 0.66 }], [0.4, { sx: 0.93, sy: 1.09 }], [0.7, { sx: 1.08, sy: 0.92 }], [1, { sx: 1.055, sy: 0.945 }]], u);
    return { x: g.x, y: g.y, sx: p.sx, sy: p.sy, rot: 0 };
  },
  startle(g, u) { const p = kf([[0, REST], [0.25, { y: -18, sx: 0.84, sy: 1.2 }], [0.6, { y: 0, sx: 1.18, sy: 0.84 }], [1, REST]], u); return { x: g.x, ...p, y: g.y + p.y, rot: 0 }; },
  lean(g, u, t, a) { const b = breathe(t, a.ph), k = Math.sin(Math.PI * u); return { x: g.x, y: g.y, sx: b.sx, sy: b.sy, rot: g.rot + g.deg * k }; },
  wobble(g, u) { const d = Math.exp(-4 * u) * Math.sin(u * Math.PI * 7); return { x: g.x, y: g.y, sx: 1.055 + 0.16 * d, sy: 0.945 - 0.15 * d, rot: 6 * d }; },
  gone() { return null; },
};
function poseOf(a, t) {
  const s = a.segs;
  if (!s.length || t < s[0].t0) return null;
  let g = s[0];
  for (const x of s) { if (x.t0 <= t) g = x; else break; }
  const u = g.t1 > g.t0 ? clamp((t - g.t0) / (g.t1 - g.t0)) : 1;
  return POSE[g.type](g, u, t, a);
}
const xAt = (g, t) => lerp(g.x0, g.x1, clamp((t - g.t0) / (g.t1 - g.t0)));
// Dust comes from the verbs themselves: a skid, a landing, a stampede's footfalls.
function dustFor(actors) {
  const out = [], r = rng(99);
  for (const a of actors) {
    const w = a.o.w, gy = a.gy;
    for (const g of a.segs) {
      if (g.type === "skid") for (let k = 0; k < 5; k++) { const t = g.t0 + (k * (g.t1 - g.t0)) / 5; out.push({ t, x: xAt(g, t) - g.dir * w * 0.3, gy, dir: -g.dir, size: 34 + r() * 12 }); }
      if (g.type === "plop" && g.y > -4) {
        const big = g.big ? 1.8 : 1;
        out.push({ t: g.t0, x: g.x - w * 0.45, gy, dir: -1, size: 30 * big }, { t: g.t0, x: g.x + w * 0.45, gy, dir: 1, size: 30 * big });
        if (g.big) out.push({ t: g.t0 + 40, x: g.x, gy, dir: 0, size: 44 });
      }
      if (g.type === "run" && g.dust) for (let k = 1; k <= g.strides; k++) {
        const t = g.t0 + (k * (g.t1 - g.t0)) / g.strides, x = xAt(g, t);
        if (x > -60 && x < FILM.w + 60) out.push({ t, x: x - g.dir * w * 0.3, gy, dir: -g.dir, size: 18 + r() * 14 });
      }
    }
  }
  return out;
}
function drawPuff(e, d, age) {
  const u = age / 560, k = eo3(u), s = (d.size / 40) * (0.5 + 0.9 * k);
  e.style.display = "block"; e.style.opacity = String(0.9 * (1 - u));
  e.style.transform = `translate(${d.x + d.dir * 52 * k - 20}px, ${d.gy - 24 - 24 * k}px) scale(${s})`;
}
// A cast for one scene: its actors, and the dust their verbs kick up. Their
// footsteps, hops and landings are cued automatically.
function troupe(parent) {
  const list = [], pool = []; let dust = null;
  const self = {};
  for (let i = 0; i < 56; i++) { const p = el("div", "mo-puff", parent); p.style.display = "none"; pool.push(p); }
  TROUPES.push(self);
  return Object.assign(self, {
    list,
    add(letter, gy, o = {}) { const a = new Actor(mkW(parent, letter, o), gy, o.ph); a.quiet = !!o.quiet; list.push(a); return a; },
    sortZ() { [...list].sort((a, b) => a.gy - b.gy).forEach(a => parent.append(a.o.sh, a.o.el)); },
    draw(lt) {
      if (!dust) dust = dustFor(list);
      for (const a of list) { const p = poseOf(a, lt); a.pose = p; put(a.o, p ? p.x : 0, a.gy, p); }
      let k = 0;
      for (const d of dust) { const age = lt - d.t; if (age < 0 || age > 560 || k >= pool.length) continue; drawPuff(pool[k++], d, age); }
      for (; k < pool.length; k++) pool[k].style.display = "none";
    },
  });
}
function actorCues(tr, at) {
  const cx = FILM.w / 2;
  for (const a of tr.list) {
    if (a.quiet) continue;
    const big = a.o.h >= 140, size = clamp(a.o.h / 150, 0.4, 1.1);
    for (const g of a.segs) {
      const d = g.t1 - g.t0;
      if (g.type === "arc") at(g.t0, big ? "throw" : "emit", big ? 0.9 : 0.35, g.x0);
      if (g.type === "plop") at(g.t0, g.big ? "land_big" : "land", g.big ? 1 : 0.7 * size, g.x);
      if (g.type === "hop") { at(g.t0 + 0.12 * d, "hop", clamp(g.H / 70, 0.3, 1) * size, g.x0); at(g.t0 + 0.68 * d, "land", 0.4 * size, g.x1); }
      if (g.type === "skid") at(g.t0, "skid", size, g.x0);
      if (g.type === "startle") at(g.t0, "squish", 0.5 * size, g.x);
      if (g.type === "wobble") at(g.t0, "squish", 0.6 * size, g.x);
      if (g.type === "run") for (let k = 1; k <= g.strides; k++) {
        const t = g.t0 + (k * d) / g.strides, x = xAt(g, t);
        if (x > -40 && x < 2 * cx + 40) at(t, "step", (g.dust ? 0.22 : 0.12) * size, x);
      }
    }
  }
}

// ---------- props ----------
function confetti(parent, n, seed, at, t) {
  const r = rng(seed), cols = ["oklch(62% 0.22 20)", "oklch(72% 0.17 88)", "oklch(66% 0.18 160)", "oklch(64% 0.17 250)", "oklch(66% 0.2 300)"];
  const bits = [];
  for (let i = 0; i < n; i++) {
    const d = el("i", "mo-cf", parent); d.style.background = cols[i % cols.length];
    d.style.width = `${12 + r() * 12}px`; d.style.height = `${7 + r() * 8}px`;
    const a = -Math.PI / 2 + (r() - 0.5) * 2.2, v = 0.7 + r() * 0.9;
    bits.push({ d, vx: Math.cos(a) * v, vy: Math.sin(a) * v, spin: (r() - 0.5) * 2 });
  }
  if (at && t != null) at(t, "confetti", 1);
  // draw(x, y, age): a burst from (x, y), age ms after it went off.
  return (x, y, age) => {
    for (const b of bits) {
      if (age < 0 || age > 1500) { b.d.style.display = "none"; continue; }
      const s = age, px = x + b.vx * s * (1 - s / 4000), py = y + b.vy * s + 0.0019 * s * s;
      b.d.style.display = "block"; b.d.style.opacity = String(1 - tl(age, 1100, 1500));
      b.d.style.transform = `translate(${px}px, ${py}px) rotate(${b.spin * s}deg)`;
    }
  };
}
// A ring that bursts outward from (x, y) at t: returns draw(lt).
function ripple(parent, t, x, y, o = {}) {
  const e = el("div", "mo-ring", parent), size = o.size ?? 600, ms = o.ms ?? 560;
  if (o.color) e.style.borderColor = o.color;
  if (o.width) e.style.borderWidth = o.width + "px";
  return lt => {
    const u = tl(lt, t, t + ms);
    if (u <= 0 || u >= 1) { e.style.display = "none"; return; }
    const d = 40 + size * eo3(u);
    e.style.display = "block"; e.style.opacity = String(1 - u); e.style.width = e.style.height = `${d}px`;
    e.style.transform = `translate(${x - d / 2}px, ${y - d / 2}px)`;
  };
}
// Text typed out from t, one character every `ms`, with a key sound per character.
function typeOn(at, t, text, o = {}) {
  const ms = o.ms ?? 45, plain = text.replace(/<[^>]*>/g, "");
  if (o.sound !== false) for (let i = 0; i < plain.length; i++) if (plain[i] !== " ") at(t + i * ms, "type", o.gain ?? 0.5, o.x);
  return lt => plain.slice(0, clamp(Math.floor((lt - t) / ms), 0, plain.length));
}
const PTR = `<svg viewBox="0 0 34 46" aria-hidden="true"><path d="M3 3 L3 37 L12 29 L18 43 L24 40 L18 27 L30 27 Z" fill="#fff" stroke="#1f1e25" stroke-width="3" stroke-linejoin="round"/></svg>`;
// A mouse pointer on its own timeline: p.at(t, x, y).to(t, x, y, ms).click(t).hide(t)
function pointer(parent, at) {
  const e = el("div", "mo-ptr", parent, PTR), keys = [], clicks = []; let hideAt = Infinity, showAt = Infinity;
  const self = {
    at(t, x, y) { keys.push({ t, x, y, ms: 0 }); showAt = Math.min(showAt, t); return self; },
    to(t, x, y, ms = 500) { keys.push({ t, x, y, ms }); return self; },
    click(t, gain = 0.9) { clicks.push(t); const k = self.where(t); at(t, "click", gain, k.x); return self; },
    hide(t) { hideAt = t; return self; },
    where(t) {
      let x = keys[0]?.x ?? 0, y = keys[0]?.y ?? 0;
      for (const k of keys) { if (t < k.t) break; const u = k.ms ? eio(tl(t, k.t, k.t + k.ms)) : 1; x = lerp(x, k.x, u); y = lerp(y, k.y, u); if (u < 1) break; }
      return { x, y };
    },
    // How far into a press the pointer is at lt (0..1..0), for squashing whatever it presses.
    press(lt) { for (const c of clicks) if (lt >= c && lt < c + 220) return Math.sin(tl(lt, c, c + 220) * Math.PI); return 0; },
    draw(lt) {
      const on = lt >= showAt && lt < hideAt + 300;
      vis(e, on); if (!on) return;
      const p = self.where(lt);
      e.style.opacity = String(1 - tl(lt, hideAt, hideAt + 300));
      e.style.transform = `translate(${p.x}px, ${p.y}px) scale(${1 - 0.15 * self.press(lt)})`;
    },
  };
  return self;
}

// ---------- the film ----------
const FILM = { w: 1080, h: 1080, end: 10000, whip: 420, hold: 1000, title: "", theme: "light", poster: null, music: 0.8 };
const SCENES = [], CUES = [], TROUPES = [], CAPS = [], BEATS = [];
let world = null, started = false;
function film(o = {}) {
  if (o.size) [FILM.w, FILM.h] = o.size;
  for (const k of ["end", "whip", "hold", "title", "theme", "poster", "music"]) if (o[k] != null) FILM[k] = o[k];
  FILM.cap = { top: Math.round(FILM.h * 0.06), size: Math.round(Math.min(FILM.w, FILM.h) * 0.061), ...(o.captions || {}) };
  world = el("div", "mo-world" + (FILM.theme === "dark" ? " mo-dark" : ""));
  world.style.width = FILM.w + "px"; world.style.height = FILM.h + "px";
  if (FILM.title) document.title = FILM.title;
  return FILM;
}
const cue = (t, k, g = 1, x) => { CUES.push({ t: Math.round(t), k, g: +(+g).toFixed(3), pan: +clamp(((x ?? FILM.w / 2) - FILM.w / 2) / (FILM.w * 0.55), -1, 1).toFixed(2) }); };
function scene(t0, t1, build, o = {}) {
  if (!world) film();
  const root = el("div", "mo-scene", world), s = { t0, t1, root, enter: o.enter || "whip", bg: o.bg };
  if (o.bg) root.style.background = o.bg;
  const at = (ms, k, g, x) => cue(t0 + ms, k, g, x);
  const before = TROUPES.length;
  s.draw = build(root, at) || (() => {});
  for (const tr of TROUPES.slice(before)) actorCues(tr, at);
  SCENES.push(s);
  return s;
}
function captions(list, o = {}) { for (const c of list) CAPS.push({ t0: c[0], t1: c[1], text: c[2], top: c[3]?.top ?? o.top, size: c[3]?.size ?? o.size }); }
function beats(list) { for (const b of list) BEATS.push({ t: b[0], name: b[1], note: b[2] || "" }); }

// A kalimba groove under the film, as cues like everything else: eighth-note
// arpeggios over a four-chord loop, a tune on alternate phrases, and a rolled
// chord at `resolve` -- put that on the moment the film lands.
const PROGRESSIONS = {
  bright: [["c3", ["c3", "g3", "c4", "e4", "g4", "e4", "c4", "g3"]], ["g3", ["g3", "d4", "g4", "b4", "d5", "b4", "g4", "d4"]],
    ["a3", ["a3", "e4", "a4", "c5", "e5", "c5", "a4", "e4"]], ["f3", ["f3", "c4", "f4", "a4", "c5", "a4", "f4", "c4"]]],
  gentle: [["a3", ["a3", "e4", "a4", "c5", "e5", "c5", "a4", "e4"]], ["f3", ["f3", "c4", "f4", "a4", "c5", "a4", "f4", "c4"]],
    ["c3", ["c3", "g3", "c4", "e4", "g4", "e4", "c4", "g3"]], ["g3", ["g3", "d4", "g4", "b4", "d5", "b4", "g4", "d4"]]],
};
const TUNES = {
  bright: [["e5", null, "d5", "c5"], ["b4", null, "g4", null], ["c5", null, "e5", "d5"], ["c5", null, "a4", null]],
  gentle: [["e5", null, "c5", null], ["c5", null, "a4", null], ["g4", null, "c5", "e5"], ["d5", null, "b4", null]],
};
const RESOLVE = { bright: ["c3", "g3", "c4", "e4", "g4", "c5", "e5"], gentle: ["c3", "g3", "c4", "e4", "g4", "c5", "e5"] };
function groove(o = {}) {
  const beat = o.beat ?? 420, mood = PROGRESSIONS[o.mood] ? o.mood : "bright", from = o.from ?? 0, to = o.to ?? FILM.end, r = rng(4);
  const bars = PROGRESSIONS[mood], tune = o.tune === false ? null : TUNES[mood], v = FILM.music;
  const n = (t, name, g, x) => cue(t, "note:" + name, g * v, x);
  let b = 0, t = from;
  while (t < to) {
    const [root, arp] = bars[b % 4];
    arp.forEach((name, k) => { const tt = t + (k * beat) / 2; if (tt < to) n(tt + (r() - 0.5) * 12, name, (k % 2 ? 0.2 : 0.32) * (k ? 1 : 1.25), FILM.w / 2 + (r() - 0.5) * FILM.w * 0.28); });
    n(t, root, 0.5);
    if (tune && Math.floor(b / 4) % 2 === 1) tune[b % 4].forEach((name, k) => { if (name && t + k * beat < to) n(t + k * beat + 4, name, 0.42, FILM.w * 0.58); });
    b += 1; t += 4 * beat;
  }
  if (o.resolve != null) RESOLVE[mood].forEach((name, i) => n(o.resolve + i * 28, name, 0.55, FILM.w / 2 + ((i - 3) / 6) * FILM.w * 0.55));
}

// ---------- sound ----------
// kind -> file stem, number of takes, gain. Aliases share a file at their own level.
const SOUNDS = {
  type: ["type", 1, 0.35], land: ["land", 3, 0.6], land_big: ["land_big", 3, 1], hop: ["hop", 3, 0.7], step: ["step", 3, 0.45],
  skid: ["skid", 3, 0.7], whoosh: ["whoosh", 1, 0.6], throw: ["whoosh", 1, 0.7], whip: ["whoosh", 1, 0.5], cast: ["whoosh", 1, 0.5],
  drop: ["drop", 3, 0.6], pin: ["drop", 3, 0.6], emit: ["drop", 3, 0.5], bubble: ["bubble", 3, 0.5], click: ["click", 3, 0.6],
  chime: ["chime", 2, 0.7], notify: ["notify", 1, 0.6], stamp: ["stamp", 3, 1], pickup: ["pickup", 3, 0.8], card: ["card", 3, 0.7],
  squish: ["squish", 3, 0.8], shake: ["shake", 2, 0.8], bite: ["bite", 1, 0.8], bonk: ["bonk", 2, 1], word: ["word", 3, 0.2],
  confetti: ["confetti", 1, 1], burst: ["burst", 1, 1], stars: ["stars", 1, 1],
};
const NOTES = ["c3", "d3", "e3", "f3", "g3", "a3", "b3", "c4", "d4", "e4", "f4", "g4", "a4", "b4", "c5", "d5", "e5"];
// Resolves every cue to the file it plays, at what level and rate. The live
// player and the renderer both read this, so they cannot disagree.
function resolveCues() {
  const turn = {}, r = rng(1), out = []; let lastStep = -1e9;
  for (const c of CUES) {
    let file, gain, rate = 1;
    if (c.k.startsWith("note:")) {
      const n = c.k.slice(5); if (!NOTES.includes(n)) continue;
      file = `note-${n}.m4a`; gain = 0.7 * c.g;
    } else {
      const s = SOUNDS[c.k]; if (!s) continue;
      if (c.k === "step") { if (c.t - lastStep < 55) continue; lastStep = c.t; } // a stampede is a patter, not a wall
      const i = turn[c.k] = (turn[c.k] ?? -1) + 1;
      file = s[1] > 1 ? `${s[0]}-${(i % s[1]) + 1}.m4a` : `${s[0]}.m4a`; gain = s[2] * c.g; rate = 1 + (r() - 0.5) * 0.08;
    }
    out.push({ t: c.t, file, gain: +gain.toFixed(3), pan: c.pan, rate: +rate.toFixed(3) });
  }
  return out;
}

// ---------- drawing ----------
let cap, streaks, capOn = -2;
function words(txt) {
  let hi = false; const out = [];
  txt.split(/(\*)/).forEach(seg => { if (seg === "*") { hi = !hi; return; } seg.split(" ").filter(Boolean).forEach(w => out.push(`<span class="${hi ? "hi" : ""}">${w}</span>`)); });
  return out.join(" ");
}
function drawCap(t) {
  const i = CAPS.findIndex(c => t >= c.t0 && t < c.t1);
  if (i !== capOn) {
    capOn = i; cap.innerHTML = i < 0 ? "" : words(CAPS[i].text);
    if (i >= 0) { cap.style.top = (CAPS[i].top ?? FILM.cap.top) + "px"; cap.style.fontSize = (CAPS[i].size ?? FILM.cap.size) + "px"; }
  }
  if (i < 0) return;
  const c = CAPS[i], out = tl(t, c.t1 - 170, c.t1);
  [...cap.children].forEach((s, k) => {
    const age = t - c.t0 - k * 70, u = clamp(age / 380), sc = age < 0 ? 0 : eob(u);
    s.style.opacity = age < 0 ? "0" : "1";
    s.style.transform = `translateY(${(1 - Math.min(1, sc)) * 50}px) rotate(${(1 - u) * (k % 2 ? 5 : -5)}deg) scale(${Math.max(0, sc) * (1 - out)})`;
  });
}
let T = 0;
function render(t) {
  T = t = clamp(t, 0, FILM.end);
  const W = FILM.w, WH = FILM.whip;
  SCENES.forEach((s, i) => {
    const next = SCENES[i + 1], first = i === 0, last = !next;
    const exitMs = !next || next.enter === "cut" ? 0 : WH;
    const on = t >= s.t0 && (last || t < s.t1 + exitMs);
    if (!on) { s.root.style.display = "none"; return; }
    s.root.style.display = "block";
    let tf = "", op = 1;
    if (!first && t < s.t0 + WH) {
      const u = (t - s.t0) / WH;
      if (s.enter === "whip") tf = `translateX(${W * (1 - eob(u))}px) rotate(${5 * (1 - u)}deg)`;
      else if (s.enter === "fade") op = eio(u);
      else if (s.enter === "zoom") { tf = `scale(${lerp(1.18, 1, eo3(u))})`; op = eo3(u); }
    }
    if (!last && t >= s.t1 && next) {
      const u = eio(clamp((t - s.t1) / WH));
      if (next.enter === "whip") tf = `translateX(${-W * u}px) rotate(${-5 * u}deg)`;
      else if (next.enter === "zoom") tf = `scale(${lerp(1, 0.9, u)})`;
    }
    s.root.style.transform = tf; s.root.style.transformOrigin = "50% 50%"; s.root.style.opacity = String(op);
    s.draw(t - s.t0);
  });
  let wu = -1;
  for (let i = 0; i < SCENES.length - 1; i++) { const b = SCENES[i].t1; if (SCENES[i + 1].enter === "whip" && t >= b && t < b + WH) wu = (t - b) / WH; }
  streaks.forEach((s, i) => {
    if (wu < 0) { s.style.display = "none"; return; }
    s.style.display = "block"; s.style.opacity = String(0.22 * Math.sin(Math.PI * wu));
    s.style.width = `${W * (0.35 + 0.13 * (i % 3))}px`;
    s.style.transform = `translate(${lerp(W * 1.1, -W * 0.65, eio(wu)) + i * 70}px, ${FILM.h * (0.24 + i * 0.14)}px)`;
  });
  drawCap(t);
  ui.sync?.();
}

// ---------- lint: what a reviewer would catch ----------
function lint() {
  const w = [];
  const kinds = new Set(Object.keys(SOUNDS));
  const bad = [...new Set(CUES.filter(c => !(c.k.startsWith("note:") ? NOTES.includes(c.k.slice(5)) : kinds.has(c.k))).map(c => c.k))];
  if (bad.length) w.push(`Unknown sound kinds (they will be silent): ${bad.join(", ")}`);
  const ss = [...SCENES].sort((a, b) => a.t0 - b.t0);
  if (!ss.length) w.push("No scenes.");
  else {
    if (ss[0].t0 > 0) w.push(`Nothing on screen before ${ss[0].t0}ms.`);
    for (let i = 1; i < ss.length; i++) {
      if (ss[i].t0 > ss[i - 1].t1) w.push(`Gap between scenes: ${ss[i - 1].t1}-${ss[i].t0}ms is blank.`);
      if (ss[i].t0 < ss[i - 1].t1) w.push(`Scenes overlap at ${ss[i].t0}ms (the earlier one ends at ${ss[i - 1].t1}).`);
    }
    if (ss[ss.length - 1].t1 < FILM.end) w.push(`The last scene ends at ${ss[ss.length - 1].t1}ms but the film runs to ${FILM.end}ms.`);
  }
  CAPS.forEach((c, i) => {
    const n = c.text.replace(/\*/g, "").split(/\s+/).filter(Boolean).length;
    if (n > 8) w.push(`Caption ${i + 1} has ${n} words; keep it to 8 or fewer: "${c.text}"`);
    const readMs = 600 + n * 200;
    if (c.t1 - c.t0 < readMs) w.push(`Caption ${i + 1} is up for ${c.t1 - c.t0}ms; ${n} words need about ${readMs}ms.`);
    if (CAPS[i + 1] && CAPS[i + 1].t0 < c.t1) w.push(`Captions ${i + 1} and ${i + 2} overlap.`);
    for (const s of ss.slice(1)) if (c.t0 < s.t0 && c.t1 > s.t0 + 40) w.push(`Caption ${i + 1} runs across the cut at ${s.t0}ms; end it just before.`);
  });
  if (FILM.end > 90000) w.push(`The film is ${(FILM.end / 1000).toFixed(0)}s long; most social cuts land under 60s.`);
  return w;
}

// ---------- the player ----------
const ui = {};
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.2-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="5.5" y="4" width="4.5" height="16" rx="1.4" fill="currentColor"/><rect x="14" y="4" width="4.5" height="16" rx="1.4" fill="currentColor"/></svg>',
  replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
  on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="m16.5 9.5 5 5m0-5-5 5"/></svg>',
};
const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
let playing = false, lastNow = 0, sound = true, heard = -1, pool = new Map(), live = [];
function audio(file) {
  if (!pool.has(file)) { const a = new Audio(KIT + "sounds/" + file); a.preload = "auto"; pool.set(file, a); }
  return pool.get(file);
}
function fire(from, to) {
  if (!sound || RENDER) return;
  for (const c of live) {
    if (c.t <= from || c.t > to) continue;
    if (to - c.t > 120) continue; // a cue we are late for by more than a beat stays unplayed
    const a = audio(c.file).cloneNode();
    a.volume = clamp(c.gain * 0.9); a.preservesPitch = false; a.playbackRate = c.rate;
    a.play().catch(() => {});
  }
}
function setPlaying(on) {
  playing = on;
  // The poster is the end card, so the first play starts from the top.
  if (on) { if (T >= FILM.end || !ui.started) render(0); ui.started = true; heard = T; lastNow = performance.now(); ui.over.hidden = true; requestAnimationFrame(tick); }
  ui.sync();
}
function tick(now) {
  if (!playing) return;
  const t = T + Math.min(100, now - lastNow); lastNow = now;
  fire(heard, t); heard = t;
  if (t >= FILM.end) { render(FILM.end); playing = false; showOver("replay"); ui.sync(); return; }
  render(t); requestAnimationFrame(tick);
}
function showOver(kind) {
  ui.over.hidden = false;
  ui.big.innerHTML = ICON[kind]; ui.big.classList.toggle("replay", kind === "replay");
  ui.big.setAttribute("aria-label", kind === "replay" ? "Play again" : "Play");
}
function seek(ms) { ui.started = true; render(ms); heard = T; }
function layout() {
  if (RENDER) { Object.assign(ui.stage.style, { left: "0px", top: "0px", width: FILM.w + "px", height: FILM.h + "px" }); world.style.transform = "none"; return; }
  const P = ui.player, pw = P.clientWidth, ph = P.clientHeight, pad = Math.max(10, Math.min(24, pw * 0.025)), bar = 52;
  const k = Math.min((pw - 2 * pad) / FILM.w, (ph - 2 * pad - bar) / FILM.h);
  const sw = FILM.w * k, sh = FILM.h * k, x = (pw - sw) / 2, y = Math.max(pad, (ph - bar - sh) / 2);
  Object.assign(ui.stage.style, { left: x + "px", top: y + "px", width: sw + "px", height: sh + "px" });
  world.style.transform = `scale(${k})`;
  Object.assign(ui.bar.style, { left: x + "px", width: sw + "px", top: y + sh + 8 + "px" });
}
function buildPlayer() {
  const P = ui.player = el("div", "mo-player" + (RENDER ? " mo-render" : ""), document.body);
  ui.stage = el("div", "mo-stage", P); ui.stage.appendChild(world);
  ui.stage.setAttribute("aria-label", FILM.title || "Film");
  ui.over = el("div", "mo-over", ui.stage);
  ui.big = el("button", "mo-big", ui.over); ui.big.type = "button";
  const bar = ui.bar = el("div", "mo-bar", P);
  const play = el("button", "mo-btn play", bar); play.type = "button";
  const time = el("span", "mo-time", bar);
  const scrub = el("div", "mo-scrub", bar, `<div class="mo-rail"><div class="mo-fill"></div></div><div class="mo-knob"></div><div class="mo-tip"></div>`);
  scrub.tabIndex = 0; scrub.setAttribute("role", "slider"); scrub.setAttribute("aria-label", "Position"); scrub.setAttribute("aria-valuemin", "0"); scrub.setAttribute("aria-valuemax", String(FILM.end));
  const rail = scrub.querySelector(".mo-rail"), fill = scrub.querySelector(".mo-fill"), knob = scrub.querySelector(".mo-knob"), tip = scrub.querySelector(".mo-tip");
  const marks = BEATS.length ? BEATS : SCENES.map((s, i) => ({ t: s.t0, name: `Scene ${i + 1}` }));
  marks.forEach(b => { if (b.t > 0) el("i", "mo-tick", rail).style.left = `${(b.t / FILM.end) * 100}%`; });
  const beat = el("span", "mo-beat", bar);
  const snd = el("button", "mo-btn", bar); snd.type = "button";
  const beatAt = t => { let cur = null; for (const b of marks) if (t >= b.t) cur = b; return cur; };
  ui.sync = () => {
    const shown = ui.started ? T : 0;
    play.innerHTML = playing ? ICON.pause : ui.started && T >= FILM.end ? ICON.replay : ICON.play;
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
    time.innerHTML = `<b>${fmt(shown)}</b> / ${fmt(FILM.end)}`;
    const u = shown / FILM.end; fill.style.width = `${u * 100}%`; knob.style.left = `${u * 100}%`;
    scrub.setAttribute("aria-valuenow", String(Math.round(T))); scrub.setAttribute("aria-valuetext", fmt(T));
    beat.textContent = ui.started ? beatAt(T)?.name || "" : FILM.title;
    beat.classList.toggle("title", !ui.started);
    snd.innerHTML = sound ? ICON.on : ICON.off; snd.setAttribute("aria-pressed", String(sound)); snd.setAttribute("aria-label", sound ? "Mute" : "Sound on");
  };
  const toggle = () => setPlaying(!playing);
  play.addEventListener("click", toggle);
  ui.big.addEventListener("click", e => { e.stopPropagation(); setPlaying(true); });
  ui.stage.addEventListener("click", toggle);
  snd.addEventListener("click", () => { sound = !sound; ui.sync(); });
  const tAt = e => { const r = scrub.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width) * FILM.end; };
  const hover = e => { const t = tAt(e), b = beatAt(t); tip.innerHTML = `<i>${fmt(t)}</i>`; tip.append(b?.name || ""); tip.style.left = `${(t / FILM.end) * 100}%`; };
  let wasPlaying = false;
  scrub.addEventListener("pointermove", e => { hover(e); if (scrub.classList.contains("drag")) seek(tAt(e)); });
  scrub.addEventListener("pointerdown", e => { wasPlaying = playing; playing = false; scrub.setPointerCapture(e.pointerId); scrub.classList.add("drag"); ui.over.hidden = true; hover(e); seek(tAt(e)); });
  const up = () => { if (!scrub.classList.contains("drag")) return; scrub.classList.remove("drag"); if (wasPlaying && T < FILM.end) setPlaying(true); else ui.sync(); };
  scrub.addEventListener("pointerup", up); scrub.addEventListener("pointercancel", up);
  document.addEventListener("keydown", e => {
    if (e.target.matches?.("input, textarea")) return;
    const step = e.shiftKey ? 100 : 1000;
    if (e.key === " " || e.key === "k") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); ui.over.hidden = true; seek(T + step); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); ui.over.hidden = true; seek(T - step); }
    else if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(FILM.end);
    else if (e.key === "m") { sound = !sound; ui.sync(); }
  });
  new ResizeObserver(layout).observe(P);
  layout();
}

// ---------- boot ----------
function injectHead() {
  const add = (rel, href, extra = {}) => { const l = el("link"); l.rel = rel; l.href = href; Object.assign(l, extra); document.head.appendChild(l); return l; };
  add("preconnect", "https://fonts.gstatic.com", { crossOrigin: "" });
  add("stylesheet", "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Noto+Sans:wght@400;500;600;700;800&display=swap");
  const css = add("stylesheet", KIT + "motion.css");
  return new Promise(ok => { css.onload = ok; css.onerror = ok; });
}
const cssReady = injectHead();
let resolveReady; const ready = new Promise(r => { resolveReady = r; });
function start() {
  if (started) return; started = true;
  if (!world) film();
  cap = el("div", "mo-cap", world);
  streaks = [0, 1, 2, 3, 4].map(() => el("div", "mo-streak", world));
  SCENES.sort((a, b) => a.t0 - b.t0);
  SCENES.slice(1).forEach(s => { if (s.enter === "whip") cue(s.t0, "whip", 0.8); });
  CAPS.sort((a, b) => a.t0 - b.t0);
  CAPS.forEach(c => words(c.text).split("</span>").slice(0, -1).forEach((_, k) => cue(c.t0 + k * 70, "word", 0.18)));
  CUES.sort((a, b) => a.t - b.t);
  BEATS.sort((a, b) => a.t - b.t);
  live = resolveCues();
  buildPlayer();
  const poster = FILM.poster ?? FILM.end;
  if (q.has("t")) { render(+q.get("t")); ui.over.hidden = true; ui.started = true; }
  else { render(poster); showOver("play"); }
  if (!RENDER) { const want = new Set(live.map(c => c.file)); want.forEach(audio); }
  Promise.all([cssReady, document.fonts?.ready]).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => { render(T); resolveReady(true); });
}

document.addEventListener("DOMContentLoaded", start);

const Motion = {
  KIT, ready, start,
  seek(ms) { render(ms); return true; },
  info() { return { w: FILM.w, h: FILM.h, end: FILM.end, hold: FILM.hold, title: FILM.title, beats: BEATS.length ? BEATS : SCENES.map((s, i) => ({ t: s.t0, name: `Scene ${i + 1}` })), scenes: SCENES.map(s => [s.t0, s.t1, s.enter]), kit: KIT }; },
  cues: () => CUES.slice(),
  sounds: () => live.slice(),
  lint,
  stamp(text) { let s = document.querySelector(".mo-stamp"); if (!text) { s?.remove(); return; } if (!s) s = el("div", "mo-stamp", ui.stage); s.textContent = text; },
};
Object.assign(window, {
  Motion, film, scene, captions, beats, groove, cue,
  lerp, clamp, tl, eo3, eio, eob, rng, $, el, pos, svgEl, vis, popIn, popBub, kf, REST, breathe,
  slotTint, LOGO, ASPECT, mkW, put, Actor, troupe, poseOf, confetti, ripple, typeOn, pointer, PTR,
});
})();
