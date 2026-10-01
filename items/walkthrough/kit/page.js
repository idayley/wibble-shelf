// Runs inside the app being walked, before its own scripts (walk.mjs injects
// it on every page). Three jobs, all on `window.__walk`:
//   find(target)   where a thing is on screen, by its words, label or selector
//   outline()      what is on screen, in words, for the agent rehearsing
//   speak(b64)     plays a clip into the fake microphone
// and one standing job: replacing masked words (the signed-in email, a real
// name) as the page draws them, so a film can be passed around safely.
(() => {
  if (window.__walk) return;
  const CFG = window.__walkConfig || { mask: [] };
  const norm = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  // ---------- masking ----------
  const masks = (CFG.mask || []).filter(m => m && m.from).sort((a, b) => b.from.length - a.from.length);
  const scrub = s => { for (const m of masks) if (s.includes(m.from)) s = s.split(m.from).join(m.to); return s; };
  const scrubNode = n => {
    if (n.nodeType === 3) { const v = scrub(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; return; }
    if (n.nodeType !== 1 || n.tagName === "SCRIPT" || n.tagName === "STYLE") return;
    for (const a of ["title", "aria-label", "placeholder", "alt"]) if (n.hasAttribute?.(a)) { const v = scrub(n.getAttribute(a)); if (v !== n.getAttribute(a)) n.setAttribute(a, v); }
    if ((n.tagName === "INPUT" || n.tagName === "TEXTAREA") && n.value && masks.some(m => n.value.includes(m.from)) && n !== document.activeElement) n.value = scrub(n.value);
    for (const c of n.childNodes) scrubNode(c);
  };
  if (masks.length) {
    // Watch the document itself, from before the first byte is parsed: the
    // observer runs before each paint, so a masked word is never drawn.
    if (document.documentElement) scrubNode(document.documentElement);
    new MutationObserver(rs => { for (const r of rs) { if (r.type === "characterData") scrubNode(r.target); else r.addedNodes.forEach(scrubNode); } })
      .observe(document, { subtree: true, childList: true, characterData: true });
  }

  // ---------- finding things ----------
  const INTERACTIVE = "a[href],button,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[contenteditable=true],[onclick],[tabindex]:not([tabindex='-1'])";
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05;
  };
  const labelOf = el => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText; }
    const wrap = el.closest("label"); if (wrap) return wrap.innerText;
    const by = el.getAttribute("aria-labelledby");
    if (by) return by.split(/\s+/).map(i => document.getElementById(i)?.innerText || "").join(" ");
    return "";
  };
  const nameOf = el => {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return el.getAttribute("aria-label") || labelOf(el) || el.placeholder || el.name || (el.type === "submit" || el.type === "button" ? el.value : "") || "";
    }
    return el.getAttribute("aria-label") || el.innerText || el.value || el.title || el.getAttribute("alt") || "";
  };
  const roleOf = el => el.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : el.type === "submit" || el.type === "button" ? "button" : "textbox", TEXTAREA: "textbox", SELECT: "select", SUMMARY: "button" })[el.tagName] || "";

  function candidates(t) {
    if (t.css) return [...document.querySelectorAll(t.css)].filter(visible);
    const want = norm(t.text ?? t.label ?? t.name ?? "");
    const pool = new Set([...document.querySelectorAll(INTERACTIVE)]);
    if (t.text != null) {
      // Plain text too: a card or a row that the app makes clickable by script.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) if (norm(n.nodeValue).includes(want) && n.parentElement) pool.add(n.parentElement);
    }
    const best = new Map();
    for (const el of pool) {
      if (!visible(el) || (t.label != null && el.tagName === "LABEL")) continue;
      const name = norm(t.label != null ? (labelOf(el) || el.placeholder || el.getAttribute("aria-label") || "") : nameOf(el));
      if (!name) continue;
      const score = name === want ? 3 : name.startsWith(want) ? 2 : name.includes(want) ? 1 : 0;
      if (!score) continue;
      // Words inside a clickable card or row stand for the whole thing.
      const hit = el.matches(INTERACTIVE) ? el : el.closest(INTERACTIVE) || el;
      if (t.role && roleOf(hit) !== t.role) continue;
      const r = hit.getBoundingClientRect();
      const interactive = hit.matches(INTERACTIVE) || getComputedStyle(hit).cursor === "pointer";
      const o = { el: hit, score: score * 10 + (interactive ? 5 : 0), area: r.width * r.height };
      if (!best.has(hit) || best.get(hit).score < o.score) best.set(hit, o);
    }
    const out = [...best.values()].sort((a, b) => b.score - a.score || a.area - b.area);
    return out.map(o => o.el);
  }

  const rectOf = el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const describe = el => ({ tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el).replace(/\s+/g, " ").trim().slice(0, 80) });

  /// Finds the target, scrolling it into the middle of the screen if needed.
  /// Returns { rect, el, count } or { error }.
  async function find(t, { scroll = true } = {}) {
    const list = candidates(t);
    const el = list[t.nth ? t.nth - 1 : 0];
    if (!el) return { error: `nothing on screen matches ${JSON.stringify(t)}` };
    const r = el.getBoundingClientRect();
    if (scroll && (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth)) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      await new Promise(ok => setTimeout(ok, 650));
    }
    window.__walkLast = el;
    return { rect: rectOf(el), el: describe(el), count: list.length };
  }

  /// What the agent sees in words: headings, things to press or fill in,
  /// and the first stretch of text.
  function outline() {
    const seen = new Set(), things = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (!visible(el) || el.tagName === "LABEL" || things.length >= 70) continue;
      const d = describe(el);
      const key = d.role + d.name;
      if (!d.name || seen.has(key)) continue;
      seen.add(key);
      const r = el.getBoundingClientRect();
      const on = r.bottom > 0 && r.top < innerHeight ? "" : r.top >= innerHeight ? " (below)" : " (above)";
      const extra = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? ` value="${(el.value || "").slice(0, 40)}"` : el.disabled ? " disabled" : "";
      things.push(`${d.role || d.tag}: ${d.name}${extra}${on}`);
    }
    const heads = [...document.querySelectorAll("h1,h2,h3")].filter(visible).map(h => `${h.tagName}: ${h.innerText.trim().slice(0, 90)}`).slice(0, 15);
    return { url: location.href, title: document.title, headings: heads, controls: things, text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 700) };
  }

  // ---------- the fake microphone ----------
  let ctx = null, dest = null;
  const audio = () => {
    if (!ctx) {
      ctx = new AudioContext();
      dest = ctx.createMediaStreamDestination();
      const keep = ctx.createOscillator(), mute = ctx.createGain();
      mute.gain.value = 0; keep.connect(mute).connect(dest); keep.start();
    }
    return { ctx, dest };
  };
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = async c => {
      if (!c || !c.audio) return real(c);
      const { dest } = audio();
      const tracks = [...dest.stream.getAudioTracks()];
      if (c.video) { try { tracks.push(...(await real({ video: c.video })).getVideoTracks()); } catch {} }
      return new MediaStream(tracks);
    };
  }
  async function speak(b64) {
    const { ctx, dest } = audio();
    if (ctx.state === "suspended") await ctx.resume();
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(dest); src.start();
    return buf.duration;
  }

  window.__walk = { find, outline, speak, last: () => window.__walkLast };
})();
