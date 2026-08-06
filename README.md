# lossless-context-mcp

[![CI](https://github.com/NORTHTEKDevs/lossless-context-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/NORTHTEKDevs/lossless-context-mcp/actions/workflows/ci.yml)

A **context ledger** for agent file reads: provably-lossless dedup of re-reads, per-repo token metering with dollar costs, and **HMAC-signed receipts of exactly which file versions the model was shown**.

> ## Reality check: as a token saver, on real sessions this saves ~0%
> Measured over **1,839 real Claude Code transcripts (16,823 `Read` calls, 64 MB)** with the bundled
> `bench/real-session.ts` harness: **−1.4% with a real tokenizer** (i.e. slightly *worse* than baseline),
> because only **7–8%** of reads are re-reads and the median session re-reads **0%** of its files. Claude
> Code's native file-state cache already avoids redundant re-reads, so there is almost nothing left for this
> to save, and on changed re-reads a unified diff can be larger than the file. **It is not a token-savings
> product for normal use.** Reproduce: `npx tsx bench/real-session.ts`.
>
> Re-measured 2026-08-06 on a grown corpus (**3,363 transcripts, 26,041 reads, 116 MB**): **−2.6%**,
> losslessness clean. The computed ceiling for *any* naive intra-session read-dedup tool on that corpus
> is about **0.2%** — the big re-reads are already gone before any tool sees them.
>
> **v1.2 fixes the economics**: the engine emits whichever is smaller (marker vs content, diff vs
> content), making it structurally unable to cost more than native reads. Same corpus, same day:
> **+0.4%** — almost entirely from large files re-read after small edits, the one dedup win that
> still exists. Small, real, and never negative. The ledger remains the reason this exists.

The earlier **~72%** figure is a **synthetic** edit-loop that re-reads the same files dozens of times — a
ceiling, not a typical workload (see [BENCHMARK.md](./BENCHMARK.md) for the full methodology and range).
The dedup layer still helps the niche workflows that genuinely re-read files many times in one context —
and clients without native file-state caching — but it is not the reason this exists.

## What it is (v1.1): measurement and evidence, not just savings

Token-saving tricks get absorbed by the platforms (the reality check above *is* that story: Claude Code's
native cache already ate the opportunity). What doesn't get absorbed is vendor-neutral **measurement** and
**provenance**. v1.1 builds both on the same ledger that makes reads lossless:

1. **Lossless reads** (`read_file`, `read_files`) — full content on first contact; a tiny reuse-marker or a
   unified diff on re-reads, only when the model provably still holds the base version.
2. **Context metering** (`context_stats`) — where this session's file-read tokens actually went: totals,
   per-repo breakdown, heaviest files, and a USD estimate. Counted with a real tokenizer on exactly what
   was sent. Works identically in any MCP client — Claude Code, Cursor, Cline, custom SDK agents.
3. **Signed context receipts** (`context_receipt` / `verify_context_receipt`) — an auditable, verifiable
   answer to *"what did the AI see when it did this?"*: every file/view shown to the model, the SHA-256 of
   every content version it saw, how each was delivered, token totals — HMAC-SHA256 signed. By default it
   signs with the same key file as [trust-mcp](https://github.com/NORTHTEKDevs) receipts, so one key
   verifies a complete evidence chain: *what the agent saw + what it did*.

## Why the read path doesn't hurt quality

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

Wire the epoch hook so dedup stays lossless across compactions. In `~/.claude/settings.json`:

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
| `read_files(paths[], force_full?)` | Read a working set in one call — each file through the same ledger; per-file errors don't fail the batch. |
| `outline(path)` | Cheap structural map (declaration lines, bodies elided) to navigate a big file before reading parts of it. |
| `context_stats()` | Where this session's file-read tokens went: totals, per-repo breakdown, heaviest files, dedup savings, USD estimate (`LOSSLESS_PRICE_PER_MTOK`, default $3/MTok). |
| `context_receipt(artifact)` | Issue a signed context receipt: every file/view shown, every content hash seen, delivery kinds, token totals. Key: `LOSSLESS_RECEIPT_KEY` or the shared trust key file. |
| `verify_context_receipt(receipt, signature)` | Timing-safe verification; canonicalized, so JSON field order doesn't matter. |

## How it's measured

See **[BENCHMARK.md](./BENCHMARK.md)** — the full methodology, the honest range (0% floor, 72.1%
synthetic ceiling, **−1.4% on 1,839 real sessions**), the losslessness invariant, and how to run the same
harness against your own transcripts or any other context tool.

## Honest limits

- Dedup savings depend on workload: real Claude Code sessions measure ~0% (see reality check); other clients without native file-state caching may see more. Measure yours: `npx tsx bench/real-session.ts`.
- Diffs rely on the model applying a unified diff to its prior copy. That's bounded (only when the base is provably present this epoch) and escapable (`force_full`), but it is a behavioral dependency.
- Receipts attest what **this server** sent the model — reads that bypass it (native `Read`) are not in the receipt. For complete coverage, route file reads through `read_file`/`read_files`.
- Symbol extraction is a heuristic brace/indent pass — robust and dependency-free, but not a full parser. Precise tree-sitter extraction was evaluated and **deferred**: `web-tree-sitter` had ABI/API mismatches with prebuilt WASM grammars across minor versions — too fragile for a production dependency.
- `lossless_stats` was renamed `context_stats` in v1.1.

## Status

**v1.2.0** — the never-lose engine: measured on 3,363 real transcripts, the old always-diff/always-marker behavior cost 2.6% MORE than native reads, so the engine now emits whichever is smaller (marker vs content, diff vs content) and is structurally unable to cost more than baseline. Plus the v1.1.0 ledger: per-repo token metering with USD estimates (`context_stats`), signed context receipts (`context_receipt`/`verify_context_receipt`, HMAC-SHA256, timing-safe verify), batch working-set reads (`read_files`), SHA-256 change detection (provably, not probabilistically, lossless), bounded-memory ledger. `npm run build` clean, `npm test` green (32 tests incl. the 400-op losslessness invariant and two never-lose regressions), over-the-wire stdio smoke passes. MIT.
