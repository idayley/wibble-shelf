#!/usr/bin/env node
// The recorder. Drives Chrome like a calm person -- the pointer glides, typing
// has a rhythm, every captioned step holds long enough to read -- and records
// the screen and a log of everything it did. That log is what the film's
// cursor, captions, zooms and sounds are drawn from (compose.mjs).
//
//   node walk.mjs signin <profile> <url>          opens a real window; sign in, then close it
//   node walk.mjs open <reel> --url <url> [--profile p] [--mask "from=>to"]... [--viewport 1440x800] [--host h]...
//                                                 starts a recording browser and leaves it running
//   node walk.mjs do <reel> '<step json>'         one step; prints what happened and what is on screen now
//   node walk.mjs chapter <reel> '{"title":"…","sub":"…"}'
//   node walk.mjs look <reel>                     what is on screen, without doing anything
//   node walk.mjs drop <reel> <n|last>            leave a step out of the film (a wrong turn)
//   node walk.mjs close <reel>                    stops recording; writes <reel>/script.draft.json
//   node walk.mjs take <script.json> <reel> [--chapters 2,3]
//                                                 a clean take of a saved script, start to finish
//
// Steps: {"do":"click"|"type"|"press"|"select"|"check"|"hover"|"scroll"|"goto"|"wait"|"speak"|"pause", …, "say":"caption"}
// See GUIDE.md for every field.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, launch, run, sleep } from "./cdp.mjs";
import { moveMs, pointAt, readMs } from "./plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILES = path.join(homedir(), ".cache", "wibble-walkthrough", "profiles");
const profileDir = name => path.join(PROFILES, name.replace(/[^A-Za-z0-9_.-]/g, "-"));

// ---------- arguments ----------
const argv = process.argv.slice(2);
const cmd = argv.shift();
const many = name => { const out = []; for (let i; (i = argv.indexOf(name)) >= 0;) { out.push(argv[i + 1]); argv.splice(i, 2); } return out; };
const one = (name, d) => many(name).pop() ?? d;
const print = o => process.stdout.write(JSON.stringify(o, null, 2) + "\n");
const fail = (msg, code = 1) => { print({ ok: false, error: msg }); process.exit(code); };

// ---------- the recording session ----------
class Session {
  constructor({ reel, url, profile, mask = [], viewport = [1440, 800], hosts = [], chrome }) {
    Object.assign(this, { reel, url, mask, viewport, chrome });
    this.profile = profile ? profileDir(profile) : path.join(tmpdir(), `walk-${process.pid}`);
    this.hosts = new Set([hostOf(url), ...hosts].filter(Boolean));
    this.log = { version: 1, url, viewport, dpr: 2, startedAt: Date.now(), chapters: [], steps: [], moves: [], clicks: [], keys: [], voices: [] };
    this.frames = 0;
    this.lastFrame = 0;
    this.mouse = [viewport[0] / 2, viewport[1] / 2];
    this.chapter = null;
  }
  now() { return Date.now() - this.log.startedAt; }

