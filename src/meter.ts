// Context meter: the ledger's observability layer.
//
// Every read the server performs is recorded as one MeterEvent. Aggregations answer the
// questions the raw dedup trick cannot: where do this session's file-read tokens go
// (per repo, per file), what did dedup actually save here, and what did it cost in
// dollars. The event trail is also the raw material for signed context receipts —
// an auditable record of exactly which file versions the model was shown.
//
// Pure aggregation over in-memory events; repo attribution walks up to the nearest
// `.git` (cached per directory). No I/O besides that lookup.

import { existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'

export interface MeterEvent {
  ts: string
  path: string // as requested
  repo: string // nearest .git ancestor, or the path's root dir
  view: string
  kind: 'full' | 'diff' | 'unchanged'
  epoch: number
  hash: string // SHA-256 of current view content — what the model now holds. EMPTY for excluded paths.
  baseHash?: string
  /** Git blob SHA-1 of the view content (full-file views) — receipt git binding. */
  gitBlobSha1?: string
  /** Secret-pattern path: content-derived metadata (hashes) is withheld from this event
   *  so it can never reach a signed, exportable receipt. */
  excluded?: boolean
  bytes: number
  baselineTokens: number
  sentTokens: number
}

const repoCache = new Map<string, string>()

/** Nearest ancestor directory containing .git; falls back to the filesystem root. */
export function repoRootOf(filePath: string): string {
  let dir: string
  try {
    dir = dirname(filePath)
  } catch {
    return filePath
  }
  const seen: string[] = []
  let cur = dir
  while (true) {
    const cached = repoCache.get(cur)
    if (cached) {
      for (const s of seen) repoCache.set(s, cached)
      return cached
    }
    seen.push(cur)
    if (existsSync(join(cur, '.git'))) {
      for (const s of seen) repoCache.set(s, cur)
      return cur
    }
    const parent = dirname(cur)
    if (parent === cur) {
      const root = parse(cur).root || cur
      for (const s of seen) repoCache.set(s, root)
      return root
    }
    cur = parent
  }
}

export class ContextMeter {
  readonly events: MeterEvent[] = []

  record(e: Omit<MeterEvent, 'ts' | 'repo'>): MeterEvent {
    const ev: MeterEvent = { ts: new Date().toISOString(), repo: repoRootOf(e.path), ...e }
    this.events.push(ev)
    return ev
  }

  totals() {
    let baseline = 0
    let sent = 0
    const kinds = { full: 0, diff: 0, unchanged: 0 }
    for (const e of this.events) {
      baseline += e.baselineTokens
      sent += e.sentTokens
      kinds[e.kind]++
    }
    return { reads: this.events.length, kinds, baselineTokens: baseline, sentTokens: sent, savedTokens: baseline - sent }
  }

  /** Per-repo aggregation, sorted by tokens actually sent (descending). */
  byRepo() {
    const map = new Map<string, { repo: string; reads: number; files: Set<string>; baselineTokens: number; sentTokens: number }>()
    for (const e of this.events) {
      let r = map.get(e.repo)
      if (!r) {
        r = { repo: e.repo, reads: 0, files: new Set(), baselineTokens: 0, sentTokens: 0 }
        map.set(e.repo, r)
      }
      r.reads++
      r.files.add(e.path)
      r.baselineTokens += e.baselineTokens
      r.sentTokens += e.sentTokens
    }
    return [...map.values()]
      .map((r) => ({
        repo: r.repo,
        reads: r.reads,
        files: r.files.size,
        baselineTokens: r.baselineTokens,
        sentTokens: r.sentTokens,
        savedTokens: r.baselineTokens - r.sentTokens,
      }))
      .sort((a, b) => b.sentTokens - a.sentTokens)
  }

  /** Heaviest individual files by sent tokens — the "what is eating my context" list. */
  topFiles(n = 10) {
    const map = new Map<string, { path: string; reads: number; sentTokens: number; baselineTokens: number }>()
    for (const e of this.events) {
      let f = map.get(e.path)
      if (!f) {
        f = { path: e.path, reads: 0, sentTokens: 0, baselineTokens: 0 }
        map.set(e.path, f)
      }
      f.reads++
      f.sentTokens += e.sentTokens
      f.baselineTokens += e.baselineTokens
    }
    return [...map.values()].sort((a, b) => b.sentTokens - a.sentTokens).slice(0, n)
  }
}

/** USD estimate at an input-token price per million tokens (LOSSLESS_PRICE_PER_MTOK). */
export function usd(tokens: number, pricePerMTok = Number(process.env.LOSSLESS_PRICE_PER_MTOK || 3)): string {
  return '$' + ((tokens / 1_000_000) * pricePerMTok).toFixed(4)
}
