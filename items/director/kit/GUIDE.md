# The motion kit

A film is one HTML page. It loads `motion.js`, then describes scenes on a single timeline. The same page:

- plays on a Wibble canvas as an html pin, with a real player: play, scrub, chapter ticks, sound;
- renders frame-exact to MP4 with `render.mjs`, with every sound on the frame that made it.

Everything is in milliseconds, and in **world pixels**: the film's own canvas, 1080×1080 unless you say otherwise. The player scales it to fit.

```html
<!doctype html>
<meta charset="utf-8">
<title>My film</title>
<style> /* your own props */ </style>
<body>
<script src="https://cdn.jsdelivr.net/gh/idayley/wibble-shelf@cc3485ba7e2ecaa06ac008ef1adac9f59c62f7f7/items/director/kit/motion.js"></script>
<script>
  const F = film({ title: "My film", end: 20000 });
  scene(0, 6000, (root, at) => { /* build */ return lt => { /* draw */ }; });
  captions([[400, 3000, "Say it *short.*"]]);
  groove({ from: 0, to: 17000, resolve: 17000 });
</script>
```

`starter.html` is a complete 12-second film to copy. `examples/wibble-teaser.html` is a 36-second one that uses every part of the kit.

## The film

`film({ title, end, size, whip, theme, poster, hold, music, captions })` — call once, first.

| Option | Default | Meaning |
|---|---|---|
| `end` | 10000 | Length in ms. |
| `size` | `[1080, 1080]` | `[1080, 1920]` for vertical, `[1920, 1080]` for landscape. |
| `whip` | 420 | How long a scene transition takes. |
| `theme` | `"light"` | `"dark"` swaps the world's colours. |
| `poster` | `end` | The frame shown before anyone presses play. The end card is usually right. |
| `hold` | 1000 | Extra still frames at the end of the MP4. |
| `music` | 0.8 | Groove level against the sound effects. |
| `captions` | | `{ top, size }` defaults for every caption. |

It returns `F` with `F.w`, `F.h` and `F.end`.

## Scenes

`scene(t0, t1, build, { enter, bg })`

`build(root, at)` runs once. Make your elements inside `root`, then return `draw(lt)`, which runs every frame with `lt`, the time in ms since the scene began. **Draw from `lt` alone.** Never keep state between frames: the renderer seeks back and forth, and the scrubber does too.

`at(ms, kind, gain = 1, x = centre)` places a sound at scene time `ms`. `x` is where it happens, in world pixels, and pans it.

Scenes should tile the timeline with no gaps: `scene(0, 4000)`, `scene(4000, 9000)` and so on. A scene stays on screen for `whip` ms after its `t1` while the next one enters. `enter` sets how:

- `"whip"` (default): slides in from the right with speed lines and a whoosh.
- `"zoom"`: scales down into place.
- `"fade"`: fades in over the last one.
- `"cut"`: a hard cut.

Children of `root` are `position: absolute`. Place them with `pos(el, x, y, w, h)`.

## Captions and chapters

`captions([[t0, t1, "Words, with *highlights*"], ...])` — one line at a time, popping in word by word, each with a tick. Up to about six words. End each caption just before a cut. A fourth item, `{ top, size }`, moves one caption.

`beats([[t, "Name", "note"], ...])` — chapter marks. They become ticks on the scrubber, the name beside it, and the frames of a contact sheet.

## Wibblets

A **troupe** is a scene's cast. Its members' verbs make their own dust and their own sounds: footsteps, hops, skids and landings are cued for you.

```js
const tr = troupe(root);
const W = tr.add("W", 820, { h: 150 });           // letter, ground line y, options
W.at(0, -200).run(540, 700, { dust: true }).skid(600).until(2000).hop(620, { H: 60 }).until(9000);
tr.sortZ();                                       // nearer (larger ground y) in front
return lt => tr.draw(lt);
```

- Letters `A`–`Z`, plus `"director"`, a clapperboard. `W` is the logo and always wears the logo's red.
- Options: `h` (height, default 120), `slot` (0–7, picks the colour), `ph` (breathing phase), `tint`/`tint2` (your own colours), `quiet: true` (no sounds).
- Width is `h * ASPECT[letter]`.

Verbs chain in time. `x` is where the feet are. `y` is height above the ground line, so negative is up.

| Verb | Does |
|---|---|
| `at(t, x, y = 0)` | Start here, at this time. |
| `run(x, ms, { dust, stride, jump, strides })` | Bounding run. |
| `skid(x, ms = 380)` | Braking slide, leaning back. |
| `hop(ms = 620, { to, H })` | Squash, jump `H` px, land. |
| `arc(x, y, ms, { peak, spin })` | Thrown through the air. Follow it with `plop`. |
| `plop(ms = 460, { big })` | The landing squash. |
| `startle(ms)`, `wobble(ms)`, `lean(deg, ms)` | Reactions. |
| `hold(ms)`, `until(t)` | Stand and breathe. |
| `gone()` | Leave the stage. |