  async start() {
    for (const d of ["frames", "look", "voice"]) mkdirSync(path.join(this.reel, d), { recursive: true });
    writeFileSync(path.join(this.reel, "frames.tsv"), "");
    const [w, h] = this.viewport;
    this.chromeProc = (await launch({ chrome: this.chrome, profile: this.profile, size: [w, h + 120], args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] })).proc;
    this.c = await connect(this.chromeProc.spawnargs.find(a => a.startsWith("--remote-debugging-port=")).split("=")[1]);
    const { send, on } = this.c;
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    const cfg = `window.__walkConfig=${JSON.stringify({ mask: this.mask })};\n`;
    await send("Page.addScriptToEvaluateOnNewDocument", { source: cfg + readFileSync(path.join(here, "page.js"), "utf8") });
    on(m => {
      if (m.method === "Page.screencastFrame") {
        const { data, sessionId, metadata } = m.params;
        const t = metadata?.timestamp ? Math.round(metadata.timestamp * 1000 - this.log.startedAt) : this.now();
        const name = String(++this.frames).padStart(6, "0") + ".jpg";
        writeFileSync(path.join(this.reel, "frames", name), Buffer.from(data, "base64"));
        appendFileSync(path.join(this.reel, "frames.tsv"), `${name}\t${t}\n`);
        this.lastFrame = this.now();
        send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      } else if (m.method === "Page.javascriptDialogOpening") {
        send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
    });
    await send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: w * 2, maxHeight: h * 2, everyNthFrame: 1 });
    if (this.url) { await send("Page.navigate", { url: this.url }); await this.settle(6000); }
    this.save();
  }

  save() { writeFileSync(path.join(this.reel, "log.json"), JSON.stringify({ ...this.log, endedAt: this.now() })); }

  /// Waits until the screen stops changing (no new frame for a moment), or
  /// `cap` ms -- some apps never stop animating.
  async settle(cap = 2500) {
    const t0 = this.now();
    await sleep(250);
    while (this.now() - t0 < cap && this.now() - this.lastFrame < 450) await sleep(60);
  }

  async moveTo([x, y]) {
    const from = [...this.mouse], d = Math.hypot(x - from[0], y - from[1]);
    if (d < 2) return;
    const m = { t0: this.now(), from, to: [x, y] };
    m.t1 = m.t0 + moveMs(d);
    this.log.moves.push(m);
    for (let t = m.t0; t < m.t1; t = this.now()) {
      const [px, py] = pointAt(m, t);
      await this.c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
      await sleep(16);
    }
    m.t1 = this.now();
    await this.c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    this.mouse = [x, y];
  }

  async press() {
    const [x, y] = this.mouse;
    this.log.clicks.push({ t: this.now(), x, y });
    await this.c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(70);
    await this.c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async key(key) {
    const K = { Enter: [13, "\r"], Tab: [9, ""], Escape: [27, ""], Backspace: [8, ""], ArrowDown: [40, ""], ArrowUp: [38, ""], ArrowLeft: [37, ""], ArrowRight: [39, ""], Space: [32, " "] };
    const [code, text] = K[key] || [0, key];
    const p = { key: key === "Space" ? " " : key, code: key.length === 1 ? undefined : key, windowsVirtualKeyCode: code };
    await this.c.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...p, text: text || undefined });
    await this.c.send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
    this.log.keys.push({ t: this.now() });
  }

  async typeText(text) {
    for (const ch of text) {
      if (ch === "\n") { await this.key("Enter"); continue; }
      await this.c.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
      await this.c.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      this.log.keys.push({ t: this.now() });
      await sleep(42 + Math.random() * 46 + (ch === " " ? 30 : 0));
    }
  }

  async find(target) {
    if (!target) throw new Error("this step needs a target");
    const r = await this.c.js(`window.__walk ? window.__walk.find(${JSON.stringify(target)}) : {error: "the page is still loading"}`);
    if (r.error) throw new Error(r.error);
    return r;
  }

  async voice(line, voiceName = "Samantha") {
    const n = this.log.voices.length + 1;
    const aiff = path.join(this.reel, "voice", `${n}.aiff`), wav = path.join(this.reel, "voice", `${n}.wav`);
    await run("say", ["-v", voiceName, "-o", aiff, line]).catch(() => run("say", ["-o", aiff, line]));
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-ac", "1", "-ar", "48000", wav]);
    rmSync(aiff, { force: true });
    const t = this.now();
    const dur = await this.c.js(`window.__walk.speak(${JSON.stringify(readFileSync(wav).toString("base64"))})`);
    this.log.voices.push({ t, file: `voice/${n}.wav`, dur: Math.round(dur * 1000) });
    await sleep(dur * 1000 + 350);
  }

  /// One step, paced like a person. Returns the logged step.
  async step(s) {
    const st = { n: this.log.steps.length + 1, do: s.do, say: s.say || null, chapter: this.chapter, t0: this.now(), ok: false, spec: s };
    this.log.steps.push(st);
    const aim = async () => {
      const f = await this.find(s.target);
      st.target = f.rect; st.el = f.el;
      await this.moveTo([f.rect.x + f.rect.w / 2, f.rect.y + Math.min(f.rect.h / 2, 18)]);
      return f;
    };
    try {
      const urlBefore = await this.c.js("location.href");
      switch (s.do) {
        case "goto": await this.c.send("Page.navigate", { url: new URL(s.url, urlBefore).href }); break;
        case "click": case "check": await aim(); await sleep(120); await this.press(); break;
        case "hover": await aim(); break;
        case "type": {
          await aim(); await sleep(100); await this.press(); await sleep(180);
          if (s.clear !== false) {
            await this.c.js("(() => { const e = document.activeElement; if (e && 'value' in e) { e.select?.(); } })()");
            await this.key("Backspace");
          }
          await this.typeText(String(s.text ?? ""));
          if (s.enter) { await sleep(200); await this.key("Enter"); }
          break;
        }
        case "press": await this.key(s.key); break;
        case "select": {
          await aim(); await sleep(120); await this.press(); await sleep(350);
          const ok = await this.c.js(`(() => { const e = window.__walk.last(); if (!e || e.tagName !== "SELECT") return false;
            const want = ${JSON.stringify(String(s.option ?? "").toLowerCase())};
            const o = [...e.options].find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) || [...e.options].find(o => o.text.toLowerCase().includes(want));
            if (!o) return false; e.value = o.value; e.dispatchEvent(new Event("input", {bubbles:true})); e.dispatchEvent(new Event("change", {bubbles:true})); e.blur(); return true; })()`);
          if (!ok) throw new Error(`no option "${s.option}" in that list`);
          break;
        }
        case "scroll":
          if (s.target) await this.find(s.target);
          else await this.c.js(`window.scrollBy({ top: ${+s.by || 600}, behavior: "smooth" })`);
          await sleep(700);
          break;
        case "wait": {
          const until = this.now() + (s.timeout || 15000);
          if (s.ms) { await sleep(s.ms); break; }
          for (;;) {
            const r = await this.c.js(`window.__walk ? window.__walk.find(${JSON.stringify(s.for)}, {scroll:false}) : {error:"loading"}`).catch(e => ({ error: e.message }));
            if (!r.error) break;
            if (this.now() > until) throw new Error(`waited ${(s.timeout || 15000) / 1000}s and ${JSON.stringify(s.for)} never appeared`);
            await sleep(250);
          }
          break;
        }
        case "speak": await this.voice(String(s.line || ""), s.voice); break;
        case "pause": await sleep(+s.ms || 800); break;
        default: throw new Error(`unknown step "${s.do}"`);
      }
      st.tSettle0 = this.now();
      await this.settle(s.do === "goto" || s.settle === "long" ? 6000 : 2500);
      st.tSettle1 = this.now();
      const urlAfter = await this.c.js("location.href").catch(() => urlBefore);
      st.url = urlAfter;
      st.nav = urlAfter !== urlBefore;
      const h = hostOf(urlAfter);
      if (h && !this.hosts.has(h) && !urlAfter.startsWith("file:")) {
        await this.c.send("Page.navigate", { url: urlBefore }); await this.settle(6000);
        throw new Error(`that went to ${h}, outside the app, so I went back. Add --host ${h} if it belongs.`);
      }
      const hold = st.t0 + readMs(st.say) - this.now();
      if (hold > 0) await sleep(hold);
      st.ok = true;
    } catch (e) {
      st.error = e.message;
      st.tSettle0 ??= this.now(); st.tSettle1 ??= this.now();
    }
    st.t1 = this.now();
    this.save();
    return st;
  }

  async addChapter({ title, sub, index }) {
    const ch = { index: index ?? this.log.chapters.length, title, sub: sub || "", t: this.now() };
    this.log.chapters.push(ch);
    this.chapter = ch.index;
    this.save();
    return ch;
  }

  async look(name) {
    const file = path.join("look", `${name}.png`);
    const shot = await this.c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: this.viewport[0], height: this.viewport[1], scale: 0.5 } });
    writeFileSync(path.join(this.reel, file), Buffer.from(shot.data, "base64"));
    const outline = await this.c.js("window.__walk ? window.__walk.outline() : {url: location.href, note: 'still loading'}").catch(e => ({ error: e.message }));
    return { look: path.join(this.reel, file), outline };
  }

  async close() {
    try { await this.c.send("Page.stopScreencast"); } catch {}
    await sleep(200);
    const done = {};
    for (const ch of this.log.chapters) {
      const steps = this.log.steps.filter(s => s.chapter === ch.index && !s.dropped);
      done[ch.index] = steps.length > 0 && steps.every(s => s.ok);
    }
    this.log.complete = done;
    this.save();
    // A draft script from what worked: the rehearsal's clean path.
    const keep = s => s.ok && !s.dropped;
    const chapters = this.log.chapters.map(ch => ({ title: ch.title, sub: ch.sub, steps: this.log.steps.filter(s => s.chapter === ch.index && keep(s)).map(s => s.spec) }));
    const loose = this.log.steps.filter(s => s.chapter == null && keep(s)).map(s => s.spec);
    if (loose.length) chapters.unshift({ title: "", sub: "", steps: loose });
    writeFileSync(path.join(this.reel, "script.draft.json"), JSON.stringify({ url: this.url, viewport: this.viewport, mask: this.mask, chapters }, null, 2));
    try { this.c.close(); } catch {}
    this.chromeProc.kill("SIGTERM");
    await sleep(400);
    try { this.chromeProc.kill("SIGKILL"); } catch {}
    if (this.profile.startsWith(tmpdir())) rmSync(this.profile, { recursive: true, force: true });
  }
}

