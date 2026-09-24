// Renders a Director film to MP4, frame by frame, through headless Chrome.
// Every frame is drawn from the film's own clock, so nothing drops and every
// take is identical. The soundtrack is mixed here from the cue sheet the page
// exports, so each sound lands on the frame of the motion that made it.
//
//   node render.mjs film.html [out.mp4]         the film, with sound
//   node render.mjs film.html --sheet out.png   a contact sheet: two frames per beat, to review
//   node render.mjs film.html --frame 4200      one frame, to look at closely (film-4200.png)
//   node render.mjs film.html --lint            the film's own checks, and nothing else
//
// Options: --fps 30 (or 60), --silent, --chrome <path>.
// Needs Node 22+, ffmpeg, and Google Chrome or Chromium. Run from a clone of
// the kit, the kit's files are served from that clone instead of the CDN.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); if (i < 0) return fallback; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bool = name => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const FPS = +flag("--fps", 30), sheet = flag("--sheet"), frameAt = flag("--frame"), chromeArg = flag("--chrome");
const lintOnly = bool("--lint"), silent = bool("--silent");
const [page, outArg] = argv;
if (!page) { console.error("usage: node render.mjs film.html [out.mp4] [--sheet out.png | --frame ms | --lint]"); process.exit(2); }
const out = outArg || page.replace(/\.html?$/, "") + ".mp4";
const here = path.dirname(fileURLToPath(import.meta.url));
const localKit = existsSync(path.join(here, "motion.js")) ? here : null;

const work = mkdtempSync(path.join(tmpdir(), "director-"));
const run = (cmd, args, input) => new Promise((ok, no) => {
  const p = spawn(cmd, args, { stdio: [input ? "pipe" : "ignore", "pipe", "inherit"] });
  const chunks = []; p.stdout.on("data", c => chunks.push(c));
  p.on("error", no); p.on("close", c => (c ? no(new Error(`${cmd} exited ${c}`)) : ok(Buffer.concat(chunks))));
  if (input) { p.stdin.on("error", () => {}); p.stdin.end(input); }
});
const chromePath = chromeArg || process.env.CHROME || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
if (!chromePath) { console.error("Could not find Chrome. Pass --chrome <path> or set CHROME."); process.exit(1); }