**Wibblets have no eyes to move.** All their personality is squash, stretch, lean and timing. Don't try to make them look or blink.

`actor.pose` is the current pose (`{ x, y, sx, sy, rot }`) after `tr.draw`, so props can ride on a character. `mkW(parent, letter, o)` and `put(w, x, groundY, pose)` draw one by hand.

## Props and helpers

| Helper | Does |
|---|---|
| `el(tag, cls, parent, html)` / `pos(el, x, y, w, h)` | Make and place. |
| `popIn(el, u, rot, dy, extra)` | Pops in with overshoot for `u` from 0 to 1. Hidden while `u <= 0`. |
| `popBub(age)` | Scale for a speech bubble `age` ms after it appears. |
| `typeOn(at, t, text, { ms, gain, x })` | Typing with key sounds. Returns `lt => visible text`. |
| `pointer(root, at)` | A cursor: `.at(t, x, y).to(t, x, y, ms).click(t).hide(t)`, then `.draw(lt)`. `.press(lt)` is 0 to 1 during a click, to squash whatever it presses. |
| `confetti(root, n, seed, at, t)` | Returns `draw(x, y, age)`. With `at` and `t` it cues its own pop. |
| `ripple(root, t, x, y, { size, ms, color })` | An expanding ring. Returns `draw(lt)`. |
| `svgEl(root, cls, w, h)` | An SVG layer. Stroke-dash tricks draw lines in. |
| `tl(t, a, b)` | 0 to 1 as `t` goes from `a` to `b`, clamped. The workhorse. |
| `lerp`, `clamp`, `eo3` (ease out), `eio` (in-out), `eob` (overshoot), `kf(frames, u)`, `rng(seed)` | Maths. |

Kit classes you can use or restyle: `mo-card` with a `mo-kick` label, `mo-bub` (and `.me`), `mo-chip` (`.dark`, `.ok`, `.bad`), `mo-term` (a terminal: `.tb` title bar, `pre`, spans `.d` `.a` `.g` `.cur`), `mo-win` (a window with a `.tb`), `mo-dots` (a dotted canvas floor), `mo-big-t` (end-card headline, `em` in accent), `mo-url`, `mo-stampx`, `mo-cam` (a zoomable layer).

The world's colours are CSS variables: `--bg --ink --muted --line --card --floor --accent --puff --shade --dot --term --ok --alert`, plus `--sans` and `--mono` for type.

**Name your own classes plainly** (`.hero`, `.price`), and never with `mo-`. Wibble drops its own pin styles for any class your page defines, so your names are always yours.

## Sound

Everything you hear is a cue: `at(ms, kind, gain, x)` inside a scene, or `cue(t, kind, gain, x)` on the film's clock.

| Kind | Sound | Use for |
|---|---|---|
| `pin`, `drop`, `emit` | Soft drop | Something appears. |
| `card` | Card set down | Cards and tiles landing. |
| `bubble` | Glass blip | A speech bubble. |
| `type` | Key | Typing (or use `typeOn`). |
| `click` | Click | A press. |
| `whoosh`, `whip`, `throw`, `cast` | Swoosh | Fast movement. `whip` plays at every whip cut on its own. |
| `chime` | Two-note chime | Success. |
| `notify` | Notification | A phone buzz or an alert. |
| `stamp` | Wood slam | A verdict. |
| `pickup` | Chips lifted | Picking something up. |
| `squish` | Soft squash | Squeezing, shrinking. |
| `shake` | Dice rattle | Tension, shaking. |
| `burst` | Plate crash plus swoosh | Breaking out. |
| `confetti` | Party popper | Celebration. |
| `bite` | Water drop | A small surprise. |
| `bonk`, `stars` | Plate hit, glass sparkle | Comedy hit, dazed. |
| `land`, `land_big`, `hop`, `step`, `skid`, `word` | | Made automatically by wibblets and captions. |
| `note:c4` | Kalimba, `c3` to `e5` | A single note. Walk up a scale as steps complete. |

`groove({ from, to, resolve, mood, beat, tune })` lays kalimba music under the film as cues:

- `mood`: `"bright"` (C G Am F) or `"gentle"` (Am F C G).
- `beat`: 420 ms.
- `resolve`: a rolled chord, placed on the moment the film lands.

Start it on the first big move, not at 0.

Live, sound starts when the viewer presses play (browsers require that), and the speaker button mutes it. In the MP4 it is mixed, limited and loudness-normalised to −14 LUFS, the level social platforms play at.

## Rendering

Needs Node 22+, ffmpeg and Chrome or Chromium.

```sh
node render.mjs film.html --lint             # the film's own checks
node render.mjs film.html --sheet sheet.png  # two frames per chapter, stamped, in one image
node render.mjs film.html --frame 4200       # one frame at full size
node render.mjs film.html out.mp4            # the film (--fps 60, --silent)
```

The lint catches:

- unknown sound kinds;
- gaps and overlaps between scenes;
- captions that are too long, too brief, overlapping, or running across a cut.

Page errors stop the render and are printed.

In a browser, `film.html?t=4200` opens paused at that moment.
