// Signed context receipts: an auditable, verifiable answer to "exactly what did the
// model see this session?"
//
// A receipt is a deterministic summary of the meter's event trail — every file the model
// was shown, which content versions (SHA-256), how it was delivered (full/diff/unchanged),
// and the token totals — HMAC-SHA256 signed. It composes with trust-mcp receipts (which
// certify what the agent DID); by default both sign with the same key file, so one key
// verifies the whole evidence chain: what the agent saw + what it did.
//
// Only the derivation from events is deterministic; `ts` is stamped at build time and is
// part of the signed payload like any other field.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MeterEvent } from './meter.js'

export interface FileAttestation {
  path: string
  view: string
  reads: number
  kinds: { full: number; diff: number; unchanged: number }
  /** SHA-256 of the content version the model holds after its last read. */
  finalHash: string
  /** Every distinct content version the model was shown, in first-seen order. */
  hashesSeen: string[]
}

export interface ContextReceipt {
  kind: 'context-receipt'
  version: 1
  artifact: string
  ts: string
  epochs: number[]
  files: FileAttestation[]
  totals: { reads: number; files: number; baselineTokens: number; sentTokens: number }
}

/** JSON with recursively sorted object keys, so signatures are field-order independent. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'
}

export function buildContextReceipt(events: MeterEvent[], artifact: string, now = new Date()): ContextReceipt {
  const byKey = new Map<string, FileAttestation>()
  const epochs = new Set<number>()
  let baseline = 0
  let sent = 0
  for (const e of events) {
    epochs.add(e.epoch)
    baseline += e.baselineTokens
    sent += e.sentTokens
    // JSON-encode [path, view] rather than concatenating with a "::" separator: a bare
    // `path + '::' + view` join is ambiguous — path "dir::sub" view "full" and path "dir"
    // view "sub::full" both concatenate to "dir::sub::full" and would silently merge into
    // one file attestation, letting one receipt misrepresent which file a hash belongs to.
    // JSON.stringify escapes embedded quotes/delimiters, so distinct [path, view] pairs
    // always produce distinct keys.
    const key = JSON.stringify([e.path, e.view])
    let f = byKey.get(key)
    if (!f) {
      f = { path: e.path, view: e.view, reads: 0, kinds: { full: 0, diff: 0, unchanged: 0 }, finalHash: e.hash, hashesSeen: [] }
      byKey.set(key, f)
    }
    f.reads++
    f.kinds[e.kind]++
    f.finalHash = e.hash
    if (!f.hashesSeen.includes(e.hash)) f.hashesSeen.push(e.hash)
  }
  const files = [...byKey.values()].sort((a, b) => (a.path + a.view < b.path + b.view ? -1 : 1))
  return {
    kind: 'context-receipt',
    version: 1,
    artifact,
    ts: now.toISOString(),
    epochs: [...epochs].sort((a, b) => a - b),
    files,
    totals: {
      reads: events.length,
      files: files.length,
      baselineTokens: baseline,
      sentTokens: sent,
    },
  }
}

/** Key: LOSSLESS_RECEIPT_KEY env, else the shared trust key file (created 0600 if absent). */
export function receiptKey(): { key: string; source: string } {
  if (process.env.LOSSLESS_RECEIPT_KEY) return { key: process.env.LOSSLESS_RECEIPT_KEY, source: 'env:LOSSLESS_RECEIPT_KEY' }
  const file = process.env.LOSSLESS_RECEIPT_KEYFILE || join(homedir(), '.claude', 'state', 'trust-receipt.key')
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  return { key: readFileSync(file, 'utf8').trim(), source: file }
}

export function signReceipt(receipt: ContextReceipt, key: string): string {
  return createHmac('sha256', key).update(stableStringify(receipt)).digest('hex')
}

export function verifyReceipt(receipt: ContextReceipt, signature: string, key: string): boolean {
  const expected = Buffer.from(signReceipt(receipt, key), 'utf8')
  const given = Buffer.from(String(signature || ''), 'utf8')
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}
