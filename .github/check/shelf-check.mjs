import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BALL_R = 10;
const DOM_W = 11;
const DOM_H = 38;
const SAW_L = 96;
const TRAY_W = 66;
const TRAY_SPAN = 150;
const ROPE = 104;
function hangingIn(a) {
  const out = /* @__PURE__ */ new Set();
  for (const link of a.links ?? []) {
    if (link.kind === "hinge") continue;
    out.add(link.a);
    out.add(link.b);
  }
  return out;
}
const SHAPES = ["bar", "disc", "ring", "box"];
const HOLDS = ["fixed", "pin", "loose"];
function reach(p) {
  if (p.shape === "bar") {
    const half = (p.thick ?? 6) / 2;
    return {
      l: Math.min(p.x, p.x + (p.dx ?? 0)) - half,
      r: Math.max(p.x, p.x + (p.dx ?? 0)) + half,
      t: Math.min(p.y, p.y + (p.dy ?? 0)) - half,
      b: Math.max(p.y, p.y + (p.dy ?? 0)) + half
    };
  }
  if (p.shape === "box") {
    const w = (p.w ?? 30) / 2;
    const h = (p.h ?? 30) / 2;
    return { l: p.x - w, r: p.x + w, t: p.y - h, b: p.y + h };
  }
  const r = p.r ?? BALL_R;
  return { l: p.x - r, r: p.x + r, t: p.y - r, b: p.y + r };
}
function groundOf(s) {
  const hung = hangingIn(s);
  let lo = -1e9;
  for (const [i, p] of s.parts.entries()) {
    if (p.hold === "pin" || hung.has(i)) continue;
    lo = Math.max(lo, reach(p).b);
  }
  return lo === -1e9 ? 0 : lo;
}
function heightOf(s) {
  let lo = 1e9;
  let hi = -1e9;
  for (const p of s.parts) {
    const q = reach(p);
    lo = Math.min(lo, q.t);
    hi = Math.max(hi, q.b);
  }
  return hi <= lo ? 0 : hi - lo;
}
function normalise(s) {
  let lo = 1e9;
  let hi = -1e9;
  for (const p of s.parts) {
    const q = reach(p);
    lo = Math.min(lo, q.l);
    hi = Math.max(hi, q.r);
  }
  const g = groundOf(s);
  for (const p of s.parts) {
    p.x -= lo;
    p.y -= g;
  }
  s.w = Math.max(40, Math.round(hi - lo));
  return s;
}
const MAX_PARTS = 14;
const MAX_OFFSET = 600;
const MIN_PLANK = 44;
const MAX_PLANK = 460;
const MIN_R = 6;
const MAX_R = 190;
const MAX_W = 460;
const MAX_H = 360;
const MAX_SPIN = 6;
const MAX_TORQUE = 400;
const MAX_THROW = 2200;
function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function isShape(v) {
  return typeof v === "string" && SHAPES.includes(v);
}
function isHold(v) {
  return typeof v === "string" && HOLDS.includes(v);
}
const SIX = {
  slide: (p) => [
    { shape: "bar", hold: "fixed", x: 0, y: 0, dx: num(p.dx, 170), dy: num(p.dy, 112), grip: 0.12 }
  ],
  board: (p) => [
    { shape: "bar", hold: "fixed", x: 0, y: 0, dx: num(p.dx, 78), dy: num(p.dy, 0), bounce: 0.92 }
  ],
  ball: () => [{ shape: "disc", x: BALL_R, y: BALL_R, r: BALL_R, heavy: 2.4, grip: 0.5 }],
  domino: () => [{ shape: "box", x: DOM_W / 2, y: -DOM_H / 2, w: DOM_W, h: DOM_H, grip: 0.6 }],
  seesaw: (p) => {
    const len = clamp(num(p.len, SAW_L), 46, 190);
    return [
      {
        shape: "bar",
        hold: "pin",
        x: -len,
        y: 0,
        dx: len * 2,
        dy: 0,
        thick: 9,
        grip: 0.5,
        spinDrag: 1.4
      }
    ];
  },
  pulley: (p) => {
    const span = clamp(num(p.dx, TRAY_SPAN), 60, 420);
    return [
      { shape: "disc", hold: "pin", x: 0, y: 0, r: 9 },
      { shape: "disc", hold: "pin", x: span, y: num(p.dy, 0), r: 9 },
      { shape: "box", x: 0, y: ROPE, w: TRAY_W, h: 7, grip: 0.7 },
      { shape: "box", x: span, y: num(p.dy, 0) + ROPE, w: TRAY_W, h: 7, grip: 0.7 }
    ];
  }
};
const SIX_LINKS = {
  // No `length`: a pulley's line is measured off where its parts are.
  pulley: [{ a: 2, b: 3, kind: "pulley", over: [0, 1] }]
};
function readPart(p) {
  if (!isShape(p.shape)) return null;
  const out = {
    shape: p.shape,
    x: Math.round(clamp(num(p.x, 0), -MAX_OFFSET, MAX_OFFSET)),
    y: Math.round(clamp(num(p.y, 0), -MAX_OFFSET, MAX_OFFSET)),
    hold: isHold(p.hold) ? p.hold : "loose"
  };
  if (p.angle !== void 0) out.angle = clamp(num(p.angle, 0), -Math.PI * 2, Math.PI * 2);
  if (p.shape === "bar") {
    let dx = clamp(num(p.dx, 0), -MAX_PLANK, MAX_PLANK);
    let dy = clamp(num(p.dy, 0), -MAX_PLANK, MAX_PLANK);
    const d = Math.hypot(dx, dy);
    if (d < MIN_PLANK) {
      const k = d < 0.01 ? 0 : MIN_PLANK / d;
      dx = d < 0.01 ? MIN_PLANK : dx * k;
      dy = d < 0.01 ? 0 : dy * k;
    }
    out.dx = Math.round(dx);
    out.dy = Math.round(dy);
    out.thick = Math.round(clamp(num(p.thick, 6), 3, 30));
  } else if (p.shape === "box") {
    out.w = Math.round(clamp(num(p.w, 30), 4, MAX_W));
    out.h = Math.round(clamp(num(p.h, 30), 4, MAX_H));
  } else {
    out.r = Math.round(clamp(num(p.r, 30), MIN_R, MAX_R));
    if (p.shape === "ring") out.wall = Math.round(clamp(num(p.wall, 6), 3, 24));
  }
  if (p.shape === "bar" && p.pivot !== void 0) out.pivot = clamp(num(p.pivot, 0), 0, 1);
  if (out.hold === "pin" && p.swing !== void 0) {
    out.swing = clamp(num(p.swing, 0), 0, Math.PI);
  }
  if (p.bounce !== void 0) out.bounce = clamp(num(p.bounce, 0), 0, 0.95);
  if (p.throw !== void 0) out.throw = Math.round(clamp(num(p.throw, 0), 0, MAX_THROW));
  if (p.grip !== void 0) out.grip = clamp(num(p.grip, 0.4), 0, 1);
  if (p.heavy !== void 0) out.heavy = clamp(num(p.heavy, 1), 0.1, 8);
  if (out.hold === "pin" && p.spin !== void 0) {
    out.spin = clamp(num(p.spin, 0), -MAX_SPIN, MAX_SPIN);
    out.torque = clamp(num(p.torque, 60), 1, MAX_TORQUE);
  }
  if (p.drag !== void 0) out.drag = clamp(num(p.drag, 0.18), 0, 4);
  if (p.spinDrag !== void 0) out.spinDrag = clamp(num(p.spinDrag, 0.5), 0, 6);
  return out;
}
function readLinks(raw, parts) {
  if (!Array.isArray(raw)) return void 0;
  const out = [];
  for (const item of raw.slice(0, MAX_PARTS)) {
    if (!item || typeof item !== "object") continue;
    const l = item;
    const kind = l.kind;
    if (kind !== "rope" && kind !== "hinge" && kind !== "pulley") continue;
    const a = Math.round(num(l.a, -1));
    const b = Math.round(num(l.b, -1));
    if (a < 0 || b < 0 || a >= parts || b >= parts || a === b) continue;
    const link = { a, b, kind };
    if (l.length !== void 0) link.length = Math.round(clamp(num(l.length, 100), 8, 600));
    if (kind === "pulley") {
      const over = Array.isArray(l.over) ? l.over.map((v) => Math.round(num(v, -1))) : [];
      if (over.length !== 2 || over.some((v) => v < 0 || v >= parts)) continue;
      link.over = [over[0], over[1]];
    }
    out.push(link);
  }
  return out.length ? out : void 0;
}
function parseSpec(raw, fallbackName) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  const rawParts = Array.isArray(r.parts) ? r.parts : null;
  if (!rawParts) return null;
  const parts = [];
  let legacyLinks;
  for (const item of rawParts.slice(0, MAX_PARTS)) {
    if (!item || typeof item !== "object") continue;
    const p = item;
    if (typeof p.k === "string" && SIX[p.k]) {
      const base2 = parts.length;
      for (const made of SIX[p.k](p)) {
        parts.push({ ...made, x: made.x + num(p.x, 0), y: made.y + num(p.y, 0) });
      }
      const links2 = SIX_LINKS[p.k];
      if (links2) {
        legacyLinks = [
          ...legacyLinks ?? [],
          ...links2.map((l) => ({
            ...l,
            a: l.a + base2,
            b: l.b + base2,
            over: l.over ? [l.over[0] + base2, l.over[1] + base2] : void 0
          }))
        ];
      }
      continue;
    }
    const part = readPart(p);
    if (part) parts.push(part);
  }
  if (!parts.length) return null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : fallbackName;
  const note = typeof r.note === "string" ? r.note.trim().slice(0, 160) : "";
  const links = readLinks(r.links, parts.length) ?? legacyLinks;
  const spec = normalise({ name, note, w: 0, parts, links });
  const h = heightOf(spec);
  const over = Math.max(spec.w / MAX_W, h / MAX_H);
  if (over > 1) scaleSpec(spec, 0.99 / over);
  return spec;
}
function scaleSpec(s, k) {
  for (const p of s.parts) {
    p.x = Math.round(p.x * k);
    p.y = Math.round(p.y * k);
    if (p.dx !== void 0) p.dx = Math.round(p.dx * k);
    if (p.dy !== void 0) p.dy = Math.round(p.dy * k);
    if (p.r !== void 0) p.r = Math.round(clamp(p.r * k, MIN_R, MAX_R));
    if (p.w !== void 0) p.w = Math.round(clamp(p.w * k, 4, MAX_W));
    if (p.h !== void 0) p.h = Math.round(clamp(p.h * k, 4, MAX_H));
  }
  for (const l of s.links ?? []) {
    if (l.length !== void 0) l.length = Math.round(l.length * k);
  }
  return normalise(s);
}
const CAPABILITIES = [
  "stream.read",
  "panel.render",
  "pin.create",
  "command.run",
  "protocols.list",
  "foley.play",
  "storage"
];
const SLOTS = ["sidebar", "rail", "top"];
const API = 1;
const PIN_CAPABILITIES = ["pin.create", "storage"];
function parseManifest(raw, folderName) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: "malformed",
      message: "Not valid JSON"
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "malformed",
      message: "Manifest must be an object"
    };
  }
  const obj = parsed;
  const requiredFields = ["id", "name", "description", "version", "author", "main"];
  for (const field of requiredFields) {
    if (typeof obj[field] !== "string") {
      return {
        ok: false,
        reason: "field",
        message: `Missing or not a string: ${field}`
      };
    }
  }
  const id = obj.id;
  const name = obj.name;
  const description = obj.description;
  const version = obj.version;
  const author = obj.author;
  const main = obj.main;
  if (!/^[a-z0-9-]{1,48}$/.test(id)) {
    return {
      ok: false,
      reason: "field",
      message: `id must match [a-z0-9-]{1,48}, got: ${id}`
    };
  }
  if (id !== folderName) {
    return {
      ok: false,
      reason: "id-mismatch",
      message: `id "${id}" does not match folder name "${folderName}"`
    };
  }
  const api = obj.api;
  if (typeof api !== "number" || api !== API) {
    return {
      ok: false,
      reason: "api",
      message: `api must be ${API}, got: ${api}`
    };
  }
  let capabilities = [];
  if (Array.isArray(obj.capabilities)) {
    capabilities = obj.capabilities;
  } else if (obj.capabilities !== void 0) {
    return {
      ok: false,
      reason: "field",
      message: "capabilities must be an array"
    };
  }
  const capabilitiesSet = new Set(CAPABILITIES);
  const unknownCapability = capabilities.find(
    (cap) => !capabilitiesSet.has(cap)
  );
  if (unknownCapability !== void 0) {
    return {
      ok: false,
      reason: "unknown-capability",
      message: `Unknown capability: ${unknownCapability}`
    };
  }
  let slot = "sidebar";
  if (obj.slot !== void 0) {
    if (typeof obj.slot !== "string") {
      return {
        ok: false,
        reason: "unknown-slot",
        message: `slot must be a string`
      };
    }
    if (!SLOTS.includes(obj.slot)) {
      return {
        ok: false,
        reason: "unknown-slot",
        message: `slot must be one of ${SLOTS.join(", ")}, got: ${obj.slot}`
      };
    }
    slot = obj.slot;
  }
  let kind = "extension";
  if (obj.kind !== void 0) {
    if (obj.kind !== "extension" && obj.kind !== "pin") {
      return {
        ok: false,
        reason: "field",
        message: `kind must be "extension" or "pin", got: ${obj.kind}`
      };
    }
    kind = obj.kind;
  }
  if (kind === "pin") {
    const pinCapabilitiesSet = new Set(PIN_CAPABILITIES);
    const overreachCapability = capabilities.find(
      (cap) => !pinCapabilitiesSet.has(cap)
    );
    if (overreachCapability !== void 0) {
      return {
        ok: false,
        reason: "pin-overreach",
        message: `pin cannot request capability: ${overreachCapability}`
      };
    }
  }
  const manifest = {
    id,
    name,
    description,
    version,
    author,
    main,
    api,
    capabilities,
    slot,
    kind
  };
  return {
    ok: true,
    manifest
  };
}
function parseAgentFile(text2) {
  const none = { description: "", tools: null, model: "" };
  const src = text2.replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return none;
  const end = src.indexOf("\n---", 4);
  if (end < 0) return none;
  const block = src.slice(4, end);
  const field = (key) => {
    for (const line of block.split("\n")) {
      if (line.startsWith(`${key}:`)) return unquote(line.slice(key.length + 1).trim());
    }
    return void 0;
  };
  const tools = field("tools");
  return {
    description: field("description") ?? "",
    tools: tools === void 0 ? null : tools.split(",").map((t) => t.trim()).filter(Boolean),
    model: field("model") ?? ""
  };
}
function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
function agentMismatch(item, facts) {
  const claims = item.claims;
  if (!claims) return null;
  const parts = { shelf: [], file: [] };
  let differs = false;
  if (claims.tools) {
    const a = [...claims.tools].sort().join(",");
    const b = facts.tools === null ? "*" : [...facts.tools].sort().join(",");
    if (a !== b) {
      differs = true;
      parts.shelf.push(`Uses ${listOf(claims.tools)}.`);
      parts.file.push(facts.tools === null ? "Every tool the engine has." : `Uses ${listOf(facts.tools)}.`);
    }
  }
  if (claims.model !== void 0 && claims.model !== facts.model) {
    differs = true;
    parts.shelf.push(`Runs on ${claims.model}.`);
    parts.file.push(facts.model ? `Runs on ${facts.model}.` : "Doesn't name a model.");
  }
  return differs ? { shelf: parts.shelf.join(" "), file: parts.file.join(" ") } : null;
}
function listOf(words) {
  if (words.length === 0) return "no tools";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
function checkItem(item, files) {
  switch (item.kind) {
    case "extension":
    case "pin": {
      if (files.manifestJson === null) return { ok: false, message: "Its repo has no wibble.json at that version." };
      if (files.mainJs === null) return { ok: false, message: "Its repo has no main.js at that version." };
      const parsed = parseManifest(files.manifestJson, item.id);
      if (!parsed.ok) {
        if (parsed.reason === "pin-overreach") {
          return { ok: false, message: "It says it's a pin but asks for more than a pin may, so it isn't offered." };
        }
        if (parsed.reason === "id-mismatch") {
          return { ok: false, message: "Its own id doesn't match the shelf's, so the shelf is describing something else." };
        }
        return { ok: false, message: `Its wibble.json can't be used: ${parsed.message}.` };
      }
      if (parsed.manifest.kind !== item.kind) {
        return { ok: false, message: `The shelf lists it as ${article(item.kind)}, and it says it's ${article(parsed.manifest.kind)}.` };
      }
      if (parsed.manifest.version !== item.version) {
        return {
          ok: false,
          message: `The shelf says version ${item.version}, and the code says ${parsed.manifest.version}.`
        };
      }
      return { ok: true, kind: item.kind, manifest: parsed.manifest };
    }
    case "agent": {
      if (files.agentMd === null) return { ok: false, message: "Its repo has no agent file at that version." };
      if (!files.agentMd.startsWith("---")) {
        return { ok: false, message: "Its agent file has no frontmatter, so there's nothing to say what it runs with." };
      }
      return { ok: true, kind: "agent", facts: parseAgentFile(files.agentMd) };
    }
    case "toy": {
      if (files.toyJson === null) return { ok: false, message: "Its repo has no toy file at that version." };
      let raw;
      try {
        raw = JSON.parse(files.toyJson);
      } catch {
        return { ok: false, message: "Its toy file isn't valid JSON." };
      }
      const spec = parseSpec(raw, item.name);
      if (spec === null) return { ok: false, message: "Its toy file has no parts Wibble can build." };
      return { ok: true, kind: "toy", spec };
    }
  }
}
function article(kind) {
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}
const KINDS = ["extension", "pin", "agent", "toy"];
const ID = /^[a-z0-9-]{1,48}$/;
const SHA = /^[0-9a-f]{40}$/;
function nameFromId(id) {
  const words = id.split("-").filter(Boolean).join(" ");
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}
function authorOf(repo) {
  const m = /^https:\/\/[^/]+\/([^/]+)\//.exec(repo);
  return m ? m[1] : "";
}
function safePath(path) {
  if (path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((part) => part !== "..");
}
function str(v) {
  return typeof v === "string" ? v : void 0;
}
function readHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const line of raw.slice(0, 50)) {
    if (!line || typeof line !== "object") continue;
    const l = line;
    const version = str(l.version)?.trim();
    const note = str(l.note)?.trim();
    if (!version || !note) continue;
    out.push({ version, note: note.slice(0, 280), date: str(l.date)?.trim() || void 0 });
  }
  return out;
}
function readClaims(e) {
  const tools = Array.isArray(e.tools) ? e.tools.filter((t) => typeof t === "string") : void 0;
  const model = str(e.model)?.trim() || void 0;
  return tools || model ? { tools, model } : void 0;
}
function readArt(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const a = raw;
  const body = str(a.body);
  const face = str(a.face);
  const aspect = typeof a.aspect === "number" && a.aspect > 0.2 && a.aspect < 5 ? a.aspect : 0.85;
  if (!body || !face || !safePath(body) || !safePath(face)) return void 0;
  return { body, face, aspect };
}
function parseEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "It isn't an entry Wibble can read." };
  }
  const e = raw;
  const kind = str(e.kind);
  if (!kind || !KINDS.includes(kind)) {
    return { ok: false, reason: `It says it's a "${kind ?? "nothing"}", and Wibble only knows extensions, pins, agents and toys.` };
  }
  const id = str(e.id);
  if (!id || !ID.test(id)) {
    return { ok: false, reason: "Its id has to be lowercase letters, numbers and hyphens." };
  }
  const repo = str(e.repo);
  if (!repo || !/^https:\/\/\S+$/.test(repo)) {
    return { ok: false, reason: "It doesn't link to its code with an https:// address." };
  }
  const ref = str(e.ref);
  if (!ref || !SHA.test(ref)) {
    return {
      ok: false,
      reason: "It doesn't say which version, so what you'd get could change after it was picked."
    };
  }
  const path = str(e.path) ?? ".";
  if (!safePath(path)) {
    return { ok: false, reason: "It points outside its own repo." };
  }
  if ((kind === "agent" || kind === "toy") && (path === "." || path === "")) {
    return { ok: false, reason: `It doesn't say which file in its repo is the ${kind}.` };
  }
  const version = str(e.version)?.trim();
  if (!version) {
    return { ok: false, reason: "It doesn't have a version number." };
  }
  const description = str(e.description)?.trim() ?? "";
  const name = str(e.name)?.trim().slice(0, 40) || nameFromId(id);
  return {
    ok: true,
    item: {
      kind,
      id,
      name,
      repo: repo.replace(/\/$/, ""),
      ref,
      path,
      version,
      description: description.slice(0, 280),
      author: authorOf(repo),
      art: kind === "agent" ? readArt(e.art) : void 0,
      history: readHistory(e.history),
      claims: kind === "agent" ? readClaims(e) : void 0
    }
  };
}
function parseIndex(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: "Its wibble-marketplace.json isn't valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Its wibble-marketplace.json isn't a shelf." };
  }
  const obj = parsed;
  if (!Array.isArray(obj.items)) {
    return { ok: false, message: "Its wibble-marketplace.json has no items list." };
  }
  const name = str(obj.name)?.trim() || "Unnamed shelf";
  const items = [];
  const skipped = [];
  const seen = /* @__PURE__ */ new Set();
  obj.items.forEach((entry, i) => {
    const result = parseEntry(entry);
    const e = entry && typeof entry === "object" ? entry : {};
    const label = str(e.name) || str(e.id) || `Entry ${i + 1}`;
    if (!result.ok) {
      skipped.push({ label, reason: result.reason });
      return;
    }
    const key = `${result.item.kind}/${result.item.id}`;
    if (seen.has(key)) {
      skipped.push({ label, reason: "This shelf already lists something with the same id." });
      return;
    }
    seen.add(key);
    items.push(result.item);
  });
  return { ok: true, index: { name, items, skipped } };
}
function rawEntries(raw) {
  const out = /* @__PURE__ */ new Map();
  if (raw === null) return out;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.items)) return out;
    for (const e of parsed.items) {
      if (e && typeof e === "object") {
        const r = e;
        out.set(`${String(r.kind)}/${String(r.id)}`, JSON.stringify(e));
      }
    }
  } catch {
  }
  return out;
}
function changes(base2, head) {
  const parsed = parseIndex(head);
  if (!parsed.ok) return { changed: [], skipped: [], broken: parsed.message };
  const before = rawEntries(base2);
  const after = rawEntries(head);
  const changed = parsed.index.items.filter((item) => {
    const key = `${item.kind}/${item.id}`;
    return before.get(key) !== after.get(key);
  });
  return { changed, skipped: parsed.index.skipped };
}
const TOY_FIELDS = [
  "dx",
  "dy",
  "thick",
  "r",
  "wall",
  "w",
  "h",
  "angle",
  "pivot",
  "swing",
  "bounce",
  "throw",
  "grip",
  "heavy",
  "spin",
  "torque",
  "drag",
  "spinDrag"
];
function toyProblems(raw, fallbackName) {
  const spec = parseSpec(raw, fallbackName);
  if (!spec) return ["It has no parts Wibble can build."];
  const r = raw;
  const input = (r.parts ?? []).filter((p) => !!p && typeof p === "object");
  const problems = [];
  if (input.some((p) => typeof p.k === "string")) {
    problems.push("It uses the old named parts (`k`). Describe it with shapes instead.");
    return problems;
  }
  if (input.length !== spec.parts.length) {
    problems.push(`It lists ${input.length} parts and ${spec.parts.length} can be built (unknown shapes are dropped, and the limit is 14).`);
    return problems;
  }
  input.forEach((p, i) => {
    const out = spec.parts[i];
    for (const f of TOY_FIELDS) {
      if (typeof p[f] !== "number") continue;
      const got = out[f];
      if (typeof got !== "number" || Math.abs(got - p[f]) > 0.5) {
        problems.push(`Part ${i + 1}'s \`${f}\` is ${String(p[f])}, which is out of range (Wibble would use ${String(got)}).`);
      }
    }
  });
  return problems;
}
function pngHasAlpha(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || sig.some((b, i) => bytes[i] !== b)) return false;
  const colourType = bytes[25];
  if (colourType === 4 || colourType === 6) return true;
  let at = 8;
  while (at + 8 <= bytes.length) {
    const len = bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3];
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + len;
  }
  return false;
}
function checkFiles(item, files, art) {
  const problems = [];
  const disclosure = [];
  const checked = checkItem(item, files);
  if (!checked.ok) {
    problems.push(checked.message);
  } else if (checked.kind === "extension" || checked.kind === "pin") {
    const m = checked.manifest;
    disclosure.push(`Asks for: ${m.capabilities.map((c2) => `\`${c2}\``).join(", ") || "nothing"}.`);
    if (checked.kind === "extension" && m.capabilities.includes("panel.render")) disclosure.push(`Panel: ${m.slot}.`);
  } else if (checked.kind === "agent") {
    const f = checked.facts;
    disclosure.push("Engine: Claude Code.");
    disclosure.push(`Model: ${f.model || "not named (the engine picks)"}.`);
    disclosure.push(`Tools: ${f.tools === null ? "every tool the engine has" : listOf(f.tools)}.`);
    const differ = agentMismatch(item, f);
    if (differ) disclosure.push(`⚠ The shelf and the file disagree. The shelf says: ${differ.shelf} The file says: ${differ.file} People will see both.`);
  } else if (checked.kind === "toy") {
    let raw = null;
    try {
      raw = JSON.parse(files.toyJson ?? "");
    } catch {
    }
    problems.push(...toyProblems(raw, item.name));
    disclosure.push(`${checked.spec.parts.length} parts, ${checked.spec.w}px wide.`);
  }
  if (item.kind === "agent" && item.art) {
    for (const [which, bytes] of [["body", art?.body ?? null], ["face", art?.face ?? null]]) {
      if (bytes === null) problems.push(`Its art's ${which} (\`${item.art[which]}\`) isn't a PNG at that commit.`);
      else if (!pngHasAlpha(bytes)) problems.push(`Its art's ${which} has no transparency, so it would draw as a rectangle.`);
    }
  }
  return { item, ok: problems.length === 0, problems, disclosure };
}
function summary(c2, reports2) {
  const lines = [];
  if (c2.broken) {
    return { ok: false, markdown: `### ✗ The shelf can't be read

${c2.broken}
` };
  }
  let ok2 = true;
  if (c2.skipped.length) {
    ok2 = false;
    lines.push("### ✗ Entries Wibble would skip", "");
    for (const s of c2.skipped) lines.push(`- **${s.label}**: ${s.reason}`);
    lines.push("");
  }
  if (reports2.length === 0 && c2.skipped.length === 0) {
    lines.push("No entries added or changed.");
  }
  for (const r of reports2) {
    if (!r.ok) ok2 = false;
    lines.push(`### ${r.ok ? "✓" : "✗"} ${r.item.name} · ${r.item.kind} · version ${r.item.version}`, "");
    lines.push(`\`${r.item.repo}\` at \`${r.item.ref.slice(0, 12)}\`${r.item.path !== "." ? `, \`${r.item.path}\`` : ""}`, "");
    if (r.problems.length) lines.push(...r.problems.map((p) => `- ✗ ${p}`), "");
    if (r.disclosure.length) lines.push("What people will be told:", "", ...r.disclosure.map((d) => `- ${d}`), "");
  }
  return { ok: ok2, markdown: lines.join("\n") };
}
const MAX_TEXT = 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : void 0;
}
function git(dir, args) {
  return execFileSync("git", args, {
    cwd: dir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 12e4
  }).toString().trim();
}
function readSmall(path, max) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}
const text = (p) => readSmall(p, MAX_TEXT)?.toString("utf8") ?? null;
const png = (p) => {
  const b = readSmall(p, MAX_IMAGE);
  return b && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? b : null;
};
function checkOne(item) {
  const dir = mkdtempSync(join(tmpdir(), "shelf-check-"));
  try {
    try {
      git(dir, ["init", "-q"]);
      git(dir, ["fetch", "-q", "--depth", "1", "--", item.repo, item.ref]);
      git(dir, ["-c", "core.symlinks=false", "checkout", "-q", "FETCH_HEAD"]);
    } catch {
      return {
        item,
        ok: false,
        disclosure: [],
        problems: [`Couldn't fetch commit \`${item.ref}\` from ${item.repo}. Is the repo public, and is that commit pushed?`]
      };
    }
    if (git(dir, ["rev-parse", "HEAD"]) !== item.ref) {
      return { item, ok: false, disclosure: [], problems: ["The commit fetched isn't the one the entry names."] };
    }
    const target = join(dir, item.path);
    if (!existsSync(target)) {
      return { item, ok: false, disclosure: [], problems: [`\`${item.path}\` isn't in the repo at that commit.`] };
    }
    const files = {
      manifestJson: null,
      mainJs: null,
      agentMd: null,
      toyJson: null,
      screenshot: null,
      artBody: null,
      artFace: null
    };
    if (item.kind === "extension" || item.kind === "pin") {
      files.manifestJson = text(join(target, "wibble.json"));
      files.mainJs = text(join(target, "main.js"));
    } else if (item.kind === "agent") {
      files.agentMd = text(target);
    } else {
      files.toyJson = text(target);
    }
    const art = item.art ? { body: png(join(dir, item.art.body)), face: png(join(dir, item.art.face)) } : void 0;
    return checkFiles(item, files, art);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const headPath = arg("--head");
const basePath = arg("--base");
if (!headPath) {
  console.error("usage: shelf-check --base <file|-> --head <file>");
  process.exit(2);
}
const base = basePath && basePath !== "-" && existsSync(basePath) ? readFileSync(basePath, "utf8") : null;
const c = changes(base, readFileSync(headPath, "utf8"));
const reports = c.changed.map(checkOne);
const { ok, markdown } = summary(c, reports);
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}
`);
process.exit(ok ? 0 : 1);
