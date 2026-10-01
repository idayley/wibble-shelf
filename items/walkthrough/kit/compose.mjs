#!/usr/bin/env node
// Turns recorded reels into the finished film: the waits cut, the pointer
// smoothed, captions placed where the screen is calm, a gentle zoom only when
// something small is being used, chapter cards, soft sounds, and the
// persona's voice. Every frame is drawn from the reel's log, so the same
// reels always make the same film.
//
//   node compose.mjs <reel> [more reels…] --out film.mp4   the film
//   node compose.mjs <reel> --sheet sheet.png              a contact sheet: one frame per caption, to review
//   node compose.mjs <reel> --frame 12000                  one frame, as film-12000.png
//
// Options:
//   --script .walkthrough/flow.json   title, persona and chapter names; with several reels,
//                                     each chapter comes from the latest reel that finished it
//   --title "…" --persona "…" --app "…"   override what the title card says
//   --music          a quiet kalimba bed, for a demo cut (off by default)
//   --silent         no sound at all
//   --fps 30         frames per second (30 or 60)
//   --chrome <path>
// Writes film.mp4 and film.md (the chapter and step index, with times).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, launch, run } from "./cdp.mjs";
import {
  buildTimeline, captionAt, captionRuns, chooseReels, clamp, cursorAt, eio, frameAt, mmss, musicCues, pickBand,
  planZooms, soundCues, stepAt, throughZoom, zoomAt,
} from "./plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Sounds are Director's: from a clone of the shelf, read them from disk.
const DIRECTOR_SOUNDS = existsSync(path.join(here, "../../director/kit/sounds"))
  ? path.join(here, "../../director/kit/sounds")
  : "https://cdn.jsdelivr.net/gh/idayley/wibble-shelf@f624188ef4122124efeabb7e6b7322086a6d2a65/items/director/kit/sounds";

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (name, d) => { const i = argv.indexOf(name); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bool = name => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const FPS = +flag("--fps", 30), sheet = flag("--sheet"), frameMs = flag("--frame"), chrome = flag("--chrome");
const scriptPath = flag("--script"), titleArg = flag("--title"), personaArg = flag("--persona"), appArg = flag("--app");
let out = flag("--out");
const music = bool("--music"), silent = bool("--silent");
const reelDirs = argv.map(d => path.resolve(d));
if (!reelDirs.length) { console.error("usage: node compose.mjs <reel> [reels…] --out film.mp4 [--script flow.json] [--sheet s.png | --frame ms]"); process.exit(2); }
out ||= path.join(reelDirs[reelDirs.length - 1], "film.mp4");

// ---------- the reels ----------
const reels = {}, frames = {};
reelDirs.forEach((dir, i) => {
  const id = String(i);
  if (!existsSync(path.join(dir, "log.json"))) { console.error(`${dir} is not a reel (no log.json).`); process.exit(1); }
  reels[id] = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
  const rows = readFileSync(path.join(dir, "frames.tsv"), "utf8").trim().split("\n").filter(Boolean).map(l => l.split("\t"));
  frames[id] = { names: rows.map(r => r[0]), ts: rows.map(r => +r[1]) };
  if (!rows.length) { console.error(`${dir} has no frames: the recording never started.`); process.exit(1); }
});
const script = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : null;
const first = reels["0"], view = first.viewport;

/// The parts of the film: which steps from which reel, under which chapter.
function parts() {
  const named = (log, c) => {
    const s = script?.chapters?.[c], l = log.chapters.find(x => x.index === c);
    const title = s?.title ?? l?.title ?? "";
    return title ? { index: c, title, sub: s?.sub ?? l?.sub ?? "" } : null;
  };
  if (reelDirs.length > 1) {
    const count = script?.chapters?.length ?? Math.max(...Object.values(reels).flatMap(l => l.chapters.map(c => c.index + 1)));
    const { picks, missing } = chooseReels(Object.entries(reels).map(([id, l]) => ({ id, chapters: l.complete || {} })), count);
    if (missing.length) console.log(`  ! no finished take of chapter ${missing.map(c => c + 1).join(", ")}; left out`);
    return picks.map(({ chapter, reel }) => ({ reel, chapter: named(reels[reel], chapter), steps: reels[reel].steps.filter(s => s.chapter === chapter) }));
  }
  const log = first, out = [];
  const loose = log.steps.filter(s => s.chapter == null);
  if (loose.length) out.push({ reel: "0", chapter: null, steps: loose });
  const idx = [...new Set([...log.chapters.map(c => c.index), ...log.steps.map(s => s.chapter).filter(c => c != null)])].sort((a, b) => a - b);
  for (const c of idx) out.push({ reel: "0", chapter: named(log, c), steps: log.steps.filter(s => s.chapter === c) });
  return out;
}

const host = (() => { try { return new URL(first.url).host; } catch { return ""; } })();
const title = {
  title: titleArg || script?.title || "Walkthrough",
  persona: personaArg || script?.persona || "",
  app: appArg || script?.app || host,
  note: `Persona${first.voices?.length ? " and voice" : ""} are synthetic · recorded ${new Date(first.startedAt).toISOString().slice(0, 10)}`,
};
const tl = buildTimeline(parts(), { title });
if (!tl.steps.length) { console.error("Nothing to show: no step in these reels finished."); process.exit(1); }
const zooms = planZooms(tl, view);
const runs = captionRuns(tl);
const chapterCards = tl.pieces.filter(p => p.kind === "card" && p.card.type === "chapter");
const endCard = tl.pieces.find(p => p.kind === "card" && p.card.type === "end");
if (endCard) {
  endCard.card.title = title.title;
  endCard.card.toc = chapterCards.map(p => {
    const nums = tl.steps.filter(s => s.chapter === p.card.index && s.own).map(s => s.num);
    const span = nums.length ? `${String(Math.min(...nums)).padStart(2, "0")}–${String(Math.max(...nums)).padStart(2, "0")}` : "";
    return { at: mmss(p.out0), num: span, title: p.card.title };
  });
  endCard.card.note = `${runs.length} steps · ${mmss(tl.dur)}`;
}

// ---------- Chrome, with the reels served from a private origin ----------
const ORIGIN = "https://walk.local";
const frameUrl = (reel, t) => {
  const { ts, names } = frames[reel];
  let lo = 0, hi = ts.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return `${ORIGIN}/r/${reel}/frames/${names[k]}`;
};
const work = mkdtempSync(path.join(tmpdir(), "walk-film-"));
const { proc, port } = await launch({ chrome, profile: path.join(work, "chrome"), size: [1920, 1080], args: ["--force-device-scale-factor=1"] });
const cleanup = () => { try { proc.kill("SIGKILL"); } catch {} try { rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch {} };
process.on("exit", cleanup);
const c = await connect(port);
await c.send("Fetch.enable", { patterns: [{ urlPattern: `${ORIGIN}/*` }] });
c.on(m => {
  if (m.method !== "Fetch.requestPaused") return;
  const u = new URL(m.params.request.url);
  let f = null;
  if (u.pathname === "/compose.html") f = path.join(here, "compose.html");
  const r = /^\/r\/(\d+)\/(.+)$/.exec(u.pathname);
  if (r && reelDirs[+r[1]]) f = path.join(reelDirs[+r[1]], r[2]);
  if (!f || !existsSync(f)) return c.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 404, body: "" }).catch(() => {});
  const type = f.endsWith(".html") ? "text/html" : f.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream";
  c.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, body: readFileSync(f).toString("base64"), responseHeaders: [{ name: "Content-Type", value: type }] }).catch(() => {});
});
await c.send("Page.enable");
await c.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await c.send("Page.navigate", { url: `${ORIGIN}/compose.html` });
for (let i = 0; i < 100; i++) { if (await c.js("!!window.film").catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }
await c.js("film.ready()");
const ticks = chapterCards.map(p => p.out0 / tl.dur);
await c.js(`film.layout(${JSON.stringify({ view, box: [0, 40, 1728, 960], ticks })}) && true`);

// ---------- where each caption sits ----------
for (const run of runs) {
  const mid = (run.out0 + run.out1) / 2, f = frameAt(tl, mid), z = zoomAt(zooms, mid, view);
  const g = await c.js(`film.grid(${JSON.stringify(frameUrl(f.reel, f.src))}, 32, 18)`);
  const avoid = [];
  const rect = (x0, y0, x1, y1) => {
    const [a, b] = throughZoom([x0, y0], z), [p, q] = throughZoom([x1, y1], z);
    avoid.push({ x0: a / view[0], y0: b / view[1], x1: p / view[0], y1: q / view[1] });
  };
  for (const st of run.steps) if (st.target) rect(st.target.x, st.target.y, st.target.x + st.target.w, st.target.y + st.target.h);
  for (const t of [run.out0 + 400, mid, run.out1 - 200]) {
    const fr = frameAt(tl, t), p = fr.piece.kind === "video" ? cursorAt(reels[fr.reel].moves, fr.src) : null;
    if (p) rect(p[0] - 6, p[1] - 6, p[0] + 30, p[1] + 40);
  }
  run.band = pickBand(g, 32, 18, avoid);
}

// ---------- one frame ----------
function state(t) {
  const f = frameAt(tl, t), p = f.piece, log = reels[f.reel];
  const z = zoomAt(zooms, t, view);
  const s = { a: frameUrl(f.reel, f.src), b: f.from ? { url: frameUrl(f.from.reel, f.from.src), alpha: f.from.a } : null, cam: z, rings: [] };
  if (p.kind === "video") {
    const at = cursorAt(log.moves, f.src);
    if (at) {
      const [x, y] = throughZoom(at, z);
      let press = 1;
      for (const k of log.clicks) { const age = f.src - k.t; if (age >= -40 && age < 260) press = Math.min(press, 1 - 0.18 * Math.sin(Math.PI * clamp((age + 40) / 300, 0, 1))); }
      s.cursor = { x, y, press, alpha: clamp((f.src - log.moves[0].t0) / 300, 0, 1) };
    }
    for (const k of log.clicks) {
      const age = f.src - k.t;
      if (age < 0 || age > 600) continue;
      const [x, y] = throughZoom([k.x, k.y], z), u = age / 600;
      s.rings.push({ x, y, scale: 0.3 + 1.6 * eio(u), alpha: 0.95 * (1 - u) });
    }
  }
  const run = runs.find(r => t >= r.out0 && t < r.out1);
  if (run) s.cap = { key: `${run.num}`, num: run.num, text: run.text, band: run.band, ...captionAt(run, t) };
  if (p.kind === "card") {
    const fade = 380, a = p.out0 === 0 ? 1 : eio(clamp((t - p.out0) / fade, 0, 1)), b = p.card.type === "end" ? 1 : eio(clamp((p.out1 - t) / fade, 0, 1));
    s.card = { key: `${p.out0}`, ...p.card, alpha: Math.min(a, b), dy: (1 - a) * 18 - (1 - b) * 14 };
  }
  const st = stepAt(tl, t), ch = chapterCards.filter(q => q.out0 <= t).pop();
  s.bar = { fill: clamp(t / tl.dur, 0, 1), time: `${mmss(t)} / ${mmss(tl.dur)}`, chapter: ch ? `${ch.card.index + 1} · ${ch.card.title}` : st ? "" : title.title };
  return s;
}
const shot = async (t, format = "jpeg") => {
  await c.js(`film.show(${JSON.stringify(state(t))})`);
  const m = await c.send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 93 } : {}), clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
  return Buffer.from(m.data, "base64");
};
await shot(0); await new Promise(r => setTimeout(r, 300));

