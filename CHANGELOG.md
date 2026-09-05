# Changelog

## 2.0.2 - subagent edits read their own transcript

Fixes every subagent Edit being denied as never-seen (observed 2026-09-04 across three
implementer subagents and a two-tool Read-then-Edit probe).

- **Subagent transcripts are resolved from `agent_id`.** Claude Code fires PreToolUse for a
  subagent's tool call with the PARENT session's `transcript_path` plus an `agent_id`; the
  agent's own Read results are written to `<transcript dir>/<session id>/subagents/agent-<agent_id>.jsonl`.
  The hook scanned only the parent transcript, so no subagent Read was ever marked seen.
  `agentTranscriptPath()` now derives the agent file and the hook scans that instead.
- **Seen-state is per logical agent.** `guardStateKey(sessionId, agentId)` gives each subagent
  its own state file under the parent session: a subagent's context window holds neither the
  parent's Reads nor its siblings', so none of them may vouch for its edits.
- **Fail-open when the layout changes.** If the derived agent transcript does not exist the
  guard allows the edit rather than denying every subagent edit again.

## 2.0.1 - per-transcript guard cursors

Fixes a guard false-deny that only appeared with concurrent subagents.

- **Guard state keys its byte cursor by transcript path.** A session has more than one
  transcript: Claude Code gives every subagent its own file while keeping the parent's
  `session_id`. The single scalar `offset` in guard state was applied to all of them, so
  a parent cursor past a subagent transcript's size hit `readNewLines`' truncated/rotated
  branch, returned zero lines, and left that agent's `Read` calls unrecorded. The guard
  then denied edits to files the agent had just read, with the file unchanged on disk.
  Observed with a 1,073,989-byte parent cursor against a 133,728-byte agent transcript
  during a six-agent parallel wave. Offsets are capped at 256 entries
  (`LOSSLESS_GUARD_OFFSETS_CAP`); an unknown transcript starts at 0, because a re-parse is
  merely slow while starting past the end is silently wrong. The legacy scalar still
  loads and is no longer read, so existing state files upgrade cleanly.
- **`LOSSLESS_RENDER_HEAD` escapes its em dash.** A text-sanitising hook rewrote that
  byte inside the regex literal and broke two wire-format tests. Behaviour is identical;
  the byte is now unreachable by a text rewriter.

## 2.0.0 - the coordination plane

No breaking changes; the major marks the capability-class change: the flight recorder
becomes ACTIVE coordination infrastructure for concurrent agents on one machine.

- **Presence plane** (`~/.lossless-context/presence/`, one file per agent process, no
  daemon, no locks): guard-allowed edits publish an intent BEFORE executing; landed
  guarded-tool edits (parsed from transcript results) publish afterward. Self-pruning,
  bounded, atomic writes.
- **Cross-agent conflict denial**, layered under the single-session rules and equally
  fail-open: (C2) another process - including a sibling subagent of the same session - 
  has an edit in flight on this file (< LOSSLESS_COORD_INTENT_SECS, default 90s);
  (C1) another session's landed edit postdates your hashless last contact. Both denials
  name the culprit session and age; drift denials gain the same attribution.
- **`coordination_status`** - the radar: visible sessions, edit activity, cross-session
  and in-flight files.
- `LOSSLESS_COORD=off` disables coordination independently of the guard. Honest limits
  documented: advisory, hook-less sessions invisible, same-second races possible.
- Tests 103 → 114; smoke simulates a two-process conflict end-to-end (in-flight deny +
  landed-edit deny, culprit named, radar renders both sessions).

## 1.4.0 - init, the blind-edit guard, and context blame

- **`lossless-context-mcp init`** - one-command hook installation into
  `~/.claude/settings.json`: idempotent (upgrades update paths, never duplicate), backs
  up first, fails closed on unparseable settings, never touches hooks that aren't its
  own. `--dry-run` previews. This replaces the hand-edited settings block as the
  documented install path.
- **Blind-edit guard** (`hooks/guard-edit.mjs`, PreToolUse `Edit|Write|MultiEdit`) - 
  denies, with a re-read instruction the model sees, (a) edits to files not read in the
  CURRENT context epoch (the post-compaction guess-edit class) and (b) edits whose
  on-disk content hash differs from the version the model read (the stale-base class).
  Incremental transcript indexing from a persisted byte offset; strictly fail-open
  (any doubt → allow); `LOSSLESS_GUARD=off` to disable.
- **Context blame** (`context_blame` tool + `lossless-context-mcp blame <path>` CLI) - 
  per-file version timeline (SHA-256, git blob SHA-1, first/last seen, sources,
  sessions) plus co-context around a focus moment, from the archive.
- Tests 75 → 98; wire smoke extended with the guard deny→read→allow loop, blame
  tool+CLI, and init dry-run.

## 1.3.0 - the flight recorder

The product transformation: from "context ledger with marginal dedup" to **the flight
recorder for your agent's context** - one persistent archive, three views.

- **Persistent archive** (`~/.lossless-context/archive`): content-addressed blobs +
  append-only event logs of every file version shown, fed by both MCP reads and
  transcript sweeps. Multi-process safe without locks; 512 MiB LRU cap; secret-pattern
  deny list (`.env*`, keys, `.ssh`/`.aws`, credentials, + `LOSSLESS_ARCHIVE_EXCLUDE`)
  keeps sensitive content out by construction.
