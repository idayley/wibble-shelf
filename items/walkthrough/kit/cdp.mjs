// Chrome over the DevTools protocol, with nothing to install: Node 22's own
// WebSocket and fetch. Shared by walk.mjs (the recorder) and compose.mjs
// (the film), the same way Director's render.mjs talks to Chrome.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
];

export function findChrome(given) {
  const p = given || process.env.CHROME || CHROMES.find(existsSync);
  if (!p) throw new Error("Could not find Chrome. Pass --chrome <path> or set CHROME.");
  return p;
}

/// Starts Chrome and returns { proc, port }. `headless: false` opens a real
/// window (the one-time sign-in).
export async function launch({ chrome, profile, headless = true, size = [1280, 800], args = [] }) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const flags = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", `--window-size=${size[0]},${size[1]}`, ...args,
  ];
  if (headless) flags.unshift("--headless=new", "--mute-audio");
  const proc = spawn(findChrome(chrome), [...flags, "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return { proc, port }; } catch {}
  }
  proc.kill("SIGKILL");
  throw new Error("Chrome did not start. Is another Chrome using this profile? Close it and try again.");
}

/// Connects to the first page target. Returns { send, on, js, close }.
export async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.addEventListener("open", ok); ws.addEventListener("error", no); });
  let id = 0;
  const pending = new Map(), handlers = new Set();
  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const h of handlers) h(m);
  });
  const send = (method, params = {}) => new Promise((ok, no) => {
    const i = ++id;
    pending.set(i, m => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const js = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const on = h => { handlers.add(h); return () => handlers.delete(h); };
  return { send, on, js, close: () => ws.close() };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Runs a command, resolving with its stdout. Rejects on a non-zero exit.
export function run(cmd, args, input) {
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out = [], err = [];
    p.stdout.on("data", c => out.push(c));
    p.stderr.on("data", c => err.push(c));
    p.on("error", no);
    p.on("close", c => (c ? no(new Error(`${cmd} exited ${c}: ${Buffer.concat(err).toString().slice(-400)}`)) : ok(Buffer.concat(out))));
    if (input) { p.stdin.on("error", () => {}); p.stdin.end(input); }
  });
}
