# Design: lossless-context-mcp -> the context flight recorder (v1.3.0)

Date: 2026-08-10. Direction approved by Kristian: "Context flight recorder" - one
persistent, hook-fed ledger with three views (restore, packs, receipts).

## Product thesis (research-backed)

The intra-session dedup value prop is dead (measured ~0.2% ceiling; +0.4% shipped).
Three adjacent needs are real and map onto the primitives this codebase already has:

1. **Restore (headline)** - `/compact` permanently discards the ~68% of context that is
   re-fetchable tool output. Highest-reaction unowned ask on anthropics/claude-code
   (#27242, 80 reactions; #26771, #6390 at 22-24). claude-mem (90k stars) owns
   cross-session narrative memory; nobody owns mid-session working-set recovery at
   file-version granularity. Our ledger already holds (path, view, hash, content).
2. **Packs (measured win)** - 19.6% of subagent Read tokens in the local fan-out corpus
   are duplicate reads across sibling agents. Embedding a stable context pack in an
   agent-type system prompt (prompt-cache breakpoint) was live-proven 46.55% cheaper
   (run wf_b206d4d6, token-efficiency-research phase 3 ab2). No product exists.
3. **Receipts (moat bet)** - 7/7 observability vendors capture file content in traces;
   none hash it, bind it to git identity, or sign it. Langfuse's revealed preference
   (kept audit logs commercial after MIT-ing everything else) marks audit as the moat.
   Honest claim only: "we prove what passed through this ledger", never "everything the
   agent saw" - coverage is disclosed per receipt.

Form-factor law (from adoption data): hook-driven and automatic wins (claude-mem 90k
stars); on-demand tools the model must choose lose (mem0 MCP rank #278). Therefore:
capture and manifest-injection are hooks; tools exist only where the model acts on the
recovered state.

## Architecture

One new persistence layer; existing engine/meter/receipt stay intact.

```
                 +-------------------+
 MCP reads ----->|                   |----> restore_context / working_set (recovery)
 (engine/meter)  |  archive (disk)   |----> export_pack (fleet packs)
 transcript ---->|  content-addressed|----> context_receipt v2 (git-bound, coverage)
 sweep hooks     +-------------------+
```

### archive.ts (new)
- Root: `LOSSLESS_CONTEXT_DIR` (default `~/.lossless-context/`) + `archive/`.
- `blobs/<sha256[0:2]>/<sha256>` - raw file contents, content-addressed, idempotent
  writes (temp + rename; a colliding concurrent write is harmless by construction).
- `events/<writer>.jsonl` - append-only event logs, one file per writer (server pid or
  hook invocation) so no cross-process file contention. Event:
  `{ts, session, path, repo, hash, gitBlobSha1, bytes, tokens, source: 'mcp'|'sweep',
    op: 'read'|'edit'|'write', view}`.
- Size bound `LOSSLESS_ARCHIVE_BYTES` (default 512 MiB), lazy LRU eviction by blob
  mtime, enforced on server start and after sweeps.
- **Secret hygiene**: deny-glob at archive time (`.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `*credential*`, `*secret*`, `*.p12`, `*.pfx`, npm/git tokens files) +
  `LOSSLESS_ARCHIVE_EXCLUDE` for user patterns. Denied files are metered but never
  written to blobs (event carries `excluded: true`).

### Hooks (the automatic layer)
- `hooks/sweep-transcript.mjs` - PreCompact + SessionEnd. Parses the session transcript
  JSONL, extracts native Read results and Edit/Write targets (re-read from disk at
  sweep time), archives blobs + events, then writes
  `sessions/<session_id>.manifest.json`: top-K working-set files ranked by
  heat = reads x recency x edited-bonus, with per-file {path, hash, bytes, tokens,
  reads, lastOp}. K=12 default, manifest render budget ~600 tokens.
- `hooks/inject-manifest.mjs` - SessionStart (source: compact, resume). Loads the
  manifest for this session (fallback: most recent < 24h), emits additionalContext:
  the working-set table + one-line instruction to call `restore_context` (or keep
  using lossless reads). Silent no-op when no manifest exists.
- `hooks/reset-epoch.mjs` - unchanged (epoch bump keeps dedup lossless across
  compaction; recovery is served from archive + disk, never from stale ledger state).
- Exact hook stdin/stdout contracts verified against current docs before
  implementation (open question #1 below).

### New/changed MCP tools
- `working_set {limit?}` - heat-ranked table of what the ledger+archive knows for the
  current session (and last 24h), with token sizes. Read-only, cheap.
- `restore_context {files?, budget_tokens?=25000}` - re-emits requested (default:
  manifest top-K) files from CURRENT disk state through the engine (re-primes ledger),
  annotating files changed since last-seen hash. Stops at budget with a truncation note.
- `export_pack {repo?, top?=8, budget_tokens?=30000, days?=14}` - ranks archive events
  for stable hot files (high cross-session read count, low hash churn), emits a
  deterministic pack block (path + hash + fenced content) ready to embed in a custom
  agent-type system prompt. Docs carry the cache-breakpoint guidance and the measured
  46.55% result with its context.
- `context_receipt {artifact, include_sweep?=false}` - v2 receipt adds per-file
  `gitBlobSha1` (sha1("blob <len>\0" + content) computed at archive time), per-repo
  `gitHead` (read from .git/HEAD + ref file, no subprocess), and a `coverage` block
  naming exactly which sources are attested (`mcp`, optionally `sweep`) with an explicit
  disclaimer that unmediated paths are out of scope. Old receipts still verify
  (signature is over the payload as-is; verify path untouched).

### What stays intact
Engine decision logic, meter, slice/outline, session-guard, existing 6 tool surfaces,
40 tests. Engine/meter gain only an archive sink on the read path.

## Explicitly out of scope (YAGNI)
- Cross-session semantic memory (claude-mem owns it; we restore working sets, not
  narratives). No RAG/repo index (1-3% ceiling, parked). No SaaS/dashboard/telemetry
  (standing no-new-SaaS directive; local-first is the differentiator). No claim of
  total coverage. No savings marketing except the fan-out number with its context.

## Risks and answers
- **Anthropic ships native selective recovery** -> pillar 1 shrinks; packs + receipts
  survive; speed-to-ship now is the mitigation.
- **Secrets on disk** -> deny-globs + user excludes + bounded archive + prominent docs.
- **Hook spawn overhead on Defender-heavy machines** -> capture is sweep-at-PreCompact
  (zero steady-state per-read hooks); SessionEnd sweep is exit-path only.
- **Session-id semantics after compact/resume** -> verified against docs before build
  (open question #1); manifest fallback to most-recent covers drift.
- **claude-mem comparison** -> positioning states the complement explicitly.

## Open questions (resolving now)
1. Hook contracts: PreCompact/SessionStart stdin fields, source values, additionalContext
   mechanism, session-id continuity across compact/resume - claude-code-guide agent
   verifying against current docs.
2. Transcript JSONL: exact shape of native Read tool_result content - to be confirmed
   against a real local transcript before writing the sweep parser.

## Acceptance criteria (release gate for 1.3.0)
1. All existing tests green + new units for archive (idempotent write, eviction,
   deny-glob), sweep parser (real-format fixture), manifest ranking, restore (budget,
   changed-file annotation), pack (determinism, ranking), receipt v2 (git fields,
   coverage, old-receipt back-compat verify).
2. Wire smoke extended: working_set + restore_context + export_pack round-trip over
   stdio, plus receipt v2 issue+verify+tamper-reject.
3. Live restore demo on this machine: real session, real compact, manifest injected,
   restore_context returns the working set - captured output.
4. `npx tsc` build clean; README rewritten to the flight-recorder positioning with
   honest numbers; CHANGELOG entry; version 1.3.0.
5. code-reviewer pass + security review of archive/hooks (file perms, deny-globs,
   injection surfaces) before release prep.
