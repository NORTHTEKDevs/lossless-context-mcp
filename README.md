# lossless-context-mcp

[![CI](https://github.com/NORTHTEKDevs/lossless-context-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/NORTHTEKDevs/lossless-context-mcp/actions/workflows/ci.yml)

An MCP server that **cuts the tokens agents spend re-reading files — without sacrificing quality.**

On a realistic edit-loop coding workload it cuts file-read tokens **~72%**, measured with a real tokenizer, while staying **provably lossless**: across every read, what the model could reconstruct equalled the true file byte-for-byte (0 violations). On a read-once session it saves ~0% — the honest floor. Reproduce both with `npm run bench`.

> Savings come from re-read and edit-loop traffic, which dominates long agentic sessions. First-contact reads of new files are **not** reduced (and shouldn't be).

## Why it doesn't hurt quality

Every other "send less" trick (slicing, summarizing, compressing) risks eliding something the model needed. This one is different: **it only ever withholds or diffs content it can prove the model still has.** The proof is bounded by *context epochs*.

- First read of a file/view → **full content**.
- Re-read of an **unchanged** view (same epoch) → a tiny *"reuse what you have"* marker.
- Re-read of a **changed** view (same epoch) → a **unified diff** to apply to the copy you already have — never the whole thing again.
- When Claude Code **compacts** (the lossy event that drops file bodies from context), a bundled `PreCompact` hook bumps the epoch → the server forgets what it "sent" and returns **full content** again.

So anything it elides is reconstructable from what it already sent *this epoch*. If it can't prove that, it sends the whole thing. There's also a `force_full` flag for when you want the full body regardless.

The test suite encodes this as a hard invariant: a 400-op randomized sequence (read / edit / re-read / compact) asserts the model's reconstructed view equals truth after **every** operation.

## Install

```bash
npm i -g lossless-context-mcp        # or: npx lossless-context-mcp
claude mcp add lossless-context --scope user -- lossless-context-mcp
```

Wire the epoch hook so savings stay lossless across compactions. In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node <path>/hooks/reset-epoch.mjs" }] }],
    "PreCompact":   [{ "hooks": [{ "type": "command", "command": "node <path>/hooks/reset-epoch.mjs" }] }]
  }
}
```

Then tell Claude to prefer it (in `CLAUDE.md`): *"Prefer the `read_file` tool from lossless-context for reading files; when it returns a diff, apply it to your prior copy; when it says unchanged, reuse what you have."*

## Tools

| Tool | What it does |
|------|--------------|
| `read_file(path, symbol?, lines?, force_full?)` | Lossless read: full / unchanged-marker / diff. Optionally read just one `symbol` (function/class by name) or a `lines:"40-90"` range — each view dedups independently. Refuses binary files. |
| `outline(path)` | Cheap structural map (declaration lines, bodies elided) to navigate a big file before reading parts of it. |
| `lossless_stats()` | This session's real token savings (baseline vs sent, % saved), counted with a real tokenizer. |

## How it's measured

`npm run bench` replays scripted agent workloads (an **edit-loop** ceiling and a **read-once** floor) two ways and counts tokens with `gpt-tokenizer`: **baseline** = the full content on every read vs **lossless** = what this server returns. It also reconstructs the model's view and fails if it ever diverges from truth. The savings ratio is tokenizer-agnostic; absolute Anthropic token counts differ slightly but the ratio holds.

## Honest limits

- Savings depend on workload: heavy on re-read/edit sessions, ~0 on read-once sessions.
- It relies on the model applying a unified diff to its prior copy. That's bounded (only when the base is provably present this epoch) and escapable (`force_full`), but it is a behavioral dependency.
- Symbol extraction is a heuristic brace/indent pass — robust and dependency-free, but not a full parser. Precise tree-sitter symbol extraction was evaluated and **deferred** for v1.0: `web-tree-sitter` had ABI/API mismatches with prebuilt WASM grammars across minor versions — too fragile for a production dependency. Tracked for v1.1 once a stable grammar toolchain is pinned.

## Status

**v1.0.0** — `npm run build` clean, `npm test` green (engine losslessness invariant + symbol/line slicing), benchmark lossless across scenarios, over-the-wire stdio smoke passes. MIT.