// ---------- Chrome over the DevTools protocol ----------
const PORT = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${PORT}`, "--hide-scrollbars", "--force-device-scale-factor=1",
  "--autoplay-policy=no-user-gesture-required", "--mute-audio", `--user-data-dir=${path.join(work, "chrome")}`, "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch {} try { rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch {} };
process.on("exit", cleanup);
let targets;
for (let i = 0; i < 75 && !targets; i++) {
  await new Promise(r => setTimeout(r, 200));
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch {}
}
if (!targets) { console.error("Chrome did not start."); process.exit(1); }
const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let nextId = 0; const pending = new Map(), handlers = [];
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) handlers.forEach(h => h(m));
});
const send = (method, params = {}) => new Promise(r => { const i = ++nextId; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async expr => {
  const m = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  const r = m.result;
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};

// From a clone of the kit, answer the kit's requests from disk: what you
// render is what you have, before it is ever published.
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".m4a": "audio/mp4", ".png": "image/png" };
const kitPath = url => { const m = /\/items\/director\/kit\/([^?#]+)/.exec(url); return localKit && m ? path.join(localKit, m[1]) : null; };
if (localKit) {
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://*/items/director/kit/*" }] });
  handlers.push(async m => {
    if (m.method !== "Fetch.requestPaused") return;
    const f = kitPath(m.params.request.url);
    if (!f || !existsSync(f)) return send("Fetch.continueRequest", { requestId: m.params.requestId });
    send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, body: readFileSync(f).toString("base64"),
      responseHeaders: [{ name: "Content-Type", value: TYPES[path.extname(f)] || "application/octet-stream" }, { name: "Access-Control-Allow-Origin", value: "*" }] });
  });
}
const errors = [];
await send("Runtime.enable");
handlers.push(m => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map(a => a.value ?? a.description).join(" "));
});
await send("Page.enable");
await send("Page.navigate", { url: "file://" + path.resolve(page) + "?render" });
let info;
for (let i = 0; i < 100 && !info; i++) {
  await new Promise(r => setTimeout(r, 150));
  try { info = await js("window.Motion ? Motion.ready.then(() => Motion.info()) : null"); } catch (e) { errors.push(String(e.message)); break; }
}
if (!info) {
  const why = await js("typeof Motion === 'undefined' ? 'motion.js never loaded (check the script src and the kit ref)' : 'Motion loaded but never became ready'").catch(e => e.message);
  console.error(`The film did not load: ${why}.\n` + errors.join("\n")); process.exit(1);
}
if (errors.length) { console.error("The page threw:\n" + errors.join("\n")); process.exit(1); }

const warnings = await js("Motion.lint()");
console.log(`${info.title || "film"}: ${info.w}×${info.h}, ${(info.end / 1000).toFixed(1)}s, ${info.scenes.length} scenes`);
for (const w of warnings) console.log("  ! " + w);
if (!warnings.length) console.log("  lint: clean");
if (lintOnly) process.exit(0);

await send("Emulation.setDeviceMetricsOverride", { width: info.w, height: info.h, deviceScaleFactor: 1, mobile: false });
await js("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
const shot = async (t, format = "png") => {
  await js(`Motion.seek(${t}); true`);
  const m = await send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 95 } : {}), clip: { x: 0, y: 0, width: info.w, height: info.h, scale: 1 } });
  return Buffer.from(m.result.data, "base64");
};
await shot(0); await new Promise(r => setTimeout(r, 400)); // let the masks decode once

if (frameAt != null) {
  const f = page.replace(/\.html?$/, "") + `-${frameAt}.png`;
  writeFileSync(f, await shot(+frameAt));
  console.log("wrote", f); process.exit(0);
}

if (sheet) {
  // Two frames per beat -- just after it starts and late in it -- stamped with the time.
  const ts = [];
  info.beats.forEach((b, i) => {
    const next = info.beats[i + 1]?.t ?? info.end;
    ts.push([b.t + Math.min(500, (next - b.t) * 0.2), b.name], [b.t + (next - b.t) * 0.75, b.name]);
  });
  ts.push([info.end, "end"]);
  const cols = 4, cell = 480, rows = Math.ceil(ts.length / cols);
  for (const [i, [t, name]] of ts.entries()) {
    await js(`Motion.stamp(${JSON.stringify(`${(t / 1000).toFixed(1)}s · ${name}`)}); true`);
    writeFileSync(path.join(work, `s${String(i).padStart(3, "0")}.png`), await shot(Math.round(t)));
  }
  await js("Motion.stamp(null); true");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", path.join(work, "s%03d.png"),
    "-vf", `scale=${cell}:-2,tile=${cols}x${rows}:padding=10:margin=10:color=0x16161b`, "-frames:v", "1", sheet]);
  console.log("wrote", sheet, `(${ts.length} frames)`); process.exit(0);
}

// ---------- picture ----------
const video = path.join(work, "picture.mp4");
const enc = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", "-r", String(FPS), video], { stdio: ["pipe", "inherit", "inherit"] });
const total = Math.round(((info.end + info.hold) / 1000) * FPS);
const started = Date.now();
for (let f = 0; f < total; f++) {
  const buf = await shot(Math.min(info.end, (f * 1000) / FPS), "jpeg");
  if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once("drain", r));
  if (f % (FPS * 5) === 0) process.stdout.write(`\r  frame ${f}/${total}  ${Math.round((Date.now() - started) / 1000)}s `);
}
enc.stdin.end();
await new Promise(r => enc.on("close", r));
process.stdout.write(`\r  frame ${total}/${total}  ${Math.round((Date.now() - started) / 1000)}s\n`);

// ---------- sound ----------
const cues = silent ? [] : await js("Motion.sounds()");
ws.close();
if (!cues.length) {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-c", "copy", "-movflags", "+faststart", out]);
  console.log("wrote", out, "(silent)"); process.exit(0);
}
const SR = 48000, decoded = new Map();
async function decode(file) {
  if (!decoded.has(file)) {
    const src = localKit ? path.join(localKit, "sounds", file) : info.kit + "sounds/" + file;
    const raw = await run("ffmpeg", ["-v", "error", "-i", src, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]);
    decoded.set(file, new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4));
  }
  return decoded.get(file);
}
const len = Math.ceil(((info.end + info.hold) / 1000 + 1.5) * SR);
const L = new Float32Array(len), R = new Float32Array(len);
for (const c of cues) {
  const a = await decode(c.file), at = Math.round((c.t / 1000) * SR);
  const gl = Math.cos(((c.pan + 1) * Math.PI) / 4) * 1.41 * c.gain, gr = Math.sin(((c.pan + 1) * Math.PI) / 4) * 1.41 * c.gain;
  const n = Math.floor((a.length - 1) / c.rate);
  for (let i = 0; i < n && at + i < len; i++) {
    const p = i * c.rate, k = Math.floor(p), v = a[k] + (a[k + 1] - a[k]) * (p - k);
    L[at + i] += v * gl; R[at + i] += v * gr;
  }
}
let peak = 0; for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = peak > 0.95 ? 0.95 / peak : 1, pcm = new Float32Array(len * 2);
for (let i = 0; i < len; i++) { pcm[2 * i] = L[i] * norm; pcm[2 * i + 1] = R[i] * norm; }
const wav = path.join(work, "sound.wav");
await run("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", "-",
  "-af", "alimiter=limit=0.9,loudnorm=I=-14:TP=-1.5:LRA=9", "-ar", String(SR), wav], Buffer.from(pcm.buffer));
await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
  "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
console.log("wrote", out, `(${cues.length} sounds)`);
process.exit(0);