- **Restore**: `hooks/sweep-transcript.mjs` (PreCompact/SessionEnd) archives the session
  working set - including native Read/Edit activity - and writes a ranked manifest;
  `hooks/inject-manifest.mjs` (SessionStart, `compact` matcher) injects it into the fresh
  context; new `restore_context` re-emits the working set budget-capped and
  change-annotated; new `working_set` shows the recorder's view with staleness.
- **Packs**: new `export_pack` renders stable hot files (ranked across sessions from
  archive history) as one deterministic block for a custom agent-type system prompt, so
  fan-out siblings hit the prompt cache instead of re-reading (46.55% cheaper on a real
  measured fan-out; per-task injection measured worse - the tool says which).
- **Receipts v2**: git binding (per-version git blob SHA-1; repo HEAD at issue time),
  explicit `coverage` block (honest scope: mediated paths only), optional
  `include_sweep` attestation of native-tool reads. v1 receipts still verify.
  `stableStringify` now mirrors JSON.stringify's undefined semantics so signatures
  always survive the client round-trip.
- Transcript parsing is two-tier and fail-silent by design (the format is internal to
  Claude Code): stable-surface path discovery + best-effort exact-version capture.
- Tests 40 → 71; wire smoke extended to the full sweep → inject → restore → pack →
  receipt-v2 loop; real-transcript validation (14 MB, 1,576 lines, 361 ms, 45 files).

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

- **Path keys are case-sensitive on case-sensitive filesystems** - `normalizeKey` lowercased every path unconditionally, so on Linux/mac (case-sensitive filesystems) two distinct files differing only in case (e.g. `/a/File.ts` vs `/a/file.ts`) collided into one ledger entry, corrupting dedup/diff bases. Now lowercases only on `win32`.
- **Concurrent-session guard for shared process state** - `engine`/`meter`/epoch are process-wide singletons, safe only because this stdio server is one-client-per-process (the MCP SDK's `connect()` throws on a second transport, and stdio never populates a session id). Added `SingleSessionGuard` to fail loudly with a clear message if that invariant is ever violated, instead of silently cross-contaminating state.
- **Receipt canonicalization signature collision (security fix)** - `buildContextReceipt` grouped file attestations with `path + '::' + view`, an unescaped delimiter join: `path="dir::sub", view="full"` and `path="dir", view="sub::full"` concatenated to the same key, silently merging two distinct files into one attestation. This let two semantically different context receipts (e.g. two different files read once each vs. one file read twice) sign identically under the old key. Fixed by JSON-encoding `[path, view]` as the grouping key. `verifyReceipt` is unchanged and continues to check a stored receipt+signature pair as-is, so already-issued receipts still verify - the break is narrower and specific: re-deriving a NEW receipt from an event log that contains a colliding `path`/`view` pair (one containing literal `::`) now produces a different (correct) receipt, and its signature will not match one generated pre-1.2.1 from the same log. Treat any pre-1.2.1 receipt whose underlying paths/views could contain `::` as unverified and re-issue it.

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

- **SHA-256** change detection (was FNV-1a) - the unchanged-path can no longer serve stale
  content via a hash collision; "provably lossless" is now literal, not probabilistic. (M3)
- **String/comment-aware symbol slicing** - `findSymbol` masks string/comment contents before
  brace-matching, fixing silently-truncated slices for code with `{`/`}` in literals. (M2)
- **Diff/marker self-check** - diff and unchanged results now tell the model to `force_full`
  if it no longer holds the prior version, closing the silent-failure gap if the PreCompact
  hook doesn't fire. (M1)
- **Bounded-memory ledger** - FIFO eviction under a byte budget (`LOSSLESS_LEDGER_BYTES`,
  default 64 MiB). (M4)
- **Benchmark relabeled synthetic**; README notes real-session measurement is pending. (M5)
- **Full error-path coverage** - smoke now exercises binary refuse, bad args, missing symbol,
  missing file, and oversize over the wire. (M6)
- Fixed `serverInfo.version` drift (reported 0.1.0); stderr operational logging on read errors.

## 1.0.0

First production release.

- **Lossless engine** - full / unchanged-marker / unified-diff per file *view*, bounded by
  context epochs (SessionStart/PreCompact hooks). Only ever withholds/diffs content it can
  prove the model still has; sends full content otherwise.
- **Slice reads** - `read_file(path, { symbol })` (heuristic brace/indent extraction) and
  `read_file(path, { lines: "a-b" })`. Each view dedups/diffs independently.
- **Binary/non-UTF-8 guard** - refuses non-text files and points to the native Read tool.
- **`outline(path)`** structural map; **`lossless_stats()`** real-token accounting.
- **Benchmark** - bracketed range: read-once floor ~0% → edit-heavy ceiling ~72%, lossless
  in every scenario (`npm run bench`).
- **Tests** - engine losslessness invariant (400-op randomized) + symbol/line slicing.
- CI (build/test/bench/smoke), MIT.

Tree-sitter-precise symbol extraction was evaluated and deferred: `web-tree-sitter` had an
ABI/API mismatch with prebuilt WASM grammars across minor versions - too fragile for a
production dependency. The parser-free brace/indent extractor ships instead; precise parsing
is a tracked v1.1 item once a stable grammar toolchain is pinned.

## 0.1.0

Initial engine + benchmark proof (72.3% on the edit-loop workload, 0 reconstruction violations).
