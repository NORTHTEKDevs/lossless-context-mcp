// Lossless context engine.
//
// The core guarantee: the engine NEVER withholds or diffs content it cannot prove the
// model still has. "Proof" is bounded by the context EPOCH. Within one epoch the engine
// knows exactly what bytes it returned for a (path,view), so a re-read of unchanged content
// can be a tiny marker and a re-read after an edit can be a diff against the version the
// model provably holds. When the epoch changes (Claude Code compacted -> the model lost
// prior content), the ledger is cleared and the engine reverts to full content.
//
// Two hardening properties make the "lossless" claim airtight rather than best-effort:
//   1. Change detection uses SHA-256, so the unchanged-path cannot serve stale content via a
//      hash collision (FNV would make losslessness merely probabilistic).
//   2. Every diff/unchanged result carries `baseHash` — the hash of the version the model is
//      expected to already hold. The consumer can verify it holds that version and fall back
//      to a full read (force_full) if not, closing the "hook didn't fire" silent-failure gap.
//
// Pure and deterministic: callers pass the current file content in, so the engine has no I/O.

import { createTwoFilesPatch, applyPatch } from 'diff'
import { createHash } from 'node:crypto'

export type ReadKind = 'full' | 'unchanged' | 'diff'

export interface ReadResult {
  kind: ReadKind
  path: string
  view: string // dedup view: 'full' | 'sym:<name>' | 'lines:<a>-<b>'
  epoch: number
  hash: string // SHA-256 of the CURRENT content
  baseHash?: string // for diff/unchanged: the hash the model must already hold to use this
  bytes: number // byte length of the CURRENT full content
  content?: string // present for 'full'
  patch?: string // present for 'diff' (unified diff: prev-as-held -> current)
  note?: string
}

interface LedgerEntry {
  epoch: number
  content: string
  hash: string
  bytes: number
}

/** SHA-256 hex. Cryptographic so the unchanged-path cannot serve stale content. */
export function hashContent(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function normalizeKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

// Memory bound for the in-epoch ledger. Evicting an entry just makes a future read of it
// "full" again (safe). Default 64 MiB of retained content.
const LEDGER_BUDGET = Number(process.env.LOSSLESS_LEDGER_BYTES || 64 * 1024 * 1024)

export class LosslessEngine {
  private ledger = new Map<string, LedgerEntry>()
  private epoch = 0
  private bytesUsed = 0

  setEpoch(e: number): void {
    if (e !== this.epoch) {
      this.epoch = e
      this.ledger.clear()
      this.bytesUsed = 0
    }
  }

  getEpoch(): number {
    return this.epoch
  }

  // Insert/replace an entry, maintaining the byte budget with FIFO eviction (oldest first).
  private setEntry(key: string, content: string, hash: string): void {
    const prev = this.ledger.get(key)
    if (prev) {
      this.bytesUsed -= prev.bytes
      this.ledger.delete(key) // re-insert to move to most-recent position
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    this.ledger.set(key, { epoch: this.epoch, content, hash, bytes })
    this.bytesUsed += bytes
    while (this.bytesUsed > LEDGER_BUDGET && this.ledger.size > 1) {
      const oldest = this.ledger.keys().next().value as string | undefined
      if (oldest === undefined || oldest === key) break
      this.bytesUsed -= this.ledger.get(oldest)!.bytes
      this.ledger.delete(oldest)
    }
  }

  /** Decide what to return for a read of `path`/`view` whose current content is `content`. */
  read(path: string, content: string, opts: { forceFull?: boolean; view?: string } = {}): ReadResult {
    const forceFull = opts.forceFull === true
    const view = opts.view ?? 'full'
    const key = normalizeKey(path) + '::' + view
    const hash = hashContent(content)
    const bytes = Buffer.byteLength(content, 'utf8')
    const prev = this.ledger.get(key)

    if (!forceFull && prev && prev.epoch === this.epoch) {
      if (prev.hash === hash) {
        return {
          kind: 'unchanged',
          path,
          view,
          epoch: this.epoch,
          hash,
          baseHash: prev.hash,
          bytes,
          note: 'unchanged since you last read it this context — reuse the content you already have',
        }
      }
      const patch = createTwoFilesPatch(path, path, prev.content, content, '', '', { context: 3 })
      const baseHash = prev.hash
      this.setEntry(key, content, hash)
      return {
        kind: 'diff',
        path,
        view,
        epoch: this.epoch,
        hash,
        baseHash,
        bytes,
        patch,
        note: 'apply this unified diff to the version of this file you already have',
      }
    }

    // First read of this view this epoch (or after compaction) -> full content.
    this.setEntry(key, content, hash)
    return { kind: 'full', path, view, epoch: this.epoch, hash, bytes, content }
  }
}

/** Reconstruct the content the model would hold after applying a ReadResult. Used by
 *  tests/bench to PROVE losslessness (reconstruction must equal truth). */
export function applyToModelView(prev: string | undefined, r: ReadResult): string {
  if (r.kind === 'full') return r.content!
  if (r.kind === 'unchanged') {
    if (prev === undefined) throw new Error(`unchanged marker for ${r.path} but model had no prior content`)
    return prev
  }
  if (prev === undefined) throw new Error(`diff for ${r.path} but model had no prior content`)
  const out = applyPatch(prev, r.patch!)
  if (out === false) throw new Error(`patch failed to apply for ${r.path} (losslessness violation)`)
  return out
}
