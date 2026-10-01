// node --test plan.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BANDS, buildTimeline, captionRuns, chooseReels, cursorAt, focusFor, frameAt, isSmall, mapTime, pickBand, planZooms,
  readMs, soundCues, throughZoom, zoomAt,
} from "./plan.mjs";

const VIEW = [1440, 800];
const step = (n, t0, t1, o = {}) => ({ n, t0, t1, ok: true, do: "click", say: `Step ${n}.`, url: "http://app/a", target: { x: 600, y: 380, w: 240, h: 48 }, ...o });

test("long waits are cut, and the cut crossfades", () => {
  const tl = buildTimeline([{ reel: "0", chapter: null, steps: [step(1, 0, 3000), step(2, 9000, 12000)] }], { end: false });
  assert.equal(tl.pieces.length, 2);
  assert.equal(tl.dur, 6000, "the 6s the agent spent thinking is gone");
  assert.equal(tl.pieces[1].fade, true);
  assert.equal(frameAt(tl, 3100).from.a > 0.5, true, "just after the cut the old frame is still fading out");
});

test("back-to-back steps run on with no cut", () => {
  const tl = buildTimeline([{ reel: "0", chapter: null, steps: [step(1, 0, 3000), step(2, 3100, 6000)] }], { end: false });
  assert.equal(tl.pieces[1].fade, false);
  assert.equal(tl.pieces[1].src0, 3000, "the 100ms between them is kept, so nothing jumps");
});

test("a slow page load is sped up, not shown in full", () => {
  const s = step(1, 0, 12000, { tSettle0: 1000, tSettle1: 11000 });
  const tl = buildTimeline([{ reel: "0", chapter: null, steps: [s] }], { end: false });
  assert.equal(tl.dur, 1000 + 900 + 1000);
  assert.equal(frameAt(tl, 1450).src, 6000, "halfway through the squeezed wait is halfway through the real one");
});

test("dropped and failed steps are left out, and numbers stay in order", () => {
  const tl = buildTimeline([{ reel: "0", chapter: null, steps: [step(1, 0, 2000), step(2, 2000, 4000, { dropped: true }), step(3, 4000, 6000, { ok: false }), step(4, 6000, 8000)] }], { end: false });
  assert.deepEqual(tl.steps.map(s => [s.n, s.num]), [[1, 1], [4, 2]]);
});

test("title, chapter and end cards land in order", () => {
  const tl = buildTimeline([
    { reel: "0", chapter: { index: 0, title: "Sign up" }, steps: [step(1, 0, 2000)] },
    { reel: "0", chapter: { index: 1, title: "Pick plants" }, steps: [step(2, 2000, 4000)] },
  ], { title: { title: "Sprout" } });
  assert.deepEqual(tl.pieces.map(p => p.kind === "card" ? p.card.type : "v"), ["title", "chapter", "v", "chapter", "v", "end"]);
});

test("the film's pointer follows the logged path and rests where it stopped", () => {
  const moves = [{ t0: 1000, t1: 1500, from: [0, 0], to: [100, 0] }];
  assert.equal(cursorAt(moves, 500), null);
  assert.deepEqual(cursorAt(moves, 1000).map(Math.round), [0, 0]);
  assert.deepEqual(cursorAt(moves, 4000), [100, 0]);
  const mid = cursorAt(moves, 1250);
  assert.ok(mid[0] > 40 && mid[0] < 60 && Math.abs(mid[1]) > 1, "eased and slightly arced");
});

test("captions stay up long enough to read", () => {
  assert.equal(readMs(null), 0);
  assert.ok(readMs("She opens her role.") >= 2000);
  assert.ok(readMs("x".repeat(400)) <= 5500);
});

// ---------- zoom ----------
const small = { x: 1200, y: 120, w: 90, h: 30 }, small2 = { x: 1180, y: 200, w: 120, h: 36 }, big = { x: 200, y: 200, w: 900, h: 400 };
const tlOf = steps => buildTimeline([{ reel: "0", chapter: null, steps }], { end: false });

test("only small targets earn a zoom", () => {
  assert.equal(isSmall(small, VIEW), true);
  assert.equal(isSmall(big, VIEW), false);
  assert.equal(planZooms(tlOf([step(1, 0, 3000, { target: big })]), VIEW).length, 0);
  assert.equal(planZooms(tlOf([step(1, 0, 3000, { target: small })]), VIEW).length, 1);
});

test("nearby small targets share one zoom instead of pumping in and out", () => {
  const z = planZooms(tlOf([step(1, 0, 3000, { target: small, do: "type" }), step(2, 3000, 6000, { target: small2 }), step(3, 6000, 8000, { do: "pause", target: null })]), VIEW);
  assert.equal(z.length, 1);
  assert.equal(z[0].out1, 8000, "a pause in the same place keeps the zoom");
  assert.ok(z[0].s <= 1.12 && z[0].s >= 1.04);
});

