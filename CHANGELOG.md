# Changelog

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
