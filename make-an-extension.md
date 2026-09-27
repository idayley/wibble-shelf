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
| `context.trim` | remove old tool output from what your agents send. It sees each result's tool and file or command, the start of new results, your latest message and recent replies; it can't add or change anything. At most one enabled extension can hold it |
| `net.fetch` | reach the hosts your manifest's `hosts` list names, and nowhere else |

Without `net.fetch` it can't reach the internet at all, and it can't open your files either way. Ask for only what you use.

`net.fetch` also needs a `hosts` array in `wibble.json`, one `"host:port"` per address it's allowed to reach:

```json
"capabilities": ["net.fetch"],
"hosts": ["127.0.0.1:8791"]
```

## The API, capability by capability

Most capabilities are self-explanatory from the table above — see `wibble.d.ts` in the template for their exact shapes. Two are worth spelling out, because getting the call wrong fails loudly rather than quietly:

**`context.trim`** — `wibble.trim`:

```ts
wibble.trim.onSeen(fn): () => void   // fn gets a per-call report: { sessionId, thread, calls, items: [...] }; call the return value to unsubscribe
wibble.trim.onResult(fn): () => void // fn gets a per-request report after usage is known: { sessionId, thread, usage, removedChars, totalChars, sentChars?, ... }
wibble.trim.drop(sessionId, ids): Promise<void> // leaves these tool-output ids out of every later request in that session
```

`totalChars` is the messages (or `input`) array alone, as sent. `sentChars`, on Wibbles that report it, is the whole request body as sent, system prompt and tool definitions included: divide the usage's prompt tokens by `sentChars`, not `totalChars`, for tokens per char.

**`net.fetch`** — `wibble.net.fetch`:

```ts
wibble.net.fetch(url, { method, headers, body }): Promise<{ status: number; headers: object; body: string }>
```

- Only reaches a `host:port` your `hosts` list names; anything else is refused before it leaves your machine.
- `http`/`https` only, `GET`/`POST`/`PUT`/`PATCH`/`DELETE` only.
- `Host`, `Cookie`, `Content-Length`, `Transfer-Encoding` and `Connection` headers are never forwarded, and no redirect is followed.
- Request body capped at 1 MiB; a 10 s connect timeout and a 60 s read timeout.
- No extension has the worker's own `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `Worker` — with `net.fetch` granted, `wibble.net.fetch` is the only way out at all.

## Start from a copy

[wibble-template-extension](https://github.com/idayley/wibble-template-extension) → **Use this template**. It's a working Token budget panel with `wibble.d.ts` beside it, so your editor autocompletes the whole API. That file is the reference for every event and panel part.

## Try it

**Settings → Engines → Extensions → Choose folder**, and pick your folder. Saving a file reloads it, and what it stored survives the reload.

## Put it on the shelf

See [CONTRIBUTING.md](CONTRIBUTING.md). Updating later is the same pull request with a new commit and version.
