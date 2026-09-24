# Make an agent

An agent is a Markdown file: a few lines saying what it is and what it may use, then its instructions. Adding one from the shelf puts it in `~/.claude/agents/`, so it shows up in Wibble's agents, on the ranch and in Claude Code.

## The file

```markdown
---
name: spec-checker
description: Reads a diff against its spec and lists where they disagree.
tools: Read, Grep, Glob
model: opus
---

You check work against its spec. You don't change anything.
...
```

- `description`: when to use it. People read this first.
- `tools`: comma-separated. Leave the line out for every tool. Ask for what it needs; `Bash` and `Edit` are the ones people look at twice.
- `model`: `opus`, `sonnet` or `haiku`, or leave it out to let the engine choose.
- Below the second `---`: its instructions.

Before anyone adds it, Wibble shows the engine, model and tools **read from your file**, not from the shelf's description. If the two disagree, it shows both.

## Start from a copy

[wibble-template-agent](https://github.com/idayley/wibble-template-agent) → **Use this template**.

## Try it

Copy the file to `~/.claude/agents/<your-agent>.md`. It shows up in Wibble and in Claude Code straight away.

## Put it on the shelf

See [CONTRIBUTING.md](CONTRIBUTING.md). The entry's `path` is your file's name, e.g. `"path": "agent.md"`.

Optional: give it its own look with two PNG masks, a body and a face, listed as `"art": { "body": "art/body.png", "face": "art/face.png", "aspect": 0.85 }`. Only the shape comes from them; the colour is Wibble's.
