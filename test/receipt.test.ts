import { describe, it, expect } from 'vitest'
import { buildContextReceipt, signReceipt, verifyReceipt, stableStringify } from '../src/receipt.js'
import type { MeterEvent } from '../src/meter.js'

const ev = (over: Partial<MeterEvent>): MeterEvent => ({
  ts: '2026-07-05T00:00:00.000Z',
  path: 'C:/repo/a.ts',
  repo: 'C:/repo',
  view: 'full',
  kind: 'full',
  epoch: 0,
  hash: 'h1',
  bytes: 100,
  baselineTokens: 50,
  sentTokens: 50,
  ...over,
})

describe('stableStringify', () => {
  it('is independent of object key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      stableStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    )
  })
  it('distinguishes different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }))
  })
})

describe('buildContextReceipt', () => {
  it('aggregates per file/view with hash history and totals', () => {
    const events = [
      ev({}),
      ev({ kind: 'unchanged', sentTokens: 5 }),
      ev({ kind: 'diff', hash: 'h2', baseHash: 'h1', sentTokens: 12 }),
      ev({ path: 'C:/repo/b.ts', hash: 'hb', baselineTokens: 20, sentTokens: 20 }),
    ]
    const r = buildContextReceipt(events, 'ticket-42', new Date('2026-07-05T01:00:00Z'))
    expect(r.artifact).toBe('ticket-42')
    expect(r.totals).toEqual({ reads: 4, files: 2, baselineTokens: 170, sentTokens: 87 })
    const a = r.files.find((f) => f.path === 'C:/repo/a.ts')!
    expect(a.reads).toBe(3)
    expect(a.kinds).toEqual({ full: 1, diff: 1, unchanged: 1 })
    expect(a.finalHash).toBe('h2')
    expect(a.hashesSeen).toEqual(['h1', 'h2'])
  })

  it('is deterministic for the same events and timestamp', () => {
    const events = [ev({}), ev({ kind: 'unchanged', sentTokens: 5 })]
    const t = new Date('2026-07-05T01:00:00Z')
    expect(stableStringify(buildContextReceipt(events, 'x', t))).toBe(stableStringify(buildContextReceipt(events, 'x', t)))
  })
})

describe('sign/verify', () => {
  const key = 'test-key'
  const receipt = buildContextReceipt([ev({})], 'artifact', new Date('2026-07-05T01:00:00Z'))

  it('verifies a genuine signature', () => {
    expect(verifyReceipt(receipt, signReceipt(receipt, key), key)).toBe(true)
  })
  it('rejects a tampered receipt', () => {
    const sig = signReceipt(receipt, key)
    const tampered = { ...receipt, artifact: 'other' }
    expect(verifyReceipt(tampered, sig, key)).toBe(false)
  })
  it('rejects the wrong key and malformed signatures', () => {
    const sig = signReceipt(receipt, key)
    expect(verifyReceipt(receipt, sig, 'wrong-key')).toBe(false)
    expect(verifyReceipt(receipt, 'short', key)).toBe(false)
    expect(verifyReceipt(receipt, '', key)).toBe(false)
  })
  it('signature is stable under field reordering', () => {
    const reordered = Object.fromEntries(Object.entries(receipt).reverse()) as typeof receipt
    expect(signReceipt(reordered, key)).toBe(signReceipt(receipt, key))
  })
})
