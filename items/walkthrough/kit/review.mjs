#!/usr/bin/env node
// Builds the QA review page: one step at a time, each with its still and its
// slice of the film, a verdict and a note. compose.mjs makes one beside every
// film; run this yourself to put several films into one review.
//
//   node review.mjs <review dir…> --out <dir> [--title "…"]
//
// A review dir is the film.review folder compose.mjs writes (steps.json + stills/).
// With one dir and no --out, the page lands in that dir. Writes <out>/index.html;
// when combining, the stills are copied in as stills/f<i>-NN.jpg and the film
// paths point back at the films where they are.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/// A path from `from` to `to` as a URL the page can use.
const rel = (from, to) => path.relative(from, to).split(path.sep).map(encodeURIComponent).join("/") || ".";

/// "2026-10-09" as "Oct 9, 2026".
const day = r => { const d = new Date(r + "T12:00"); return isNaN(d) ? r : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };

/// The line under the title: the app, the persona, when it was recorded, how many films.
function subtitle(films) {
  const one = (k, f = v => v) => { const vs = [...new Set(films.map(d => d[k]).filter(Boolean))]; return vs.length === 1 ? f(vs[0]) : null; };
  return [one("app"), one("persona", p => p.split(",")[0]), one("recorded", day),
    films.length > 1 ? `${films.length} films` : null].filter(Boolean).join(" · ");
}

/// Writes outDir/index.html for the review folders in `dirs`; returns its path.
/// opts.title names the whole review (default: the film's title, or the app's when combining).
export async function buildReview(dirs, outDir, opts = {}) {
  outDir = path.resolve(outDir); dirs = dirs.map(d => path.resolve(d));
  const single = dirs.length === 1 && dirs[0] === outDir;
  if (!single) mkdirSync(path.join(outDir, "stills"), { recursive: true });
  const data = dirs.map(dir => {
    const f = path.join(dir, "steps.json");
    if (!existsSync(f)) throw new Error(`${dir} is not a review folder (no steps.json).`);
    return { dir, ...JSON.parse(readFileSync(f, "utf8")) };
  });
  const FILMS = data.map((d, i) => {
    const id = "f" + (i + 1);
    return {
      id, title: d.title, persona: d.persona, duration: d.duration, chapters: d.chapters || [], view: d.view,
      video: rel(outDir, path.resolve(d.dir, d.film || "../film.mp4")),
      steps: d.steps.map(s => {
        let still = s.still;
        if (!single && s.still) {
          still = `stills/${id}-${String(s.num).padStart(2, "0")}${path.extname(s.still) || ".jpg"}`;
          copyFileSync(path.join(d.dir, s.still), path.join(outDir, still));
        }
        return { ...s, still };
      }),
    };
  });
  const title = opts.title || (data.length === 1 ? data[0].title : data[0].app ? `${data[0].app} review` : "Walkthrough review");
  const META = { title, sub: opts.sub ?? subtitle(data) };
  // `<` escaped so no step text can close the script tag.
  const json = v => JSON.stringify(v).replace(/</g, "\\u003c");
  const html = readFileSync(path.join(here, "review.html"), "utf8")
    .replace("/*FILMS*/[]", () => json(FILMS)).replace("/*META*/{}", () => json(META));
  const out = path.join(outDir, "index.html");
  writeFileSync(out, html);
  return out;
}

// ---------- the command ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = name => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const title = flag("--title"), out = flag("--out") ?? (argv.length === 1 ? argv[0] : undefined);
  if (!argv.length || !out) { console.error('usage: node review.mjs <review dir…> --out <dir> [--title "…"]'); process.exit(2); }
  try {
    const page = await buildReview(argv, out, { title });
    console.log(`  review: ${page} (${argv.length} film${argv.length === 1 ? "" : "s"})`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
