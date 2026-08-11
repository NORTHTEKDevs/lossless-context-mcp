import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import type { ArchiveEvent } from '../src/archive.ts'
import type { MeterEvent } from '../src/meter.ts'
import { buildContextReceipt, signReceipt, stableStringify, verifyReceipt, type ContextReceipt } from '../src/receipt.ts'

const KEY = 'test-key'
const repoRoot = join(import.meta.dirname, '..')

const meterEvent = (over: Partial<MeterEvent> = {}): MeterEvent => ({
  ts: '2026-08-10T01:00:00.000Z',
  path: join(repoRoot, 'src', 'engine.ts'),
  repo: repoRoot,
  view: 'full',
  kind: 'full',
  epoch: 1,
  hash: 'aa'.repeat(32),
  gitBlobSha1: 'bb'.repeat(20),
  bytes: 100,
  baselineTokens: 25,
  sentTokens: 25,
  ...over,
})

describe('receipt v2', () => {
  it('binds git identity: blob sha per file, repo HEAD at issue time, coverage note', () => {
    const r = buildContextReceipt([meterEvent()], 'test-artifact')
    expect(r.version).toBe(2)
    expect(r.files[0].gitBlobSha1).toBe('bb'.repeat(20))
    expect(r.repos).toHaveLength(1)
    expect(r.repos![0].repo).toBe(repoRoot)
    expect(r.repos![0].headSha).toMatch(/^[0-9a-f]{40}$/) // this repo has a real HEAD
    expect(r.coverage?.sources).toEqual(['mcp'])
    expect(r.coverage?.note).toContain('does not claim')
    expect(r.sweptFiles).toBeUndefined()
  })

  it('attests swept native reads separately with source disclosure', () => {
    const sweep: ArchiveEvent[] = [
      { ts: '2026-08-10T01:00:00.000Z', session: 's', path: '/x/native.ts', repo: '/x', hash: 'h1', gitBlobSha1: 'g1', bytes: 5, approxTokens: 2, source: 'sweep', op: 'read', view: 'full' },
      { ts: '2026-08-10T01:00:01.000Z', session: 's', path: '/x/native.ts', repo: '/x', hash: 'h2', bytes: 5, approxTokens: 2, source: 'sweep', op: 'read', view: 'full' },
      // mcp-source events must NOT land in sweptFiles even if passed in
      { ts: '2026-08-10T01:00:02.000Z', session: 's', path: '/x/mcp.ts', repo: '/x', hash: 'h3', bytes: 5, approxTokens: 2, source: 'mcp', op: 'read', view: 'full' },
    ]
    const r = buildContextReceipt([meterEvent()], 'a', new Date(), { sweepEvents: sweep })
    expect(r.coverage?.sources).toEqual(['mcp', 'transcript-sweep'])
    expect(r.sweptFiles).toHaveLength(1)
    expect(r.sweptFiles![0]).toMatchObject({ path: '/x/native.ts', reads: 2, hashesSeen: ['h1', 'h2'], gitBlobSha1: 'g1' })
  })

  it('signature survives the JSON round-trip to a client (undefined-key stripping)', () => {
    // A repo with no git -> branch/headSha undefined; sweptFiles undefined.
    const r = buildContextReceipt([meterEvent({ path: '/no-repo/f.ts', repo: '/no-repo' })], 'a')
    const sig = signReceipt(r, KEY)
    const roundTripped = JSON.parse(JSON.stringify(r)) as ContextReceipt
    expect(verifyReceipt(roundTripped, sig, KEY)).toBe(true)
  })

  it('still verifies v1 receipts unchanged (back-compat)', () => {
    const v1: ContextReceipt = {
      kind: 'context-receipt',
      version: 1,
      artifact: 'old',
      ts: '2026-08-05T00:00:00.000Z',
      epochs: [1],
      files: [{ path: '/x/a.ts', view: 'full', reads: 1, kinds: { full: 1, diff: 0, unchanged: 0 }, finalHash: 'h', hashesSeen: ['h'] }],
      totals: { reads: 1, files: 1, baselineTokens: 10, sentTokens: 10 },
    }
    const sig = signReceipt(v1, KEY)
    expect(verifyReceipt(JSON.parse(JSON.stringify(v1)), sig, KEY)).toBe(true)
    expect(verifyReceipt({ ...v1, artifact: 'tampered' }, sig, KEY)).toBe(false)
  })
})

describe('stableStringify undefined semantics (must mirror JSON.stringify)', () => {
  it('drops undefined object keys and nulls undefined array items', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(stableStringify([1, undefined, 2])).toBe('[1,null,2]')
    expect(stableStringify(undefined)).toBe('null')
  })
  it('agrees with JSON round-trip for nested undefined', () => {
    const v = { z: { y: undefined, x: 1 }, arr: [{ q: undefined }] }
    expect(stableStringify(v)).toBe(stableStringify(JSON.parse(JSON.stringify(v))))
  })
})
