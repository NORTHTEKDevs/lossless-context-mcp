// Context blame: "what did the agent see when it touched this file?"
//
// The forensic view over the flight-recorder archive. Given a path (and optionally a
// point in time), reconstruct: every content version of that file the model was shown
// (hash, git blob sha, when, by which capture source, in which session), and what else
// was in the agent's working context around a chosen moment. This turns "why did my
// agent do that?" from an argument with the agent's self-report into a query over
// signed-attestable history.
//
// Read-only over archive events; content itself stays in the blob store (the report
// references hashes — `getBlob` can produce any version for diffing externally).

import { Archive, type ArchiveEvent } from './archive.js'
import { normalizeKey } from './engine.js'

export interface BlameVersion {
  hash: string
  gitBlobSha1?: string
  firstSeen: string
  lastSeen: string
  events: number
  sessions: string[]
  sources: string[]
  ops: string[]
  bytes: number
  inArchive: boolean
}

export interface BlameReport {
  path: string
  totalEvents: number
  excludedEvents: number
  versions: BlameVersion[]
  /** Files the same sessions touched within the co-context window of the focus moment. */
  coContext: { path: string; events: number; sessions: number }[]
  focusTs?: string
}

export interface BlameOptions {
  /** Focus moment (ISO or ms). Default: the last event for the path. */
  at?: string | number
  /** Co-context window around the focus moment, minutes each side (default 30). */
  windowMinutes?: number
  /** How far back to read events. Default 30 — matching the archive's own event-log
   *  retention (LOSSLESS_EVENTS_DAYS); asking for more than retention sees nothing. */
  days?: number
  now?: number
}

export function blameContext(archive: Archive, path: string, opts: BlameOptions = {}): BlameReport {
  const days = opts.days ?? Number(process.env.LOSSLESS_EVENTS_DAYS || 30)
  const now = opts.now ?? Date.now()
  const key = normalizeKey(path)
  const all = archive.readEvents({ sinceMs: now - days * 86_400_000 })
  const mine = all.filter((e) => normalizeKey(e.path) === key)
  const excludedEvents = mine.filter((e) => e.excluded).length

  const byHash = new Map<string, BlameVersion>()
  for (const e of mine) {
    if (e.excluded || !e.hash) continue
    let v = byHash.get(e.hash)
    if (!v) {
      v = {
        hash: e.hash,
        gitBlobSha1: e.gitBlobSha1,
        firstSeen: e.ts,
        lastSeen: e.ts,
        events: 0,
        sessions: [],
        sources: [],
        ops: [],
        bytes: e.bytes,
        inArchive: archive.hasBlob(e.hash),
      }
      byHash.set(e.hash, v)
    }
    v.events++
    if (e.ts < v.firstSeen) v.firstSeen = e.ts
    if (e.ts > v.lastSeen) v.lastSeen = e.ts
    if (e.gitBlobSha1) v.gitBlobSha1 = e.gitBlobSha1
    if (!v.sessions.includes(e.session)) v.sessions.push(e.session)
    if (!v.sources.includes(e.source)) v.sources.push(e.source)
    if (!v.ops.includes(e.op)) v.ops.push(e.op)
  }
  const versions = [...byHash.values()].sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1))

  // Focus moment: explicit, else the last time this path was seen.
  let focusMs: number | undefined
  if (opts.at !== undefined) {
    focusMs = typeof opts.at === 'number' ? opts.at : Date.parse(opts.at)
    if (Number.isNaN(focusMs)) focusMs = undefined
  } else if (mine.length > 0) {
    focusMs = Math.max(...mine.map((e) => Date.parse(e.ts)))
  }

  const coContext: BlameReport['coContext'] = []
  if (focusMs !== undefined) {
    const windowMs = (opts.windowMinutes ?? 30) * 60_000
    const focusSessions = new Set(
      mine.filter((e) => Math.abs(Date.parse(e.ts) - focusMs!) <= windowMs).map((e) => e.session),
    )
    const co = new Map<string, { path: string; events: number; sessions: Set<string> }>()
    for (const e of all) {
      if (normalizeKey(e.path) === key) continue
      if (e.excluded) continue // secret-pattern paths stay out of co-context listings too
      if (!focusSessions.has(e.session)) continue
      if (Math.abs(Date.parse(e.ts) - focusMs) > windowMs) continue
      let c = co.get(normalizeKey(e.path))
      if (!c) {
        c = { path: e.path, events: 0, sessions: new Set() }
        co.set(normalizeKey(e.path), c)
      }
      c.events++
      c.sessions.add(e.session)
    }
    coContext.push(
      ...[...co.values()]
        .map((c) => ({ path: c.path, events: c.events, sessions: c.sessions.size }))
        .sort((a, b) => b.events - a.events)
        .slice(0, 20),
    )
  }

  return {
    path,
    totalEvents: mine.length,
    excludedEvents,
    versions,
    coContext,
    focusTs: focusMs !== undefined ? new Date(focusMs).toISOString() : undefined,
  }
}

export function renderBlame(r: BlameReport): string {
  if (r.totalEvents === 0)
    return (
      `[lossless-context] blame ${r.path}: no recorded events. The recorder only knows ` +
      `reads made through this server or captured by the sweep hooks after installation.`
    )
  const head =
    `[lossless-context] blame ${r.path} — ${r.versions.length} version(s) shown to the model ` +
    `across ${r.totalEvents} event(s)` +
    (r.excludedEvents ? ` (+${r.excludedEvents} excluded/secret-pattern, content never recorded)` : '') +
    (r.focusTs ? `; focus ${r.focusTs}` : '') +
    '\n'
  const versions = r.versions
    .map(
      (v, i) =>
        `  v${i + 1}  sha256 ${v.hash.slice(0, 12)}` +
        (v.gitBlobSha1 ? `  git-blob ${v.gitBlobSha1.slice(0, 12)}` : '') +
        `  ${v.bytes}B  seen ${v.firstSeen}${v.lastSeen !== v.firstSeen ? ` → ${v.lastSeen}` : ''}` +
        `  [${v.sources.join('+')}/${v.ops.join('+')}] x${v.events}` +
        (v.inArchive ? '' : '  (blob evicted)'),
    )
    .join('\n')
  const co =
    r.coContext.length > 0
      ? '\n\nin context around the focus moment (same sessions, ±window):\n' +
        r.coContext.map((c) => `  ${c.path}  x${c.events}`).join('\n')
      : ''
  return head + versions + co
}
