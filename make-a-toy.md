# Make a toy

A toy is something for the ranch that wibblets play on when nothing's running. It's one JSON file of parts. It can't run anything, so the worst a toy can do is fall over.

## The file

```json
{
  "name": "Ski jump",
  "note": "a long ramp that kicks up at the end",
  "parts": [
    { "shape": "bar", "hold": "fixed", "x": 0, "y": -160, "dx": 220, "dy": 140, "grip": 0.08 },
    { "shape": "bar", "hold": "fixed", "x": 220, "y": -20, "dx": 70, "dy": -34, "grip": 0.08 }
  ]
}
```

Up to 14 parts. Distances are pixels, `y` goes **down**, and the lowest part becomes the ground.

| Field | For | Range |
|---|---|---|
| `shape` | `bar`, `disc`, `ring` or `box` | |
| `x`, `y` | a bar's first end; everything else's centre | ±600 |
| `dx`, `dy` | a bar's other end, from `x`,`y` | length 44–460 |
| `thick` | a bar's thickness | 3–30 |
| `r`, `wall` | a disc's or ring's radius, a ring's wall | 6–190, 3–24 |
| `w`, `h` | a box's size | up to 460 × 360 |
| `hold` | `fixed` (doesn't move), `pin` (turns on the spot) or `loose` (falls) | |
| `pivot` | where along a pinned bar it turns, 0–1 (a seesaw is 0.5) | |
| `swing` | how far a pinned part may turn, in radians | 0–π |
| `bounce`, `grip` | how bouncy, how grippy | 0–0.95, 0–1 |
| `throw` | a springboard: launches what lands on it, in px/s | 0–2200 |
| `spin`, `torque` | a motor, on a pinned part | ±6 rad/s, 1–400 |
| `heavy`, `drag` | how heavy for its size, how fast it slows | 0.1–8, 0–4 |

`links` join parts: `{ "a": 0, "b": 1, "kind": "rope" | "hinge" | "pulley" }`.

Numbers outside a range are pulled back into it rather than refused. Keep inside them anyway: a toy that gets pulled back isn't quite what you drew, and a reviewer will ask you to fix it.

## Start from a copy

[wibble-template-toy](https://github.com/idayley/wibble-template-toy) → **Use this template**.

## Try it

There's no way to load a toy from a file yet. Open your pull request and the reviewer will try it on their ranch.

## Put it on the shelf

See [CONTRIBUTING.md](CONTRIBUTING.md). The entry's `path` is your file's name, e.g. `"path": "toy.json"`.