writeFileSync(out.replace(/\.mp4$/, "") + ".md", indexMd());
console.log(`${title.title}: ${mmss(tl.dur)}, ${runs.length} captioned steps, ${chapterCards.length} chapters, ${zooms.length} zoom${zooms.length === 1 ? "" : "s"}`);

if (frameMs != null) {
  const f = out.replace(/\.mp4$/, "") + `-${frameMs}.png`;
  writeFileSync(f, await shot(+frameMs, "png"));
  console.log("wrote", f); process.exit(0);
}
if (sheet) {
  const ts = [...tl.pieces.filter(p => p.kind === "card").map(p => p.out0 + Math.min(1200, (p.out1 - p.out0) / 2)), ...runs.map(r => Math.min(r.out1 - 300, r.out0 + 1400))].sort((a, b) => a - b);
  for (const [i, t] of ts.entries()) writeFileSync(path.join(work, `s${String(i).padStart(3, "0")}.jpg`), await shot(t));
  const cols = 4, rows = Math.ceil(ts.length / cols);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", path.join(work, "s%03d.jpg"), "-vf", `scale=640:-2,tile=${cols}x${rows}:padding=8:margin=8:color=0x16161b`, "-frames:v", "1", sheet]);
  console.log("wrote", sheet, `(${ts.length} frames)`); process.exit(0);
}

