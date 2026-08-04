# Changelog

## 1.1.0

Context ledger release: per-repo token metering with USD estimates (`context_stats`) and signed read receipts. See the README for the full description.

## 1.0.1

Hardening from the BSHR code-review (R1, score 7.8 → addressed all 6 MEDIUMs):

- **SHA-256** change detection (was FNV-1a) — the unchanged-path can no longer serve stale
  content via a hash collision; "provably lossless" is now literal, not probabilistic. (M3)
- **String/comment-aware symbol slicing** — `findSymbol` masks string/comment contents before
  brace-matching, fixing silently-truncated slices for code with `{`/`}` in literals. (M2)
- **Diff/marker self-check** — diff and unchanged results now tell the model to `force_full`
  if it no longer holds the prior version, closing the silent-failure gap if the PreCompact
  hook doesn't fire. (M1)
- **Bounded-memory ledger** — FIFO eviction under a byte budget (`LOSSLESS_LEDGER_BYTES`,
  default 64 MiB). (M4)
- **Benchmark relabeled synthetic**; README notes real-session measurement is pending. (M5)
- **Full error-path coverage** — smoke now exercises binary refuse, bad args, missing symbol,
  missing file, and oversize over the wire. (M6)
- Fixed `serverInfo.version` drift (reported 0.1.0); stderr operational logging on read errors.

## 1.0.0

First production release.

- **Lossless engine** — full / unchanged-marker / unified-diff per file *view*, bounded by
  context epochs (SessionStart/PreCompact hooks). Only ever withholds/diffs content it can
  prove the model still has; sends full content otherwise.
- **Slice reads** — `read_file(path, { symbol })` (heuristic brace/indent extraction) and
  `read_file(path, { lines: "a-b" })`. Each view dedups/diffs independently.
- **Binary/non-UTF-8 guard** — refuses non-text files and points to the native Read tool.
- **`outline(path)`** structural map; **`lossless_stats()`** real-token accounting.
- **Benchmark** — bracketed range: read-once floor ~0% → edit-heavy ceiling ~72%, lossless
  in every scenario (`npm run bench`).
- **Tests** — engine losslessness invariant (400-op randomized) + symbol/line slicing.
- CI (build/test/bench/smoke), MIT.

Tree-sitter-precise symbol extraction was evaluated and deferred: `web-tree-sitter` had an
ABI/API mismatch with prebuilt WASM grammars across minor versions — too fragile for a
production dependency. The parser-free brace/indent extractor ships instead; precise parsing
is a tracked v1.1 item once a stable grammar toolchain is pinned.

## 0.1.0

Initial engine + benchmark proof (72.3% on the edit-loop workload, 0 reconstruction violations).
