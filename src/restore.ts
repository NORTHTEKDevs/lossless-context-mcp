// Working-set manifests: what the session was working on, written at sweep time
// (PreCompact/SessionEnd) and injected back after the compaction that would otherwise
// have destroyed it (SessionStart source=compact).
//
// The manifest is deliberately tiny — a ranked table, not content. Content restoration
// happens on demand through restore_context, which serves CURRENT disk state (annotated
// when it drifted from what the model last saw). Injection output is capped by the
// harness at 10k characters, so renderManifest budgets well under that.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextRoot } from './archive.js'
import type { WorkingSetEntry } from './sweep.js'

export interface Manifest {
  session: string
  ts: string
  entries: WorkingSetEntry[]
}

export const MANIFEST_TOP_K = Number(process.env.LOSSLESS_MANIFEST_TOP_K || 12)

export function sessionsDir(): string {
  return join(contextRoot(), 'sessions')
}

function manifestPath(session: string): string {
  // Session ids are UUID-shaped today; sanitize defensively for filesystem use anyway.
  return join(sessionsDir(), session.replace(/[^A-Za-z0-9._-]/g, '_') + '.manifest.json')
}

export function writeManifest(session: string, entries: WorkingSetEntry[], now = new Date()): string {
  const dir = sessionsDir()
  mkdirSync(dir, { recursive: true })
  const m: Manifest = { session, ts: now.toISOString(), entries: entries.slice(0, MANIFEST_TOP_K) }
  const p = manifestPath(session)
  writeFileSync(p, JSON.stringify(m, null, 2), 'utf8')
  return p
}

/** Manifest for this exact session, else the most recent one under maxAgeMs, else null. */
export function loadManifest(session?: string, maxAgeMs = 24 * 3600_000, now = Date.now()): Manifest | null {
  const dir = sessionsDir()
  if (session) {
    const exact = manifestPath(session)
    if (existsSync(exact)) {
      try {
        return JSON.parse(readFileSync(exact, 'utf8')) as Manifest
      } catch {}
    }
  }
  let best: { p: string; mtime: number } | null = null
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.manifest.json')) continue
      const p = join(dir, name)
      try {
        const mtime = statSync(p).mtimeMs
        if (now - mtime <= maxAgeMs && (!best || mtime > best.mtime)) best = { p, mtime }
      } catch {}
    }
  } catch {
    return null
  }
  if (!best) return null
  try {
    return JSON.parse(readFileSync(best.p, 'utf8')) as Manifest
  } catch {
    return null
  }
}

/** The post-compaction injection text: small, actionable, and honest about staleness. */
export function renderManifest(m: Manifest): string {
  const lines = m.entries.map((e) => {
    const marks = [e.edits > 0 ? 'edited' : '', e.excluded ? 'not archived (secret-pattern)' : ''].filter(Boolean).join(', ')
    return `  ${e.path}  (~${e.approxTokens} tok, ${e.reads + e.edits} touches${marks ? ', ' + marks : ''})`
  })
  return (
    `[lossless-context] Working set recovered from before this context was compacted ` +
    `(session ${m.session.slice(0, 8)}, swept ${m.ts}):\n` +
    lines.join('\n') +
    `\n\nCompaction discards file contents but not the files themselves. Do NOT guess at ` +
    `contents you no longer have. To get any of these back, call the lossless-context ` +
    `restore_context tool (all of the above, budget-capped) or read_file for specific ones; ` +
    `working_set lists this table again with current staleness.`
  )
}
