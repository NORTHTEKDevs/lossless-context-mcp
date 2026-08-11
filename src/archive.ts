// The flight-recorder archive: persistent, content-addressed storage of every file
// version the agent was shown, plus an append-only event log of when and how.
//
// This is the substrate all three product views stand on: restore (re-emit the working
// set after a compaction destroyed it), packs (rank stable hot files across sessions for
// fan-out context packs), and receipts (git-bound attestation of exact versions).
//
// Multi-process safe by construction, with no locking:
//   - blob writes are content-addressed and idempotent (temp file + rename; two writers
//     racing on the same hash produce the same bytes),
//   - each writer process appends only to its OWN events file (events/<writer>.jsonl).
//
// Secret hygiene: paths matching the deny list (or LOSSLESS_ARCHIVE_EXCLUDE patterns)
// are never written to blobs; their events carry `excluded: true` so the record of the
// read exists without persisting the content.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeKeyFor } from './engine.js'
import { gitBlobSha1 } from './gitid.js'

export interface ArchiveEvent {
  ts: string
  session: string
  path: string
  repo: string
  /** SHA-256 of the content version (matches engine/receipt hashes). */
  hash: string
  gitBlobSha1?: string
  bytes: number
  approxTokens: number
  source: 'mcp' | 'sweep'
  op: 'read' | 'edit' | 'write'
  view: string
  /** True when the event came from a subagent (sidechain) transcript line. */
  sidechain?: boolean
  /** True when the path matched the secret deny list: event recorded, blob NOT stored. */
  excluded?: boolean
}

export function contextRoot(): string {
  return process.env.LOSSLESS_CONTEXT_DIR || join(homedir(), '.lossless-context')
}

/** Cheap, tokenizer-free size estimate used for ranking and budgets (never billing). */
export function approxTokens(s: string | number): number {
  return Math.ceil((typeof s === 'string' ? s.length : s) / 4)
}

// Secret deny list. Matched against the basename and each path segment, case-insensitive,
// after backslash normalization. Deliberately conservative: false positives only cost us
// one un-archived file; false negatives put a secret on disk.
const DENY_BASENAMES = new Set(['.npmrc', '.netrc', '.pgpass', '.git-credentials', '.htpasswd', 'credentials', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml'])
const DENY_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube'])
const DENY_REGEXPS = [
  /(^|\/)\.env($|\.)/i, // .env, .env.local, .env.production ...
  /\.(pem|key|p12|pfx|keystore|jks|asc)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/i,
  /secret[^/]*\.(json|ya?ml|toml|txt)$/i,
  /credential/i,
]

function userDenyPatterns(): RegExp[] {
  const raw = process.env.LOSSLESS_ARCHIVE_EXCLUDE
  if (!raw) return []
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // Glob-lite: '*' is the only wildcard; everything else is literal.
      const rx = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
      return new RegExp(`(^|/)${rx}$`, 'i')
    })
}

function matchesDenyPatterns(path: string): boolean {
  const norm = normalizeKeyFor(path, false)
  const segments = norm.split('/').filter(Boolean)
  const base = segments[segments.length - 1] ?? ''
  if (DENY_BASENAMES.has(base.toLowerCase())) return true
  for (const s of segments) if (DENY_SEGMENTS.has(s.toLowerCase())) return true
  for (const rx of DENY_REGEXPS) if (rx.test(norm)) return true
  for (const rx of userDenyPatterns()) if (rx.test(norm)) return true
  return false
}

/** Should this path's CONTENT be kept out of the archive?
 *  Checks the literal path AND its resolved real path: reads follow symlinks/junctions
 *  transparently, so an innocuously named link to ~/.ssh/id_rsa or .env would otherwise
 *  bypass the deny list while the bytes read are the real secret. */
export function isExcluded(path: string): boolean {
  if (matchesDenyPatterns(path)) return true
  try {
    const real = realpathSync.native(path)
    if (real !== path && matchesDenyPatterns(real)) return true
  } catch {} // missing file etc. — nothing to read, nothing to leak
  return false
}

const ARCHIVE_BUDGET = () => Number(process.env.LOSSLESS_ARCHIVE_BYTES || 512 * 1024 * 1024)
const EVENT_LOG_MAX_AGE_MS = () => Number(process.env.LOSSLESS_EVENTS_DAYS || 30) * 86_400_000

export class Archive {
  readonly root: string
  readonly blobsDir: string
  readonly eventsDir: string
  private writerFile: string
  private writerNonce = 0

