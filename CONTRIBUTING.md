# Getting something on the shelf

Start with the guide for what you're making: [an extension](make-an-extension.md), [a pin](make-a-pin.md), [an agent](make-an-agent.md) or [a toy](make-a-toy.md).

Then, four steps:

1. **Push your repo to GitHub.** It has to be public, because Wibble downloads it without signing in.
2. **Copy the full commit hash** of the version you want listed: `git rev-parse HEAD`, all 40 characters. A branch or tag name won't do, because those can change after it's been reviewed.
3. **Add one entry** to the end of `items` in `wibble-marketplace.json`:

   ```json
   {
     "kind": "extension",
     "id": "token-budget",
     "name": "Token budget",
     "repo": "https://github.com/you/wibble-token-budget",
     "ref": "the 40-character hash",
     "path": ".",
     "version": "1.0.0",
     "description": "One sentence people see on the tile."
   }
   ```

   `kind` is `extension`, `pin`, `agent` or `toy`. `path` is `"."` for an extension or pin in the repo's root, or the file for an agent or toy. For an extension or pin, `id` and `version` must match your `wibble.json`.

4. **Open a pull request.**

A check runs on the pull request: it fetches your commit and runs the same rules Wibble uses when someone clicks Add, then lists what people will be told about your item. Fix anything it marks ✗.

The shelf's owner reads the code at that exact commit before merging. Nothing you push later reaches anyone until it's listed.

## Updating

The same pull request again: a new `ref` and a new `version`. Add a line to `history` saying what changed. People see it as **Update available**, with any new permission shown before they update:

```json
"history": [
  { "version": "1.1.0", "date": "2 Oct", "note": "Keeps the last failing run in a panel." },
  { "version": "1.0.0", "date": "19 Sep", "note": "First version." }
]
```

## Optional extras

- `screenshot.png` beside `wibble.json` is shown on the item's page (up to 2 MB).
- An agent can have its own look: see [Make an agent](make-an-agent.md).
