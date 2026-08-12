// The coordination plane: presence records that let concurrent agent processes on one
// machine see each other's context activity — and stop clobbering each other.
//
// Design constraints that shape everything here:
//   - WRITER IDENTITY IS THE LOGICAL AGENT, NOT THE PROCESS: hook invocations are
//     one-shot processes (fresh pid every call), so identity is `sid + agent_id`
//     (`main` for the top-level session). One file per logical agent — stable across
//     invocations, so an agent never conflicts with its own earlier records, while
//     sibling subagents (different agent_id) and other sessions remain visible.
//   - NO daemon, NO locks: atomic temp+rename, self-pruning, bounded, and stale files
//     are garbage-collected opportunistically by readers (only provably-stale files).
//   - ADVISORY and fail-open: presence can only add DENY classes to the guard, never
//     allow something the single-session rules would deny; any read/parse doubt means
//     "no conflict". A session without hooks is invisible — this narrows the
//     concurrent-clobber window; it cannot close it.

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextRoot } from './archive.js'
import { normalizeKey } from './engine.js'
import type { SeenEntry } from './guard.js'

export interface PresenceIntent {
  path: string
  ts: number
}
export interface PresenceEdit {
  path: string
  ts: number
  /** SHA-256 of the written content when knowable (Write results); absent for Edits. */
  hash?: string
}
export interface PresenceRecord {
  sid: string
  /** Logical agent within the session: 'main' or the harness agent_id. */
  agent: string
  /** Pid of the last writer — informational only, never identity. */
  pid: number
  updatedAt: number
  intents: PresenceIntent[]
  edits: PresenceEdit[]
}

const RECORD_MAX_AGE_MS = () => Number(process.env.LOSSLESS_COORD_SESSION_SECS || 1800) * 1000
export const intentFreshMs = () => Number(process.env.LOSSLESS_COORD_INTENT_SECS || 90) * 1000
const MAX_RECORDS_PER_LIST = 100

export function presenceDir(): string {
  return join(contextRoot(), 'presence')
}

const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_')

/** Stable writer identity: the logical agent, NOT the (one-shot) hook process. */
export function writerKey(sid: string, agent?: string): string {
  return `${clean(sid)}__${clean(agent || 'main')}`
}

function presencePath(key: string): string {
  return join(presenceDir(), `${key}.json`)
}

export function loadOwnPresence(sid: string, agent?: string, now = Date.now()): PresenceRecord {
  try {
    const r = JSON.parse(readFileSync(presencePath(writerKey(sid, agent)), 'utf8')) as PresenceRecord
    if (r && Array.isArray(r.intents) && Array.isArray(r.edits))
      return { ...r, sid, agent: agent || 'main', pid: process.pid }
  } catch {}
  return { sid, agent: agent || 'main', pid: process.pid, updatedAt: now, intents: [], edits: [] }
}

/** Prune + dedupe + bound + atomically write this logical agent's presence record. */
export function saveOwnPresence(record: PresenceRecord, now = Date.now()): void {
  const cutoff = now - RECORD_MAX_AGE_MS()
  // Dedupe edits: the same landed edit can arrive via the PostToolUse publisher AND the
  // transcript sweep fallback — keep the richer (hashed) record per (path, ~5s bucket).
  const seenEdit = new Map<string, PresenceEdit>()
  for (const e of record.edits) {
    if (e.ts < cutoff) continue
    const bucket = `${normalizeKey(e.path)}::${Math.round(e.ts / 5000)}`
    const cur = seenEdit.get(bucket)
    if (!cur || (!cur.hash && e.hash)) seenEdit.set(bucket, e)
  }
  const rec: PresenceRecord = {
    sid: record.sid,
    agent: record.agent,
    pid: process.pid,
    updatedAt: now,
    intents: record.intents.filter((i) => i.ts >= cutoff).slice(-MAX_RECORDS_PER_LIST),
    edits: [...seenEdit.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_RECORDS_PER_LIST),
  }
  mkdirSync(presenceDir(), { recursive: true })
  const target = presencePath(writerKey(rec.sid, rec.agent))
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(rec), 'utf8')
  try {
    renameSync(tmp, target)
  } catch {
    try { writeFileSync(target, JSON.stringify(rec), 'utf8') } catch {}
    try { unlinkSync(tmp) } catch {}
  }
}

/** All OTHER logical agents' presence (files within the session window). Stale files are
 *  garbage-collected here — readers only ever delete what they can PROVE is stale, so
 *  the collection stays lock-free. Never throws. Pass ownKey '' for the radar view. */
