// Transcript sweep: turn a Claude Code session transcript into archive events and a
// working-set manifest, so a compaction can never destroy the working set.
//
// The transcript JSONL format is explicitly internal to Claude Code and can change
// between versions. This parser is therefore two-tier and fail-silent:
//   Tier 1 (robust)      — discover WHICH files the session touched from tool_use inputs
//                          (`file_path` is the stablest surface), then archive the CURRENT
//                          disk content of each at sweep time.
//   Tier 2 (best-effort) — where the line carries a complete `toolUseResult.file`
//                          (filePath + full content), archive that EXACT version too, so
//                          receipts can attest precisely what was shown.
// A format change degrades tier 2 to nothing and tier 1 to whatever still parses; a
// sweep never throws past its own boundary and never blocks compaction.

import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Archive, approxTokens, isExcluded, type ArchiveEvent } from './archive.js'
import { hashContent, normalizeKey } from './engine.js'
import { repoRootOf } from './meter.js'
import { looksBinary } from './slice.js'

const NATIVE_READ_TOOLS = new Set(['Read'])
const NATIVE_WRITE_TOOLS = new Set(['Write'])
const NATIVE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])

export interface WorkingSetEntry {
  path: string
  hash: string
  bytes: number
  approxTokens: number
  reads: number
  edits: number
  lastOp: 'read' | 'edit' | 'write'
  lastTs: string
  excluded?: boolean
}

export interface SweepStats {
  lines: number
  parsedLines: number
  readsSeen: number
  editsSeen: number
  exactVersions: number
  diskVersions: number
  skipped: number
}

interface Touch {
  path: string
  op: 'read' | 'edit' | 'write'
  ts: string
  sidechain: boolean
  reads: number
  edits: number
}

/** Extract path touches + exact content versions from one transcript line. Never throws. */
export function parseLine(line: string): {
  touches: { path: string; op: 'read' | 'edit' | 'write'; sidechain: boolean; ts: string }[]
  exact?: { path: string; content: string; sidechain: boolean; ts: string }
} | null {
  let j: any
  try {
    j = JSON.parse(line)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  const ts = typeof j.timestamp === 'string' ? j.timestamp : new Date(0).toISOString()
  const sidechain = j.isSidechain === true
  const touches: { path: string; op: 'read' | 'edit' | 'write'; sidechain: boolean; ts: string }[] = []
  const content = j?.message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
      const fp = block?.input?.file_path ?? block?.input?.notebook_path
      if (typeof fp !== 'string' || fp.length === 0) continue
      if (NATIVE_READ_TOOLS.has(block.name)) touches.push({ path: fp, op: 'read', sidechain, ts })
      else if (NATIVE_WRITE_TOOLS.has(block.name)) touches.push({ path: fp, op: 'write', sidechain, ts })
      else if (NATIVE_EDIT_TOOLS.has(block.name)) touches.push({ path: fp, op: 'edit', sidechain, ts })
    }
  }
  // Tier 2: a complete Read result carries the exact version the model was shown.
  let exact: { path: string; content: string; sidechain: boolean; ts: string } | undefined
  const file = j?.toolUseResult?.file
  if (
    file &&
    typeof file.filePath === 'string' &&
    typeof file.content === 'string' &&
    (file.startLine === undefined || file.startLine === 1) &&
    (file.numLines === undefined || file.totalLines === undefined || file.numLines === file.totalLines)
  ) {
    exact = { path: file.filePath, content: file.content, sidechain, ts }
  }
  if (touches.length === 0 && !exact) return null
  return { touches, exact }
}

export interface SweepOptions {
  session: string
  maxBytes?: number
}

