# Make a pin

A pin is a card on the canvas: a note, a checklist, a countdown. It can draw its card and remember what was typed into it, and that's all. That's why adding one takes one click.

## The files

```
wibble.json   what it is
main.js       the code, plain JavaScript, no build step
```

`wibble.json`:

```json
{
  "id": "rubber-duck",
  "name": "Rubber duck",
  "description": "A card that is a text box and nothing else.",
  "version": "1.0.0",
  "author": "your-github-name",
  "main": "main.js",
  "api": 1,
  "kind": "pin",
  "capabilities": ["pin.create", "storage"]
}
```

`kind: "pin"` with exactly those two capabilities. A pin that asks for more isn't offered as a pin.

A card is built from parts: `text`, `heading`, `row`, `list`, `stack`, `chip`, `button`, `field`, `check`, `bar` and a few more. Make it once with `wibble.pin.create`, then change it with `wibble.pin.update` rather than making another.

## Start from a copy

[wibble-template-pin](https://github.com/idayley/wibble-template-pin) → **Use this template**. It's a working Rubber duck with `wibble.d.ts` beside it for autocomplete.

## Try it

**Settings → Engines → Extensions → Choose folder**, and pick your folder. Its card appears on the canvas of the work item you have open.

On the shelf, people see your pin running before they add it, in a preview that keeps nothing they type.

## Put it on the shelf

See [CONTRIBUTING.md](CONTRIBUTING.md).
