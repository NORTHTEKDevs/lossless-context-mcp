# lossless-context-mcp

An MCP server that **drastically cuts the tokens agents spend re-reading files — without sacrificing quality.**

On a realistic edit-loop coding workload it cut file-read tokens **72.3%** (319,396 → 88,536, measured with a real tokenizer) while staying **provably lossless**: across all 46 reads, what the model could reconstruct equalled the true file byte-for-byte, 0 violations. Reproduce with `npm run bench`.

> Savings scale with how much an agent re-reads/edits files in a session. First-contact reads of new files are **not** reduced (and shouldn't be) — the win is the re-read and edit-loop traffic, which dominates long agentic sessions.

## Why it doesn't hurt quality

Every other "send less" trick (slicing, summarizing, compressing) risks eliding something the model needed. This one is different: **it only ever withholds or diffs content it can prove the model still has.** The proof is bounded by *context epochs*.

- First read of a file → **full content**.
- Re-read of an **unchanged** file (same epoch) → a tiny *"reuse what you have"* marker.
- Re-read of a **changed** file (same epoch) → a **unified diff** to apply to the copy you already have — never the whole file again.
- When Claude Code **compacts** (the lossy event that drops file bodies from context), a bundled `PreCompact` hook bumps the epoch → the server forgets what it "sent" and returns **full content** again.

So anything it elides is reconstructable from what it already sent *this epoch*. If it can't prove that, it sends the whole file. There's also a `force_full` flag on every read for when you want the full body regardless.

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
| `read_file(path, force_full?)` | Lossless read: full / unchanged-marker / diff as described above. |
| `outline(path)` | Cheap structural map (declaration lines, bodies elided) to navigate a big file before reading parts of it. |
| `lossless_stats()` | This session's real token savings (baseline vs sent, % saved), counted with a real tokenizer. |

## How it's measured

`npm run bench` replays a scripted agent workload (explore → edit/reread loop → compaction → continue) two ways and counts tokens with `gpt-tokenizer`: **baseline** = the full file on every read (what the native Read tool injects) vs **lossless** = what this server returns. It also reconstructs the model's view and fails if it ever diverges from truth. The savings ratio is tokenizer-agnostic; absolute Anthropic token counts differ slightly but the ratio holds.

## Honest limits

- Savings depend on workload: heavy on re-read/edit sessions, ~0 on read-once sessions.
- It relies on the model applying a unified diff to its prior copy. That's bounded (only when the base is provably present this epoch) and escapable (`force_full`), but it is a behavioral dependency.
- `outline` is a heuristic regex pass in v1; precise tree-sitter symbol extraction (and symbol/range slice reads) are planned for v1.1.

## Status

v0.1.0 — `npm run build` clean, `npm test` 5/5 (incl. the randomized losslessness invariant), benchmark 72.3% lossless. MIT.
