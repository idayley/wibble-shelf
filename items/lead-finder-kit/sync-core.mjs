// THE ONE WAY CORE GETS INTO PAGES. Pages can't import, so each carries a
// copy of core.js between <script id="core"> tags. Edit core.js, then run
//
//   node items/lead-finder-kit/sync-core.mjs
//
// pages.test.mjs fails when a page's copy has drifted.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const dir = new URL("./", import.meta.url);
const core = readFileSync(new URL("core.js", dir), "utf8").replace(/\s+$/, "");
const re = /(<script id="core">)[\s\S]*?(<\/script>)/g;

for (const f of readdirSync(dir).filter((n) => n.endsWith(".html"))) {
  const html = readFileSync(new URL(f, dir), "utf8");
  if (!re.test(html)) continue;
  re.lastIndex = 0;
  // A function replacer: the core text holds "$" patterns a string would expand.
  const next = html.replace(re, (_, a, b) => `${a}\n${core}\n${b}`);
  if (next !== html) writeFileSync(new URL(f, dir), next);
  console.log(`${f}: ${next === html ? "already in sync" : "updated"}`);
}