test("the zoom lets go on a far move, a big target, or a page change", () => {
  const far = { x: 40, y: 700, w: 90, h: 30 };
  assert.equal(planZooms(tlOf([step(1, 0, 3000, { target: small }), step(2, 3000, 6000, { target: far })]), VIEW).length, 2);
  assert.equal(planZooms(tlOf([step(1, 0, 3000, { target: small }), step(2, 3000, 6000, { target: big }), step(3, 6000, 9000, { target: small })]), VIEW).length, 2);
  assert.equal(planZooms(tlOf([step(1, 0, 3000, { target: small, nav: true })]), VIEW).length, 0, "a link that opens a new page is not zoomed");
});

test("a zoom never pushes its target off screen", () => {
  const [z] = planZooms(tlOf([step(1, 0, 3000, { target: { x: 1380, y: 760, w: 50, h: 30 } })]), VIEW);
  const [x, y] = throughZoom([1430, 790], { s: z.s, fx: z.fx, fy: z.fy });
  assert.ok(x <= VIEW[0] && y <= VIEW[1], `${x},${y} is inside the view`);
  assert.equal(focusFor(720, 1.1, 1440).toFixed(3), "720.000", "centred content zooms about the centre");
});

test("the camera eases in and back out", () => {
  const zs = [{ out0: 1000, out1: 4000, s: 1.1, fx: 700, fy: 400 }];
  assert.equal(zoomAt(zs, 500, VIEW).s, 1);
  assert.ok(zoomAt(zs, 1300, VIEW).s > 1 && zoomAt(zs, 1300, VIEW).s < 1.1);
  assert.equal(zoomAt(zs, 3000, VIEW).s, 1.1);
  assert.equal(zoomAt(zs, 6000, VIEW).s, 1);
});

// ---------- caption bands ----------
test("the caption avoids what is being used, and prefers a calm stretch", () => {
  const gw = 32, gh = 18, flat = new Array(gw * gh).fill(0.95);
  assert.equal(pickBand(flat, gw, gh), "bottom", "calm everywhere: bottom");
  const target = { x0: 0.4, y0: 0.9, x1: 0.6, y1: 0.95 };
  assert.equal(pickBand(flat, gw, gh, [target]), "top", "the button is at the bottom: go to the top");
  const busy = flat.map((v, i) => (Math.floor(i / gw) >= 14 ? (i % 2 ? 0.1 : 0.9) : v));
  assert.equal(pickBand(busy, gw, gh), "top", "a busy footer: go to the top");
  assert.ok(BANDS.every(b => b.x1 > b.x0 && b.y1 > b.y0));
});

test("steps without words keep the caption before them", () => {
  const tl = tlOf([step(1, 0, 2000), step(2, 2000, 3000, { say: null, do: "pause" }), step(3, 3000, 5000)]);
  const runs = captionRuns(tl);
  assert.deepEqual(runs.map(r => [r.num, r.out0, r.out1]), [[1, 0, 3000], [2, 3000, 5000]]);
});

// ---------- splicing ----------
test("each chapter comes from the latest take that finished it", () => {
  const reels = [{ id: "a", chapters: { 0: true, 1: true, 2: false } }, { id: "b", chapters: { 2: true } }, { id: "c", chapters: { 1: true } }];
  assert.deepEqual(chooseReels(reels, 4), { picks: [{ chapter: 0, reel: "a" }, { chapter: 1, reel: "c" }, { chapter: 2, reel: "b" }], missing: [3] });
});

test("a re-shot chapter splices in with its own reel's timing", () => {
  const tl = buildTimeline([
    { reel: "a", chapter: { index: 0, title: "One" }, steps: [step(1, 0, 2000)] },
    { reel: "b", chapter: { index: 1, title: "Two" }, steps: [step(2, 500, 2500)] },
  ], { end: false });
  const v = tl.pieces.filter(p => p.kind === "video");
  assert.deepEqual(v.map(p => [p.reel, p.src0, p.src1]), [["a", 0, 2000], ["b", 500, 2500]]);
  assert.equal(mapTime(tl, "b", 1500), v[1].out0 + 1000);
  assert.equal(mapTime(tl, "a", 2500), null, "a moment that was cut has no place in the film");
});

test("sounds follow the clicks into the film, and cut moments stay silent", () => {
  const tl = tlOf([step(1, 0, 2000), step(2, 8000, 10000)]);
  const cues = soundCues(tl, { 0: { clicks: [{ t: 500, x: 700 }, { t: 5000, x: 700 }, { t: 8500, x: 100 }], keys: [], voices: [{ t: 9000, file: "voice/1.wav" }] } });
  const clicks = cues.filter(c => c.file.startsWith("click"));
  assert.deepEqual(clicks.map(c => c.t), [500, 2500]);
  assert.ok(clicks[1].pan < 0, "a click on the left sounds from the left");
  assert.equal(cues.find(c => c.voice).t, 3000);
});
