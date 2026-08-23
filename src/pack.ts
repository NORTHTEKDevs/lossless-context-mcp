// Fan-out context packs: the files every subagent is going to read anyway, emitted once
// as a stable block for a custom agent-type's SYSTEM PROMPT so the fleet pays for them
// through the prompt cache instead of N independent Reads.
//
// Why system prompt and not the task prompt: measured on a real review fan-out
// (token-efficiency research, run wf_b206d4d6, 2026-08), a pack injected per-task made
// costs 19.6% WORSE (every sibling cache-writes it), while the same pack embedded in the
// agent-type system prompt — a stable prefix, so it lands behind the prompt-cache
// breakpoint — made the fan-out 46.55% cheaper. The pack must be byte-stable across a
// run for that to work, which is why rendering here is deterministic.
//
// Ranking uses the archive's cross-session event history: files read by MANY sessions
// with FEW distinct content versions are stable reference material (CLAUDE.md, specs,
// core modules) — exactly what belongs in a shared prefix.
//
// Stability scope: renderPack is byte-stable for a given PackResult, but buildPack ranks
// from LIVE event history, so two calls at different times can differ. The intended use
// is generate-once-per-run, embed verbatim — not repeated regeneration mid-run.

import { readFileSync, statSync } from 'node:fs'
import { Archive, approxTokens, isExcluded, type ArchiveEvent } from './archive.js'
import { hashContent, normalizeKey } from './engine.js'
import { gitBlobSha1 } from './gitid.js'
import { looksBinary } from './slice.js'

export interface PackFile {
  path: string
  hash: string
  gitBlobSha1: string
  approxTokens: number
  content: string
  sessions: number
  reads: number
}

export interface PackResult {
  files: PackFile[]
  skipped: { path: string; reason: string }[]
  totalTokens: number
  windowDays: number
}

export interface PackOptions {
  repo?: string
  top?: number
  budgetTokens?: number
  days?: number
  now?: number
  maxBytes?: number
}

export function buildPack(archive: Archive, opts: PackOptions = {}): PackResult {
  const top = opts.top ?? 8
  const budget = opts.budgetTokens ?? 30_000
  const days = opts.days ?? 14
  const now = opts.now ?? Date.now()
  const maxBytes = opts.maxBytes ?? Number(process.env.LOSSLESS_MAX_BYTES || 2_000_000)

  const events = archive.readEvents({ sinceMs: now - days * 86_400_000 })
  const byPath = new Map<string, { path: string; sessions: Set<string>; reads: number; hashes: Set<string> }>()
  for (const e of events) {
    if (e.excluded) continue
    if (opts.repo && normalizeKey(e.repo) !== normalizeKey(opts.repo)) continue
    const key = normalizeKey(e.path)
    let r = byPath.get(key)
    if (!r) {
      r = { path: e.path, sessions: new Set(), reads: 0, hashes: new Set() }
      byPath.set(key, r)
    }
    r.sessions.add(e.session)
    r.reads++
    r.hashes.add(e.hash)
  }

  // Score: breadth of reuse dominates, raw read count breaks ties, churn divides —
  // a file with many distinct versions is being EDITED, not referenced.
  const ranked = [...byPath.values()]
    .map((r) => ({ ...r, score: (r.sessions.size * 10 + r.reads) / r.hashes.size }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  const files: PackFile[] = []
  const skipped: { path: string; reason: string }[] = []
  let total = 0
  for (const r of ranked) {
    if (files.length >= top) break
    if (isExcluded(r.path)) {
      skipped.push({ path: r.path, reason: 'secret-pattern' })
      continue
    }
    let content: string
    try {
      const st = statSync(r.path)
      if (st.size > maxBytes) {
        skipped.push({ path: r.path, reason: 'too large' })
        continue
      }
      const buf = readFileSync(r.path)
      if (looksBinary(buf)) {
        skipped.push({ path: r.path, reason: 'binary' })
        continue
      }
      content = buf.toString('utf8')
    } catch {
      skipped.push({ path: r.path, reason: 'unreadable' })
      continue
    }
    const tok = approxTokens(content)
    if (total + tok > budget) {
      skipped.push({ path: r.path, reason: `over budget (~${tok} tok)` })
      continue
    }
    total += tok
    files.push({
      path: r.path,
      hash: hashContent(content),
      gitBlobSha1: gitBlobSha1(content),
      approxTokens: tok,
      content,
      sessions: r.sessions.size,
      reads: r.reads,
    })
  }
  return { files, skipped, totalTokens: total, windowDays: days }
}

/** Deterministic render — byte-stable for identical inputs, which the cache win requires. */
export function renderPack(p: PackResult): string {
  const head =
    `[lossless-context] context pack — ${p.files.length} file(s), ~${p.totalTokens} tokens, ` +
    `ranked from ${p.windowDays} day(s) of read history.\n` +
    `Embed this block VERBATIM in a custom agent-type's system prompt (a stable prefix that ` +
    `lands behind the prompt-cache breakpoint). Do not inject it per-task: per-task copies ` +
    `cache-write in every sibling and cost more, not less. Each file is a snapshot at the ` +
    `stated hash; agents should still read files they intend to EDIT.\n`
  const body = p.files
    .map((f) => `=== ${f.path} (sha256 ${f.hash.slice(0, 12)}, git-blob ${f.gitBlobSha1.slice(0, 12)}) ===\n${f.content}`)
    .join('\n\n')
  const tail = p.skipped.length ? `\n\n[pack skipped: ${p.skipped.map((s) => `${s.path} — ${s.reason}`).join('; ')}]` : ''
  return head + '\n' + body + tail
}
