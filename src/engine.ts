// Lossless context engine.
//
// The core guarantee: the engine NEVER withholds or diffs content it cannot prove
// the model still has. "Proof" is bounded by the context EPOCH. Within one epoch the
// engine knows exactly what bytes it has already returned for a path (it returned them),
// so a re-read of unchanged content can be a tiny marker and a re-read after an edit can
// be a diff against the version the model provably holds. When the epoch changes
// (Claude Code compacted -> the model lost prior content), the ledger is cleared and the
// engine reverts to full content. This makes savings lossless by construction: anything
// it elides is reconstructable from what it already sent THIS epoch.
//
// Pure and deterministic: callers pass the current file content in, so the engine has no
// I/O and is trivially testable. Reconstruction (full + diffs + markers -> truth) is what
// the test/bench asserts byte-for-byte to prove "no quality sacrifice".

import { createTwoFilesPatch, applyPatch } from 'diff'

export type ReadKind = 'full' | 'unchanged' | 'diff'

export interface ReadResult {
  kind: ReadKind
  path: string
  view: string // dedup view: 'full' | 'sym:<name>' | 'lines:<a>-<b>' — distinct views dedup independently
  epoch: number
  hash: string
  bytes: number // byte length of the CURRENT full file content
  content?: string // present for 'full'
  patch?: string // present for 'diff' (unified diff: prev-as-held -> current)
  note?: string
}

interface LedgerEntry {
  epoch: number
  content: string
  hash: string
}

// FNV-1a 64-bit (as unsigned-hex string). Non-cryptographic; only used to detect change.
export function hashContent(s: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  const bytes = Buffer.from(s, 'utf8')
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i])
    h = (h * prime) & mask
  }
  return h.toString(16).padStart(16, '0')
}

export function normalizeKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

export class LosslessEngine {
  private ledger = new Map<string, LedgerEntry>()
  private epoch = 0

  /** Bump to a new epoch (e.g. after compaction). Clears the ledger: the model
   *  is assumed to retain nothing, so subsequent reads return full content. */
  setEpoch(e: number): void {
    if (e !== this.epoch) {
      this.epoch = e
      this.ledger.clear()
    }
  }

  getEpoch(): number {
    return this.epoch
  }

  /** Decide what to return for a read of `path` whose current full content is `content`.
   *  Updates the ledger to reflect what the model will hold afterward.
   *  `forceFull` skips dedup/diff and always returns full content (caller escape hatch). */
  read(path: string, content: string, opts: { forceFull?: boolean; view?: string } = {}): ReadResult {
    const forceFull = opts.forceFull === true
    const view = opts.view ?? 'full'
    const key = normalizeKey(path) + '::' + view
    const hash = hashContent(content)
    const bytes = Buffer.byteLength(content, 'utf8')
    const prev = this.ledger.get(key)

    if (!forceFull && prev && prev.epoch === this.epoch) {
      if (prev.hash === hash) {
        // Identical to what the model already has this epoch -> withhold the body.
        return {
          kind: 'unchanged',
          path,
          view,
          epoch: this.epoch,
          hash,
          bytes,
          note: 'unchanged since you last read it this context — reuse the content you already have',
        }
      }
      // Changed -> send a diff against the version the model provably holds.
      const patch = createTwoFilesPatch(path, path, prev.content, content, '', '', { context: 3 })
      this.ledger.set(key, { epoch: this.epoch, content, hash })
      return {
        kind: 'diff',
        path,
        view,
        epoch: this.epoch,
        hash,
        bytes,
        patch,
        note: 'apply this unified diff to the version of this file you already have',
      }
    }

    // First read of this view this epoch (or after compaction) -> full content.
    this.ledger.set(key, { epoch: this.epoch, content, hash })
    return { kind: 'full', path, view, epoch: this.epoch, hash, bytes, content }
  }
}

/** Reconstruct the content the model would hold after applying a ReadResult to its prior
 *  view. Used by tests/bench to PROVE losslessness (reconstruction must equal truth).
 *  Throws if a diff fails to apply (which would itself be a losslessness violation). */
export function applyToModelView(prev: string | undefined, r: ReadResult): string {
  if (r.kind === 'full') return r.content!
  if (r.kind === 'unchanged') {
    if (prev === undefined) throw new Error(`unchanged marker for ${r.path} but model had no prior content`)
    return prev
  }
  // diff
  if (prev === undefined) throw new Error(`diff for ${r.path} but model had no prior content`)
  const out = applyPatch(prev, r.patch!)
  if (out === false) throw new Error(`patch failed to apply for ${r.path} (losslessness violation)`)
  return out
}
