# Walkthrough kit

Records a persona using an app and turns it into a calm, captioned film for
people doing QA by watching, or for a demo. Sibling of Director: same sounds,
same care.

| File | What it is |
| --- | --- |
| `walk.mjs` | The recorder. Drives Chrome at a human pace and records the screen and a log. |
| `compose.mjs` | The film. Cuts the waits, smooths the pointer, places captions, adds cards and sound. |
| `plan.mjs` | Every decision the film makes, as pure functions. `node --test plan.test.mjs` covers it. |
| `page.js` | Runs inside the app: finds things by their words, masks private text, feeds the fake mic. |
| `compose.html` | The frame the film is drawn in (look A: lower-third caption with a step number). |
| `demo/` | Sprout, a small app to practise on: `node demo/serve.mjs`, then http://127.0.0.1:4317. |

Needs Node 22+, ffmpeg and Chrome. On a Mac, `say` gives the persona a voice.

## A reel

Everything recorded lives in a reel folder: `frames/` (the screen, only when
it changed), `frames.tsv` (when each frame was drawn), `log.json` (every step,
pointer move, click, key and voice line, with times), `look/` (a still after
each step, for you to check) and `voice/`. Nothing in a reel is ever shown
as-is; `compose.mjs` reads it.

## Rehearsing: one step at a time

```sh
node walk.mjs open <reel> --url https://app.example.com/start \
  [--profile <name>] [--mask "real@email.com=>sam@test.example"]... [--host api.example.com]
node walk.mjs chapter <reel> '{"title":"Getting started","sub":"Sam sets up their windowsill."}'
node walk.mjs do <reel> '{"do":"type","target":{"label":"First name"},"text":"Sam","say":"Sam starts with their first name."}'
node walk.mjs look <reel>
node walk.mjs drop <reel> last
node walk.mjs close <reel>
```

`open` starts a recording browser that stays running between commands. Every
`do` answers with whether it worked, what it touched, a still (`look`) and an
outline of what is on screen now in words: headings, controls, their values,
and the opening text. Read the still when the outline isn't enough.

`close` stops it and writes `script.draft.json`: the steps that worked and
weren't dropped, grouped by chapter. That is the clean path.

### Steps

Every step can carry `say`, its caption. A step without one keeps the last
caption up; use that for small moves that don't need words.

| `do` | Fields | Notes |
| --- | --- | --- |
| `click` | `target` | The pointer glides there, presses, and the screen is given time to settle. |
| `type` | `target`, `text`, `enter`, `clear` | Clicks the field, clears it (unless `clear: false`), types with a rhythm. |
| `select` | `target`, `option` | A `<select>`, by the option's words. |
| `check` | `target` | A checkbox or switch. Same as `click`, named for the reader. |
| `hover` | `target` | Moves there and rests. |
| `press` | `key` | `Enter`, `Tab`, `Escape`, `ArrowDown`… |
| `scroll` | `target` or `by` | Brings a thing into view, or scrolls by pixels. |
| `wait` | `for` (a target), `timeout`, or `ms` | Waits for something to appear. Long waits are sped up in the film. |
| `speak` | `line`, `voice` | The persona speaks into the app's microphone (macOS `say`; Samantha by default). |
| `pause` | `ms` | A beat, for something to sink in. |
| `goto` | `url` | Avoid in a film: a viewer can't see where it came from. Click there instead. |

A `target` finds things the way a person would:

- `{"text": "Save my plan"}`: the words on it. Words inside a clickable card stand for the card.
- `{"label": "Email"}`: a field by its label, placeholder or aria-label.
- `{"text": "Delete", "role": "button"}`: narrowed by role (`button`, `link`, `textbox`, `checkbox`, `tab`…).
- `{"css": "#plan-3 .edit"}`: only when nothing else works. Saved scripts break on it.
- `"nth": 2`: the second match.

A target off screen is scrolled into the middle first.

The recorder never leaves the app. A step that lands on another site goes back
and reports it; add `--host` for a site that is part of the app, such as its
sign-in page.

## A clean take

```sh
node walk.mjs take .walkthrough/<flow>.json <reel>
node walk.mjs take .walkthrough/<flow>.json <reel> --chapters 3
```

Replays a saved script from start to finish at the same calm pace, with no
thinking time. It stops at the first step that fails and reports the step,
the error, and a still. `--chapters` re-shoots only those chapters; give that
chapter a `start` URL in the script so it can begin there.

### The saved script

```json
{
  "title": "Setting up Sprout",
  "app": "Sprout",
  "persona": "Sam, a first-time plant owner in Portland",
  "url": "http://127.0.0.1:4317/",
  "viewport": [1440, 800],
  "profile": "sprout",
  "mask": [{ "from": "dana.real@example.com", "to": "sam@test.example" }],
  "hosts": [],
  "chapters": [
    { "title": "Getting started", "sub": "Sam tells Sprout about their windowsill.", "steps": [ … ] },
    { "title": "A voice note", "sub": "…", "start": "http://127.0.0.1:4317/#journal", "steps": [ … ] }
  ]
}
```

## The film

```sh
node compose.mjs <reel> --script .walkthrough/<flow>.json --out film.mp4
node compose.mjs <take> <reshoot> --script .walkthrough/<flow>.json --out film.mp4
node compose.mjs <reel> --script … --sheet sheet.png
node compose.mjs <reel> --script … --frame 31500
```

Several reels splice: each chapter comes from the latest reel that finished
it. `--sheet` is one frame per caption and card, to check before rendering.
`--frame` is one moment at full size. A rendered film takes about 1.3 seconds
per second of film.

The film also writes `film.md` next to it, listing every chapter and numbered
step with its time.

What the film does on its own:

- **Cuts** the time between steps (the agent thinking) and crossfades across
  the cut. A page load longer than 1.5 s plays in 0.9 s.
- **Draws the pointer** from the logged path: an eased glide with a slight
  arc, a press, and a ring on each click.
- **Holds each caption** long enough to read, numbered so reviewers can point
  at "step 07". It sits at the bottom unless the action or a busy patch of
  screen is there; then it moves to the calmest edge.
- **Zooms rarely**: only to small things (a nav link, a checkbox), at most
  1.12×, easing in and out slowly. Small things close together share one
  zoom; it lets go on a far move, a big target, a new page or a chapter card.
- **Cards**: a title card (persona, "synthetic" note, date), one per chapter,
  and an end card listing each chapter with its time and steps.
- **Sound**: a soft tick per click, a light patter while typing, a whoosh into
  each chapter, a chime at the end, and the persona's voice. No narrator.
  `--music` adds a quiet kalimba bed for a demo cut. `--silent` for none.

## Signing in

```sh
node walk.mjs signin <profile> https://app.example.com/login
```

Opens a real Chrome window with a saved profile. The operator signs in with
a test account and closes it; every later `open` or `take` with
`--profile <profile>` (or `"profile"` in the script) starts signed in.
Profiles live in `~/.cache/wibble-walkthrough/profiles/`.
