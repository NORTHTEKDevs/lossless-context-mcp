# Design: the multi-agent coordination plane (v2.0.0)

Date: 2026-08-11. Direction approved by Kristian: "build this big idea" — turn the
flight recorder from passive (record/restore/prove) into active coordination
infrastructure for CONCURRENT agents on one machine. Narrative arc:
record → restore → protect → **coordinate**.

## The problem nobody mediates

Parallel agent sessions on one repo clobber each other blind: session B edits a file
session A read ten minutes ago; A edits from its stale copy; the merge is garbage and
neither agent notices. The single-session guard (v1.4) catches A's staleness only when
it has a comparable content hash, and says nothing about WHO changed the file or about
edits still in flight. No local product coordinates concurrent agent context. Our
archive + guard already see, per session, what each agent holds and edits — the data
for coordination exists; only the cross-session view is missing.

## Conflict classes

- **C2 — edit in flight**: another agent process was ALLOWED an edit on this path
  seconds ago; the result may not have landed yet, so disk comparison cannot see it.
  Only presence can catch this race. Includes sibling subagents of the SAME session
  (same sid, different pid).
- **C1 — landed edit, unverifiable base**: another session's edit on this path landed
  AFTER my session last saw it, and my seen-entry has no comparable hash (I last
  touched it via my own edit or a partial read), so the v1.4 drift check cannot fire.
- **Attribution**: when the existing drift check DOES fire, presence often knows which
  session caused it — the deny reason should say so.
- **C3 — overlap awareness**: sessions sharing working-set files; informational only
  (a radar view, never a deny).

## Presence store (no daemon, no locks)

`~/.lossless-context/presence/<sid>-<pid>.json` — ONE FILE PER PROCESS (single writer
by construction; parallel subagent hooks in one session are different pids → different
files). Atomic temp+rename writes. Content, bounded and self-pruning (records older
than 30 min dropped at write):

```json
{ "sid": "...", "pid": 123, "updatedAt": 1765...,
  "intents": [{ "path": "...", "ts": 1765... }],
  "edits":   [{ "path": "...", "ts": 1765..., "hash": "..."? }] }
```

- **intent** — appended when THIS process's guard ALLOWS Edit/Write/MultiEdit, before
  the tool executes. Denied calls never write intents.
- **edit (landed)** — published when the guard's incremental transcript parse
  encounters a guarded-tool RESULT (Write results carry the written content → hash;
  Edit results carry no post-content → no hash, ts only).

Readers (each guard decision + the radar tool): readdir presence/, parse files with
mtime under 30 min, skip own pid. Cheap — a handful of small files.

## Decision order (extends v1.4's decideEdit; all fail-open)

1. Never-seen / pre-epoch deny (v1.4, strongest).
2. Drift deny (v1.4) — now with attribution when another process's landed edit on the
   path is newer than my seen ts ("likely session <sid8>, Ns ago").
3. **C2 deny**: another process (any sid, including my own sid's other pids) has an
   intent on this path younger than 90 s (`LOSSLESS_COORD_INTENT_SECS`) without my
   seen-entry being newer than it. Reason names the session + age; retry-after-wait
   plus re-read guidance.
4. **C1 deny**: my seen-entry has NO hash, and another process's landed edit on the
   path is newer than my seen ts — unless its recorded hash equals... (only comparable
   when both known; with my hash unknown it never is → deny with re-read guidance).
5. Allow → append my intent, save presence.

Self-exclusion: a process never conflicts with its own records (pid match). The v1.4
self-vouch invariant is untouched — presence adds deny classes, never allow classes.

## New tool

`coordination_status` — the radar: active agent processes (presence < 30 min), their
recent edit counts, files with cross-session activity, and conflicts my session would
currently hit. Read-only, demo-able side by side with two terminals.

## Config

`LOSSLESS_COORD=off` disables cross-session checks (guard's single-session behavior
remains); `LOSSLESS_COORD_INTENT_SECS` (90), `LOSSLESS_COORD_SESSION_SECS` (1800).

## Honest limits (documented in README)

- Advisory, not locking: a native-tool edit in a session WITHOUT the hooks installed is
  invisible; two intents can still race inside the same second. This narrows the
  clobber window by orders of magnitude; it cannot close it.
- Landed-edit lag: a session publishes its landed edits at its NEXT guard invocation;
  the in-flight window is what covers the gap.
- Same-session sibling coverage is intents-only in this version (shared seen-state
  makes landed sibling edits self-correcting via drift).

## Versioning

2.0.0. No breaking changes — the major marks the capability-class change (passive
recorder → active coordination), which is exactly what a major should communicate.

## Acceptance

1. Unit: presence write/aggregate/prune/staleness; conflict matrix (fresh/stale
   intents, landed w/ and w/o hashes, own-pid exclusion, same-sid-other-pid intent
   conflict); decision ordering.
2. Smoke: simulated two-process conflict — process A holds an intent, process B's
   guard denies with A's sid in the reason; landed-edit C1 deny; coordination_status
   renders both.
3. All existing tests green; review pass; live two-terminal verification is the
   post-ship dogfood step (requires hooks installed on the machine).