function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }
const parseMask = list => list.map(m => { const [from, to] = m.split("=>"); return { from: from.trim(), to: (to ?? "Test user").trim() }; });
const parseView = v => (v || "1440x800").split("x").map(Number);

// ---------- the daemon: one browser kept running between commands ----------
async function daemon(reel, opts) {
  const s = new Session({ reel, ...opts });
  await s.start();
  let busy = Promise.resolve();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      busy = busy.then(async () => {
        let out;
        try {
          const arg = body ? JSON.parse(body) : {};
          if (req.url === "/do") {
            const st = await s.step(arg);
            out = { ok: st.ok, n: st.n, error: st.error, target: st.el, ...(await s.look(String(st.n).padStart(3, "0"))) };
          } else if (req.url === "/chapter") out = { ok: true, chapter: await s.addChapter(arg) };
          else if (req.url === "/look") out = { ok: true, ...(await s.look(`now-${Date.now()}`)) };
          else if (req.url === "/drop") {
            const st = arg.n === "last" ? s.log.steps.filter(x => !x.dropped).pop() : s.log.steps.find(x => x.n === +arg.n);
            if (st) { st.dropped = true; s.save(); }
            out = st ? { ok: true, dropped: st.n, was: st.spec } : { ok: false, error: `no step ${arg.n}` };
          } else if (req.url === "/close") {
            await s.close();
            out = { ok: true, reel, draft: path.join(reel, "script.draft.json"), steps: s.log.steps.length };
            res.end(JSON.stringify(out));
            server.close(); rmSync(path.join(reel, "daemon.json"), { force: true });
            setTimeout(() => process.exit(0), 100);
            return;
          } else out = { ok: false, error: "unknown command" };
        } catch (e) { out = { ok: false, error: e.message }; }
        res.end(JSON.stringify(out));
      });
    });
  });
  server.listen(0, "127.0.0.1", () => writeFileSync(path.join(reel, "daemon.json"), JSON.stringify({ port: server.address().port, pid: process.pid })));
}

