# lossless-context-mcp

[![CI](https://github.com/NORTHTEKDevs/lossless-context-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/NORTHTEKDevs/lossless-context-mcp/actions/workflows/ci.yml)

**The flight recorder for your agent's context.** A persistent, hook-fed ledger of every
file version your coding agent was shown — so a compaction can't destroy the working set,
a subagent fleet doesn't pay for the same files N times, and you can *prove* afterward
exactly what the model saw.

```
                      ┌──────────────────────┐
  ledger reads ──────▶│                      │──▶ RESTORE   working set survives /compact
  (read_file, MCP)    │   flight recorder    │──▶ PACKS     one cache-cached prefix for a fan-out fleet
  transcript sweeps ─▶│  (content-addressed  │──▶ RECEIPTS  signed, git-bound "what did it see"
  (native Read/Edit)  │   archive on disk)   │──▶ METERING  where the read tokens went, in dollars
                      └──────────────────────┘
```

## 1. Restore: compaction can't destroy your working set anymore

When Claude Code compacts, roughly two-thirds of a typical context is tool output —
mostly file contents — and compaction discards it permanently. The model then flails:
re-reading files it half-remembers, or worse, guessing at contents it no longer has
([#27242](https://github.com/anthropics/claude-code/issues/27242) is the ask, at 80 👍).

The flight recorder closes the loop automatically:

1. **PreCompact** — the sweep hook parses the session transcript and archives every file
   the session touched (native `Read`/`Edit`/`Write` included, not just MCP reads), then
   writes a ranked working-set manifest. Fast enough to sit on the compaction path — one
   real 14 MB transcript swept in 361 ms; measure yours:
   `node bench/sweep-bench.mjs <transcript.jsonl>`.
2. **SessionStart(compact)** — the inject hook puts a compact manifest back into the
   fresh context: *"your working set was these 12 files (edited ones first); restore any
   of them instead of guessing."*
3. **`restore_context`** — re-emits the working set from current disk state,
   budget-capped, annotating any file that changed since the model last saw it.

Cross-*session* memory tools (claude-mem and friends) summarize what happened for the
next session. This is the complementary, mid-session layer: **file-version-exact recovery
of what you were just working on.**

## 2. Packs: stop paying for the same files in every subagent

Fan-outs are where token waste actually lives. Measured across 195 real multi-agent runs:
**19.6% of all subagent `Read` tokens were duplicate reads of identical content by sibling
agents** (5.18M of 26.4M tokens) — every sibling starts cold and reads the same CLAUDE.md,
the same spec, the same core modules.

`export_pack` ranks the archive's cross-session read history for stable hot files and
renders them as one deterministic block for a custom agent-type's **system prompt**. The
block is a stable prefix, so the whole fleet hits the provider prompt cache on it. On a
real review fan-out this measured **46.55% cheaper** than baseline — and the same pack
injected per-task measured 19.6% *worse* (every sibling cache-writes it), which is why
the tool tells you where to put it. Both numbers were measured externally on one real
corpus, not by a harness in this repo — exact figures, method, and that caveat are in
[BENCHMARK.md](./BENCHMARK.md). Generate the pack once per run and embed it verbatim:
ranking follows live read history, so repeated `export_pack` calls can differ.

## 3. Receipts: prove what the model saw, bound to git

Observability vendors capture what your agent read into mutable trace stores. Nobody
signs it or binds it to repo identity — and agent self-reports are not evidence (ask
anyone whose agent claimed it "verified" something it never read).

`context_receipt` issues an HMAC-SHA256-signed attestation: every file/view shown, the
SHA-256 of every content version, **the git blob SHA-1 of each version** (so any verifier
with a clone can check `git cat-file -e <sha1>` — was this ever committed?), **repo HEAD
at issue time**, delivery kinds, token totals, and an explicit `coverage` statement of
which capture paths it attests (`mcp`, and `transcript-sweep` with `include_sweep`). By
default it signs with the same key file as trust-mcp receipts, so one key verifies a full
evidence chain: *what the agent saw + what it did*.

**The honest scope**: a receipt attests what passed through the ledger and sweeps — it
never claims coverage of unmediated paths, and says so in its own `coverage.note`.

## 4. Metering (and the token-saver reality check)

`context_stats` shows where the session's file-read tokens went — per repo, per file, in
dollars, counted with a real tokenizer.

> **Reality check, kept from earlier versions because it's true:** as an intra-session
> token saver this measures **~0%** on real Claude Code transcripts (+0.4% with the
> never-lose engine; the native file-state cache already ate the opportunity — full data
> in [BENCHMARK.md](./BENCHMARK.md)). The savings that DO exist are cross-agent (packs,
> above). Read-path dedup remains because it is provably lossless and never negative —
> not because it will save you much on its own.

## Install

```bash
npm i -g lossless-context-mcp
claude mcp add lossless-context --scope user -- lossless-context-mcp
```

Wire the flight-recorder hooks in `~/.claude/settings.json` (`npm root -g` shows the
install root; on Windows use forward slashes):

```json
{
  "hooks": {
    "PreCompact": [
      { "hooks": [{ "type": "command", "command": "node <global-root>/lossless-context-mcp/hooks/sweep-transcript.mjs" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node <global-root>/lossless-context-mcp/hooks/sweep-transcript.mjs" }] }
    ],
    "SessionStart": [
      { "matcher": "compact", "hooks": [{ "type": "command", "command": "node <global-root>/lossless-context-mcp/hooks/inject-manifest.mjs" }] },
      { "hooks": [{ "type": "command", "command": "node <global-root>/lossless-context-mcp/hooks/reset-epoch.mjs" }] }
    ]
  }
}
```

- `sweep-transcript.mjs` (PreCompact + SessionEnd) — captures the working set + exact
  versions; bumps the dedup epoch on PreCompact; never blocks compaction.
- `inject-manifest.mjs` (SessionStart, matcher `compact`; add `resume` if wanted) —
  injects the recovered working-set manifest.
- `reset-epoch.mjs` (SessionStart, no matcher) — keeps read dedup lossless across new
  sessions.

Without the hooks everything still works — you just lose automatic capture of native-tool
activity and post-compaction injection; the ledger then records MCP reads only.

## Tools

| Tool | What it does |
|------|--------------|
| `read_file(path, symbol?, lines?, force_full?)` | Lossless read: full / unchanged-marker / diff. Optional single-`symbol` or `lines:"40-90"` views. Refuses binary files. |
| `read_files(paths[], force_full?)` | A working set in one call; per-file errors don't fail the batch. |
| `working_set(limit?)` | Heat-ranked table of what the recorder knows this session (+ last 24h), with staleness vs disk. |
| `restore_context(files?, budget_tokens?)` | Re-emit the working set after compaction — manifest top-K by default, budget-capped, change-annotated. |
| `export_pack(repo?, top?, budget_tokens?, days?)` | Deterministic fan-out context pack from cross-session read history, for an agent-type system prompt. |
| `outline(path)` | Cheap structural map of a file (declarations only). |
| `context_stats()` | Token/dollar breakdown of this session's reads. |
| `context_receipt(artifact, include_sweep?)` | Signed, git-bound context receipt with explicit coverage. |
| `verify_context_receipt(receipt, signature)` | Timing-safe, canonicalized verification. |

## Privacy & storage

The archive lives at `~/.lossless-context/archive` (override: `LOSSLESS_CONTEXT_DIR`),
content-addressed, capped at 512 MiB (`LOSSLESS_ARCHIVE_BYTES`) with LRU eviction; event
logs age out after 30 days (`LOSSLESS_EVENTS_DAYS`). **Nothing ever leaves your machine.**
Files matching secret patterns (`.env*`, keys/certs, `.ssh`/`.aws` paths, credentials —
plus your own `LOSSLESS_ARCHIVE_EXCLUDE` globs) are *never* stored — the check covers
both the requested path and its resolved real path, so a symlink to a secret doesn't
bypass it. For excluded files only the path, touch counts, and timestamps are recorded
(no content, and no content-derived metadata like hashes or sizes, which could enable
offline confirmation of low-entropy secrets).

## Why the read path can't hurt quality

The engine only withholds or diffs content it can **prove** the model still has, bounded
by context epochs (the hooks bump the epoch on compaction, so post-compaction reads are
always full). A 400-op randomized invariant test asserts the model's reconstructable view
equals disk truth after every operation. Anything less provable is sent in full.

## Honest limits

- Restore serves **current disk state** (annotated when it drifted), not a time machine
  of the conversation; exact historical versions live in the archive for receipts.
- The transcript format is internal to Claude Code and can change; the sweep is
  deliberately two-tier (stable-surface discovery + best-effort exact capture) and
  fail-silent — a format change degrades capture, never breaks a session.
- Receipts attest mediated paths only, and say so; they are HMAC (shared-key), not
  third-party-verifiable signatures — Ed25519 receipts are a candidate for a future
  version if anyone needs them.
- Pack effectiveness assumes provider prompt caching and a stable prefix; the 46.55%
  figure is one measured workload, not a promise.
- Symbol extraction is a heuristic brace/indent pass, not a parser (tree-sitter was
  evaluated and deferred for WASM/ABI fragility).

## Status

**v1.3.0** — the flight recorder: persistent content-addressed archive, transcript sweep
+ manifest inject hooks, `working_set` / `restore_context` / `export_pack`, receipts v2
(git blob SHA-1 + repo HEAD binding, coverage disclosure, sweep attestation). 71 tests
green including the losslessness invariant; over-the-wire smoke covers the full
sweep → inject → restore loop; real-transcript sweep validated (14 MB in 361 ms). MIT.