export function loadOthers(ownKey: string, now = Date.now()): PresenceRecord[] {
  const out: PresenceRecord[] = []
  let names: string[]
  try {
    names = readdirSync(presenceDir())
  } catch {
    return out
  }
  const cutoff = now - RECORD_MAX_AGE_MS()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const p = join(presenceDir(), name)
    try {
      if (statSync(p).mtimeMs < cutoff) {
        try { unlinkSync(p) } catch {} // opportunistic GC: provably stale, delete
        continue
      }
      if (name === `${ownKey}.json`) continue
      const r = JSON.parse(readFileSync(p, 'utf8')) as PresenceRecord
      if (!r || !Array.isArray(r.intents) || !Array.isArray(r.edits)) continue
      out.push(r)
    } catch {}
  }
  return out
}

/** One-shot landed-edit publication (the PostToolUse hook's whole job). */
export function publishEdit(sid: string, agent: string | undefined, path: string, hash?: string, now = Date.now()): void {
  const own = loadOwnPresence(sid, agent, now)
  own.edits.push({ path, ts: now, hash })
  // The landed edit supersedes this agent's own in-flight intent on the path.
  own.intents = own.intents.filter((i) => normalizeKey(i.path) !== normalizeKey(path))
  saveOwnPresence(own, now)
}

export interface CrossConflict {
  kind: 'in-flight' | 'landed-edit'
  otherSid: string
  otherAgent: string
  ageMs: number
  sameSession: boolean
}

/** Attribution for a drift deny: who most recently landed an edit on this path. */
export function attributeEdit(path: string, others: PresenceRecord[], mySid = '', now = Date.now()): CrossConflict | null {
  const key = normalizeKey(path)
  let best: CrossConflict | null = null
  for (const o of others) {
    for (const e of o.edits) {
      if (normalizeKey(e.path) !== key) continue
      if (!best || now - e.ts < best.ageMs)
        best = { kind: 'landed-edit', otherSid: o.sid, otherAgent: o.agent, ageMs: now - e.ts, sameSession: o.sid === mySid }
    }
  }
  return best
}

/** The cross-process conflict check. `mySeen` is this session's seen-entry for the path
 *  (undefined when never seen — the single-session rules deny that case first). */
export function evaluateCross(
  path: string,
  mySeen: SeenEntry | undefined,
  mySid: string,
  others: PresenceRecord[],
  now = Date.now(),
): CrossConflict | null {
  const key = normalizeKey(path)

  // C2 — another process's edit is in flight on this path. My own seen-entry being
  // NEWER than the intent means I read the file after they intended (their edit either
  // landed before my read or was never executed) — then C2 yields to the landed/drift
  // rules instead of double-flagging.
  for (const o of others) {
    for (const i of o.intents) {
      if (normalizeKey(i.path) !== key) continue
      const age = now - i.ts
      if (age > intentFreshMs() || age < 0) continue
      if (mySeen && mySeen.ts > i.ts) continue
      return { kind: 'in-flight', otherSid: o.sid, otherAgent: o.agent, ageMs: age, sameSession: o.sid === mySid }
    }
  }

  // C1 — a landed edit newer than what I hold, and I have no hash to verify my base
  // against disk (my last touch was my own edit or a partial read). With a comparable
  // hash the single-session drift check is the authority (disk-truth beats records).
  if (mySeen && !mySeen.hash) {
    for (const o of others) {
      for (const e of o.edits) {
        if (normalizeKey(e.path) !== key) continue
        if (e.ts <= mySeen.ts) continue
        return { kind: 'landed-edit', otherSid: o.sid, otherAgent: o.agent, ageMs: now - e.ts, sameSession: o.sid === mySid }
      }
    }
  }
  return null
}

export function renderConflictReason(path: string, c: CrossConflict): string {
  const who = c.sameSession
    ? `another agent in THIS session (${c.otherAgent})`
    : `agent session ${c.otherSid.slice(0, 8)} (${c.otherAgent})`
  const age = c.ageMs < 120_000 ? `${Math.max(1, Math.round(c.ageMs / 1000))}s ago` : `${Math.round(c.ageMs / 60_000)}min ago`
  if (c.kind === 'in-flight') {
    return (
      `[lossless-context coordination] ${who} started an edit on ${path} ${age} and it may ` +
      `not have landed yet. Editing now risks clobbering it. Wait a moment, re-read the ` +
      `file, and retry — if your change is still needed after theirs, base it on the fresh content.`
    )
  }
  return (
    `[lossless-context coordination] ${who} modified ${path} ${age} — AFTER you last saw it, ` +
    `and your last contact left no verifiable base (own edit or partial read). Re-read the ` +
    `current content and re-derive your edit against it, then retry.`
  )
}