async function call(reel, route, body) {
  const f = path.join(reel, "daemon.json");
  if (!existsSync(f)) fail(`no recording browser is open for ${reel}. Start one with: node walk.mjs open ${reel} --url …`);
  const { port } = JSON.parse(readFileSync(f, "utf8"));
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", body: body ? JSON.stringify(body) : "" }).catch(() => null);
  if (!r) fail("the recording browser is not answering. Close it (node walk.mjs close) and open it again.");
  const out = await r.json();
  print(out);
  process.exit(out.ok ? 0 : 3);
}

// ---------- commands ----------
const reelArg = () => { const r = argv.shift(); if (!r) fail("which reel? Give its folder."); return path.resolve(r); };

if (cmd === "signin") {
  const [profile, url] = argv;
  if (!profile || !url) fail("usage: node walk.mjs signin <profile> <url>");
  mkdirSync(profileDir(profile), { recursive: true });
  const { proc } = await launch({ profile: profileDir(profile), headless: false, size: [1280, 900] });
  const c = await connect(proc.spawnargs.find(a => a.startsWith("--remote-debugging-port=")).split("=")[1]);
  await c.send("Page.navigate", { url });
  c.close();
  console.error("A Chrome window is open. Sign in there with a test account, then close the window.");
  await new Promise(r => proc.on("close", r));
  print({ ok: true, profile, saved: profileDir(profile) });
} else if (cmd === "open") {
  const reel = reelArg();
  const opts = { url: one("--url"), profile: one("--profile"), mask: parseMask(many("--mask")), viewport: parseView(one("--viewport")), hosts: many("--host"), chrome: one("--chrome") };
  if (!opts.url) fail("open needs --url");
  if (existsSync(path.join(reel, "daemon.json"))) fail(`a recording browser is already open for ${reel}. Close it first.`);
  mkdirSync(reel, { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "_daemon", reel, JSON.stringify(opts)], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  child.unref();
  for (let i = 0; i < 200 && !existsSync(path.join(reel, "daemon.json")); i++) await sleep(100);
  if (!existsSync(path.join(reel, "daemon.json"))) fail("the recording browser did not start. If you signed in to this profile, make sure that Chrome window is closed.");
  await call(reel, "/look");
} else if (cmd === "_daemon") {
  const [reel, opts] = argv;
  await daemon(reel, JSON.parse(opts));
} else if (cmd === "do") {
  const reel = reelArg();
  let step; try { step = JSON.parse(argv.join(" ")); } catch { fail("the step must be JSON, e.g. '{\"do\":\"click\",\"target\":{\"text\":\"Sign up\"},\"say\":\"She signs up.\"}'"); }
  await call(reel, "/do", step);
} else if (cmd === "chapter") {
  const reel = reelArg();
  await call(reel, "/chapter", JSON.parse(argv.join(" ")));
} else if (cmd === "look") await call(reelArg(), "/look");
else if (cmd === "drop") { const reel = reelArg(); await call(reel, "/drop", { n: argv[0] === "last" ? "last" : +argv[0] }); }
else if (cmd === "close") await call(reelArg(), "/close");
else if (cmd === "take") {
  const scriptPath = argv.shift(), reel = path.resolve(argv.shift() || "");
  if (!scriptPath || !argv) fail("usage: node walk.mjs take <script.json> <reel> [--chapters 1,2]");
  const only = one("--chapters");
  const script = JSON.parse(readFileSync(scriptPath, "utf8"));
  const pick = only ? only.split(",").map(n => +n - 1) : script.chapters.map((_, i) => i);
  const first = script.chapters[pick[0]];
  const s = new Session({ reel, url: (only && first?.start) || script.url, profile: script.profile, mask: script.mask || [], viewport: script.viewport || [1440, 800], hosts: script.hosts || [], chrome: one("--chrome") });
  mkdirSync(reel, { recursive: true });
  await s.start();
  let failed = null;
  for (const ci of pick) {
    const ch = script.chapters[ci];
    if (ch.title) await s.addChapter({ title: ch.title, sub: ch.sub, index: ci });
    else s.chapter = ci;
    for (const [k, spec] of ch.steps.entries()) {
      const st = await s.step(spec);
      if (!st.ok) { failed = { chapter: ci + 1, step: k + 1, n: st.n, error: st.error, ...(await s.look(`failed-${st.n}`)) }; break; }
    }
    if (failed) break;
  }
  await s.close();
  print(failed ? { ok: false, reel, failed } : { ok: true, reel, steps: s.log.steps.length, seconds: Math.round(s.now() / 1000) });
  process.exit(failed ? 3 : 0);
} else {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}