  constructor(root: string = join(contextRoot(), 'archive'), writerId?: string) {
    this.root = root
    this.blobsDir = join(root, 'blobs')
    this.eventsDir = join(root, 'events')
    mkdirSync(this.blobsDir, { recursive: true })
    mkdirSync(this.eventsDir, { recursive: true })
    const id = writerId || `${process.pid}-${Date.now().toString(36)}`
    this.writerFile = join(this.eventsDir, `${id}.jsonl`)
  }

  blobPath(hash: string): string {
    return join(this.blobsDir, hash.slice(0, 2), hash)
  }

  hasBlob(hash: string): boolean {
    return existsSync(this.blobPath(hash))
  }

  /** Store content by hash (idempotent). Throws on a GENUINE write failure — a rename
   *  race with another writer is benign (identical bytes), but disk-full/AV-lock/perms
   *  must not be reported as success: callers log and degrade, they don't get lied to. */
  putBlob(content: string, hash: string): { hash: string; gitSha1: string; bytes: number; stored: boolean } {
    const bytes = Buffer.byteLength(content, 'utf8')
    const gitSha1 = gitBlobSha1(content)
    const target = this.blobPath(hash)
    if (existsSync(target)) return { hash, gitSha1, bytes, stored: false }
    mkdirSync(join(this.blobsDir, hash.slice(0, 2)), { recursive: true })
    const tmp = `${target}.${process.pid}.${++this.writerNonce}.tmp`
    writeFileSync(tmp, content, 'utf8')
    try {
      renameSync(tmp, target)
    } catch (renameErr) {
      try { unlinkSync(tmp) } catch {}
      // Only a lost race leaves the target present; anything else is a real failure.
      if (!existsSync(target)) throw renameErr
      return { hash, gitSha1, bytes, stored: false }
    }
    return { hash, gitSha1, bytes, stored: true }
  }

  getBlob(hash: string): string | null {
    try {
      return readFileSync(this.blobPath(hash), 'utf8')
    } catch {
      return null
    }
  }

  record(e: Omit<ArchiveEvent, 'ts'>): ArchiveEvent {
    const ev: ArchiveEvent = { ts: new Date().toISOString(), ...e }
    appendFileSync(this.writerFile, JSON.stringify(ev) + '\n', 'utf8')
    return ev
  }

  /** All events across all writers, oldest-first. Corrupt lines are skipped, not fatal. */
  readEvents(opts: { sinceMs?: number } = {}): ArchiveEvent[] {
    const out: ArchiveEvent[] = []
    let names: string[]
    try {
      names = readdirSync(this.eventsDir).filter((n) => n.endsWith('.jsonl'))
    } catch {
      return out
    }
    for (const name of names) {
      let raw: string
      try {
        raw = readFileSync(join(this.eventsDir, name), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as ArchiveEvent
          if (typeof e.path !== 'string' || typeof e.hash !== 'string' || typeof e.ts !== 'string') continue
          if (opts.sinceMs !== undefined && Date.parse(e.ts) < opts.sinceMs) continue
          out.push(e)
        } catch {}
      }
    }
    out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    return out
  }

  /** LRU-evict blobs over the byte budget and drop event logs past their max age. */
  enforceBudget(maxBytes: number = ARCHIVE_BUDGET(), now: number = Date.now()): { evictedBlobs: number; droppedLogs: number } {
    let evictedBlobs = 0
    let droppedLogs = 0
    const blobs: { path: string; bytes: number; mtime: number }[] = []
    try {
      for (const shard of readdirSync(this.blobsDir)) {
        const dir = join(this.blobsDir, shard)
        let entries: string[]
        try { entries = readdirSync(dir) } catch { continue }
        for (const f of entries) {
          if (f.endsWith('.tmp')) continue
          try {
            const st = statSync(join(dir, f))
            blobs.push({ path: join(dir, f), bytes: st.size, mtime: st.mtimeMs })
          } catch {}
        }
      }
    } catch {}
    let total = blobs.reduce((s, b) => s + b.bytes, 0)
    blobs.sort((a, b) => a.mtime - b.mtime)
    for (const b of blobs) {
      if (total <= maxBytes) break
      try {
        unlinkSync(b.path)
        total -= b.bytes
        evictedBlobs++
      } catch {}
    }
    try {
      for (const name of readdirSync(this.eventsDir)) {
        if (!name.endsWith('.jsonl')) continue
        const p = join(this.eventsDir, name)
        try {
          if (now - statSync(p).mtimeMs > EVENT_LOG_MAX_AGE_MS() && p !== this.writerFile) {
            unlinkSync(p)
            droppedLogs++
          }
        } catch {}
      }
    } catch {}
    return { evictedBlobs, droppedLogs }
  }
}