// ---------- picture ----------
const video = path.join(work, "picture.mp4");
const enc = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "-r", String(FPS), video], { stdio: ["pipe", "inherit", "inherit"] });
const total = Math.ceil((tl.dur / 1000) * FPS), started = Date.now();
for (let i = 0; i < total; i++) {
  const buf = await shot((i * 1000) / FPS);
  if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once("drain", r));
  if (i % (FPS * 5) === 0) process.stdout.write(`\r  frame ${i}/${total}  ${Math.round((Date.now() - started) / 1000)}s `);
}
enc.stdin.end();
await new Promise(r => enc.on("close", r));
process.stdout.write(`\r  frame ${total}/${total}  ${Math.round((Date.now() - started) / 1000)}s\n`);
c.close();

// ---------- sound ----------
const cues = silent ? [] : [...soundCues(tl, reels, { view }), ...(music ? musicCues(tl.dur) : [])];
if (!cues.length) {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-c", "copy", "-movflags", "+faststart", out]);
  console.log("wrote", out, "(silent)"); process.exit(0);
}
const SR = 48000, decoded = new Map();
async function decode(cue) {
  const src = cue.voice ? path.join(reelDirs[+cue.reel], cue.file) : DIRECTOR_SOUNDS + "/" + cue.file;
  if (!decoded.has(src)) {
    const raw = await run("ffmpeg", ["-v", "error", "-i", src, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]);
    decoded.set(src, new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4));
  }
  return decoded.get(src);
}
const len = Math.ceil((tl.dur / 1000 + 1) * SR), Lc = new Float32Array(len), Rc = new Float32Array(len);
for (const cue of cues) {
  const a = await decode(cue), at = Math.round((cue.t / 1000) * SR);
  const gl = Math.cos(((cue.pan + 1) * Math.PI) / 4) * 1.41 * cue.gain, gr = Math.sin(((cue.pan + 1) * Math.PI) / 4) * 1.41 * cue.gain;
  for (let i = 0; i < a.length && at + i < len; i++) { if (at + i >= 0) { Lc[at + i] += a[i] * gl; Rc[at + i] += a[i] * gr; } }
}
let peak = 0; for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(Lc[i]), Math.abs(Rc[i]));
const norm = peak > 0.95 ? 0.95 / peak : 1, pcm = new Float32Array(len * 2);
for (let i = 0; i < len; i++) { pcm[2 * i] = Lc[i] * norm; pcm[2 * i + 1] = Rc[i] * norm; }
const wav = path.join(work, "sound.wav");
await run("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", "-",
  "-af", "alimiter=limit=0.9,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", String(SR), wav], Buffer.from(pcm.buffer));
await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
  "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out]);
console.log("wrote", out, `(${cues.length} sounds)`);
process.exit(0);

// The index that goes beside the film: every chapter and step with its time,
// so a reviewer can say "step 07 at 1:12".
function indexMd() {
  const lines = [`# ${title.title}`, "", `${mmss(tl.dur)} · ${runs.length} steps${title.persona ? ` · ${title.persona}` : ""}`];
  let ch = null;
  for (const r of runs) {
    if (r.chapter != null && r.chapter !== ch) {
      ch = r.chapter;
      const card = chapterCards.find(p => p.card.index === ch);
      if (card) lines.push("", `## ${ch + 1}. ${card.card.title} (${mmss(card.out0)})`, "");
    }
    lines.push(`- **${String(r.num).padStart(2, "0")}** · ${mmss(r.out0)} · ${r.text}`);
  }
  return lines.join("\n") + "\n";
}
