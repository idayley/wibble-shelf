# Make an agent's wibblet

An agent on the shelf can have its own wibblet. It isn't a letter wearing a hat: the wibblet *is* the thing the agent's work is about, with a face on it. Director is a clapperboard; Walkthrough is a camcorder.

## What Wibble wants

Two PNGs and a number in the agent's shelf entry:

```json
"art": { "body": "items/<agent>/art/body.png", "face": "items/<agent>/art/face.png", "aspect": 1.6 }
```

- **body.png**: the whole silhouette. Wibble fills it with the wibblet's colour.
- **face.png**: the details: eyes, smile, glints, a few highlight bars. Wibble fills them near-white.
- Both are white on transparent, 207px tall, cropped tight to the body. Only the shape counts.
- `aspect` is width over height.

## How

1. **Pick the object.** One thing the agent's job is about, chunky enough to hold a face. Sideways and slightly tilted reads better than face-on.

2. **Get a picture of it** in the wibblet style: soft, rounded, a face on the biggest flat side. Any illustration will do; it's only a guide.

3. **Redraw it as flat shapes.** Don't trace pixels. Shading has nowhere to go in two flat layers, and traced edges come out lumpy. Copy [`items/walkthrough/art/camcorder.html`](items/walkthrough/art/camcorder.html) beside your picture, set the `<image id="ref">` to it, and replace the shapes:
   - **Parts** (in `<defs>`, back to front): rounded rects and ellipses, one per part. Rotate them together if the object is tilted.
   - **Seams** are what make it read as an object rather than a blob: a thin gap wherever a front part overlaps one behind it, like Director's clapper arm and board. In the mask, stroke the front part's outline, clipped to the part behind it. Where a part sits on the outer edge, let it stick out a few pixels past the part behind, so no seam runs along the silhouette.
   - **Face**: eyes, smile, a glint on anything glassy, and two or three highlight bars at most.

4. **Line it up.** Open the drawing with `?over=0.5`. The picture lies over your shapes in red: a red rim is shape the picture doesn't have; grey with no red is picture your shapes miss. Nudge the numbers until it's close. It doesn't have to be exact.

5. **Render**:

   ```sh
   tools/wibblet-art/render.sh items/<agent>/art/<drawing>.html
   ```

   It writes `body.png` and `face.png` beside the drawing and prints the `aspect`. Needs Chrome.

6. **Look at it the way Wibble will draw it.** Open `tools/wibblet-art/preview.html?art=../../items/<agent>/art`. It shows your wibblet next to Director's in three colours, at four sizes, on light and dark. Check it reads at 28px and the seams show on both backgrounds.

7. **List it.** Commit the drawing, the picture and the two PNGs, and push. Then point the entry's `ref` at that commit, add `art`, and bump the `version` with a `history` line (see [CONTRIBUTING.md](CONTRIBUTING.md)).

A wide object makes a wide wibblet: at Wibble's usual 44px height, the camcorder (aspect 1.6) takes 71px of width where Director (0.9) takes 40. That's fine. If it looks too big beside the others, make the object chunkier.
