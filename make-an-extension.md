# Make an extension

An extension is a small program that watches your work and shows something in Wibble: a panel in the sidebar, under the chat, or across the top of the canvas. It can play a sound, drop cards on the canvas, or run a command you've already approved.

## The files

```
wibble.json   what it is and what it asks for
main.js       the code, plain JavaScript, no build step
```

`wibble.json`:

```json
{
  "id": "token-budget",
  "name": "Token budget",
  "description": "What this session has spent, per agent.",
  "version": "1.0.0",
  "author": "your-github-name",
  "main": "main.js",
  "api": 1,
  "slot": "rail",
  "capabilities": ["stream.read", "panel.render"]
}
```

`slot` is where its panel goes: `sidebar`, `rail` (under the chat) or `top`. `capabilities` is everything it can do, and people see each one in plain words before they add it:

| Ask for | And it can |
|---|---|
| `stream.read` | read what your sessions say and do: messages, tool calls, results, usage |
| `panel.render` | draw a panel in its slot |
| `storage` | keep its own notes between launches |
| `pin.create` | put cards on the canvas |
| `command.run` | run a command the operator has already approved |
| `foley.play` | play one of Wibble's own sounds |
| `protocols.list` | see the names of your skills, agents and rules |

It can't reach the internet or open files. Ask for only what you use.

## Start from a copy

[wibble-template-extension](https://github.com/idayley/wibble-template-extension) → **Use this template**. It's a working Token budget panel with `wibble.d.ts` beside it, so your editor autocompletes the whole API. That file is the reference for every event and panel part.

## Try it

**Settings → Engines → Extensions → Choose folder**, and pick your folder. Saving a file reloads it, and what it stored survives the reload.

## Put it on the shelf

See [CONTRIBUTING.md](CONTRIBUTING.md). Updating later is the same pull request with a new commit and version.
