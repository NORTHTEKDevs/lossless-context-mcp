# Changelog

## 1.2.3

Metadata-only: fix `mcpName` case to `io.github.NORTHTEKDevs/lossless-context-mcp` - the MCP Registry matches the GitHub namespace case-sensitively, and npm versions are immutable, so the lowercase value shipped in 1.2.2 could never validate. No code change.

## 1.2.2

Dependency security release, no behavior change:

- `@modelcontextprotocol/sdk` ^1.0.4 -> ^1.30.0 - clears the runtime-scope Dependabot alerts (hono, fast-uri and friends were transitive via the very old SDK pin). This server only uses the stdio transport; the SDK's HTTP-transport dependency tree was never on a code path here, but the alerts are gone regardless.
- `diff` ^7 -> ^8.0.2 - fixes the jsdiff parsePatch/applyPatch DoS advisory (GHSA low). `@types/diff` dropped; v8 ships its own types.
- `zod` ^3.23.8 -> ^3.25.0 (SDK peer range), `vitest` ^2 -> ^3 - clears the dev-only critical advisories.

Verified: 40/40 tests, build clean, over-the-wire smoke PASS. `npm audit` after: 0 critical (remaining findings are transitive inside the SDK's HTTP adapters plus dev-only esbuild).

Also adds MCP Registry metadata: `mcpName` (`io.github.northtekdevs/lossless-context-mcp`) in `package.json`, plus `server.json` and `glama.json` at the repo root.

## 1.2.1

Three bugs found by an effort-routing A/B experiment's reviewers, judge-verified, fixed with regression tests:

- **Path keys are case-sensitive on case-sensitive filesystems** — `normalizeKey` lowercased every path unconditionally, so on Linux/mac (case-sensitive filesystems) two distinct files differing only in case (e.g. `/a/File.ts` vs `/a/file.ts`) collided into one ledger entry, corrupting dedup/diff bases. Now lowercases only on `win32`.
- **Concurrent-session guard for shared process state** — `engine`/`meter`/epoch are process-wide singletons, safe only because this stdio server is one-client-per-process (the MCP SDK's `connect()` throws on a second transport, and stdio never populates a session id). Added `SingleSessionGuard` to fail loudly with a clear message if that invariant is ever violated, instead of silently cross-contaminating state.
- **Receipt canonicalization signature collision (security fix)** — `buildContextReceipt` grouped file attestations with `path + '::' + view`, an unescaped delimiter join: `path="dir::sub", view="full"` and `path="dir", view="sub::full"` concatenated to the same key, silently merging two distinct files into one attestation. This let two semantically different context receipts (e.g. two different files read once each vs. one file read twice) sign identically under the old key. Fixed by JSON-encoding `[path, view]` as the grouping key. `verifyReceipt` is unchanged and continues to check a stored receipt+signature pair as-is, so already-issued receipts still verify — the break is narrower and specific: re-deriving a NEW receipt from an event log that contains a colliding `path`/`view` pair (one containing literal `::`) now produces a different (correct) receipt, and its signature will not match one generated pre-1.2.1 from the same log. Treat any pre-1.2.1 receipt whose underlying paths/views could contain `::` as unverified and re-issue it.

## 1.2.0

The never-lose engine. Replaying 3,363 real transcripts showed the old engine LOST 2.6%:
unified diffs regularly exceed the file they patch, and the unchanged-marker exceeds the
tiny re-reads it replaces. The engine now emits whichever is smaller, always: marker only
when the content is bigger than the marker's wire cost, diff only when the patch is
smaller than the file, full content otherwise. It is now structurally unable to cost more
than native reads. Losslessness invariant unchanged (32 tests, incl. two new never-lose
regressions). BENCHMARK.md carries the before/after replay numbers.

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