/** Sweep one transcript into the archive; returns the main-session working set (heat-ranked). */
export async function sweepTranscript(
  transcriptPath: string,
  archive: Archive,
  opts: SweepOptions,
): Promise<{ stats: SweepStats; workingSet: WorkingSetEntry[] }> {
  const maxBytes = opts.maxBytes ?? Number(process.env.LOSSLESS_MAX_BYTES || 2_000_000)
  const stats: SweepStats = { lines: 0, parsedLines: 0, readsSeen: 0, editsSeen: 0, exactVersions: 0, diskVersions: 0, skipped: 0 }
  const touches = new Map<string, Touch>() // main-session only, keyed by normalized path
  const exactSeen = new Map<string, { path: string; content: string; sidechain: boolean; ts: string }>() // keyed by path::hash
  // Bound the exact-version buffer: this hook runs at PreCompact and must never OOM the
  // session. Past the budget, new exact versions are dropped (tier-1 disk capture still
  // covers recovery; only receipt-grade exact history degrades).
  const exactBudget = Number(process.env.LOSSLESS_SWEEP_EXACT_BYTES || 64 * 1024 * 1024)
  let exactBytes = 0

  const rl = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity })
  for await (const line of rl) {
    stats.lines++
    const parsed = parseLine(line)
    if (!parsed) continue
    stats.parsedLines++
    for (const t of parsed.touches) {
      if (t.op === 'read') stats.readsSeen++
      else stats.editsSeen++
      if (t.sidechain) continue // subagent activity informs packs via events, not this manifest
      const key = normalizeKey(t.path)
      const cur = touches.get(key)
      if (cur) {
        cur.reads += t.op === 'read' ? 1 : 0
        cur.edits += t.op === 'read' ? 0 : 1
        cur.op = t.op
        cur.ts = t.ts
      } else {
        touches.set(key, { path: t.path, op: t.op, ts: t.ts, sidechain: false, reads: t.op === 'read' ? 1 : 0, edits: t.op === 'read' ? 0 : 1 })
      }
    }
    if (parsed.exact) {
      const h = hashContent(parsed.exact.content)
      const key = normalizeKey(parsed.exact.path) + '::' + h
      const size = Buffer.byteLength(parsed.exact.content, 'utf8')
      if (!exactSeen.has(key)) {
        if (exactBytes + size <= exactBudget) {
          exactSeen.set(key, parsed.exact)
          exactBytes += size
        } else {
          stats.skipped++
        }
      }
    }
  }

  // Tier 2: archive every exact version seen (receipt-grade evidence). For excluded
  // (secret-pattern) paths, neither content NOR content-derived metadata (hash, size)
  // goes to disk — a hash of a low-entropy secret invites offline confirmation attacks.
  for (const ex of exactSeen.values()) {
    const excluded = isExcluded(ex.path)
    let gitSha1: string | undefined
    let hash = ''
    let bytes = 0
    let tokens = 0
    if (!excluded) {
      hash = hashContent(ex.content)
      bytes = Buffer.byteLength(ex.content, 'utf8')
      tokens = approxTokens(ex.content)
      try {
        gitSha1 = archive.putBlob(ex.content, hash).gitSha1
        stats.exactVersions++
      } catch {
        stats.skipped++
        continue
      }
    }
    try {
      archive.record({
        session: opts.session,
        path: ex.path,
        repo: repoRootOf(ex.path),
        hash,
        gitBlobSha1: gitSha1,
        bytes,
        approxTokens: tokens,
        source: 'sweep',
        op: 'read',
        view: 'full',
        sidechain: ex.sidechain || undefined,
        excluded: excluded || undefined,
      })
    } catch {
      stats.skipped++
    }
  }

  // Tier 1: archive CURRENT disk content for every touched path (recovery-grade truth),
  // and assemble the working set from it.
  const workingSet: WorkingSetEntry[] = []
  for (const t of touches.values()) {
    let content: string | null = null
    let bytes = 0
    try {
      const st = statSync(t.path)
      if (st.size <= maxBytes) {
        const buf = readFileSync(t.path)
        if (!looksBinary(buf)) {
          content = buf.toString('utf8')
          bytes = buf.byteLength
        }
      }
    } catch {}
    if (content === null) {
      stats.skipped++
      continue
    }
    const excluded = isExcluded(t.path)
    // Excluded paths: record that the session touched them (path + counts only) —
    // no content, no hash, no size leaves memory for those.
    const hash = excluded ? '' : hashContent(content)
    const tokens = excluded ? 0 : approxTokens(content)
    if (excluded) bytes = 0
    let gitSha1: string | undefined
    if (!excluded) {
      try {
        const res = archive.putBlob(content, hash)
        gitSha1 = res.gitSha1
        if (res.stored) stats.diskVersions++
      } catch {}
    }
    try {
      archive.record({
        session: opts.session,
        path: t.path,
        repo: repoRootOf(t.path),
        hash,
        gitBlobSha1: gitSha1,
        bytes,
        approxTokens: tokens,
        source: 'sweep',
        op: t.op,
        view: 'full',
        excluded: excluded || undefined,
      })
    } catch {}
    workingSet.push({
      path: t.path,
      hash,
      bytes,
      approxTokens: tokens,
      reads: t.reads,
      edits: t.edits,
      lastOp: t.op,
      lastTs: t.ts,
      excluded: excluded || undefined,
    })
  }

  // Heat ranking: edited files first (they ARE the work), then read count, then recency.
  workingSet.sort((a, b) => {
    if ((a.edits > 0) !== (b.edits > 0)) return a.edits > 0 ? -1 : 1
    if (a.reads + a.edits !== b.reads + b.edits) return b.reads + b.edits - (a.reads + a.edits)
    return a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : a.path.localeCompare(b.path)
  })
  return { stats, workingSet }
}
