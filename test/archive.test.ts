import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archive, approxTokens, isExcluded } from '../src/archive.ts'
import { hashContent } from '../src/engine.ts'
import { gitBlobSha1 } from '../src/gitid.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lcm-archive-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isExcluded (secret hygiene)', () => {
  it('denies the classic secret shapes', () => {
    for (const p of [
      '/proj/.env',
      '/proj/.env.production',
      'C:\\proj\\.env.local',
      '/home/u/.ssh/config',
      '/home/u/.aws/credentials',
      '/certs/server.pem',
      '/certs/private.key',
      '/home/u/.ssh/id_rsa',
      '/home/u/id_ed25519.pub',
      '/app/secrets.json',
      '/app/config/db-credentials.yaml',
      '/home/u/.npmrc',
      '/home/u/.netrc',
    ])
      expect(isExcluded(p), p).toBe(true)
  })
  it('allows ordinary code paths, including ones with near-miss names', () => {
    for (const p of [
      '/proj/src/index.ts',
      '/proj/environment.ts', // not .env
      '/proj/src/keyboard.ts', // .key only as extension is denied, not substring
      '/proj/monkey.ts',
      '/proj/README.md',
      '/proj/test/envelope.test.ts',
    ])
      expect(isExcluded(p), p).toBe(false)
  })
  it('honors LOSSLESS_ARCHIVE_EXCLUDE user patterns', () => {
    process.env.LOSSLESS_ARCHIVE_EXCLUDE = '*.sql,notes-private.md'
    try {
      expect(isExcluded('/data/dump.sql')).toBe(true)
      expect(isExcluded('/docs/notes-private.md')).toBe(true)
      expect(isExcluded('/docs/notes.md')).toBe(false)
    } finally {
      delete process.env.LOSSLESS_ARCHIVE_EXCLUDE
    }
  })
})

describe('isExcluded symlink bypass (review finding #1)', () => {
  it('denies an innocuously named symlink pointing at a secret', () => {
    const { symlinkSync, writeFileSync: wf, mkdirSync } = require('node:fs') as typeof import('node:fs')
    const secretDir = join(root, 'private')
    mkdirSync(secretDir, { recursive: true })
    const secret = join(secretDir, '.env')
    wf(secret, 'API_KEY=x')
    const link = join(root, 'innocent-notes.txt')
    try {
      symlinkSync(secret, link)
    } catch {
      return // symlink creation needs privilege on some Windows setups — skip, not fail
    }
    expect(isExcluded(link)).toBe(true)
    expect(isExcluded(join(root, 'innocent-missing.txt'))).toBe(false)
  })
})

describe('Archive blobs', () => {
  it('putBlob stores by hash, is idempotent, and getBlob round-trips', () => {
    const a = new Archive(root)
    const content = 'export const x = 1\n'
    const h = hashContent(content)
    const first = a.putBlob(content, h)
    expect(first.stored).toBe(true)
    expect(first.bytes).toBe(Buffer.byteLength(content))
    expect(first.gitSha1).toBe(gitBlobSha1(content))
    const second = a.putBlob(content, h)
    expect(second.stored).toBe(false)
    expect(a.getBlob(h)).toBe(content)
    expect(a.getBlob('0'.repeat(64))).toBeNull()
  })

  it('putBlob THROWS on a genuine write failure instead of claiming success (review finding #2)', () => {
    const a = new Archive(root)
    const content = 'will not be storable'
    const h = hashContent(content)
    // Occupy the shard path with a FILE so mkdir/rename cannot succeed.
    writeFileSync(join(root, 'blobs', h.slice(0, 2)), 'not a directory', 'utf8')
    expect(() => a.putBlob(content, h)).toThrow()
    expect(a.hasBlob(h)).toBe(false)
  })
})

describe('Archive events', () => {
  it('record/readEvents round-trips and merges writers, oldest-first', () => {
    const a = new Archive(root, 'writer-a')
    const b = new Archive(root, 'writer-b')
    const base = { path: '/p/f.ts', repo: '/p', hash: 'h1', bytes: 10, approxTokens: 3, source: 'mcp' as const, op: 'read' as const, view: 'full' }
    a.record({ ...base, session: 's1' })
    b.record({ ...base, session: 's2', path: '/p/g.ts' })
    const events = new Archive(root, 'writer-c').readEvents()
    expect(events).toHaveLength(2)
    expect(new Set(events.map((e) => e.session))).toEqual(new Set(['s1', 's2']))
    expect(events[0].ts <= events[1].ts).toBe(true)
  })
  it('skips corrupt lines instead of failing', () => {
    const a = new Archive(root, 'writer-a')
    a.record({ session: 's', path: '/p/f.ts', repo: '/p', hash: 'h', bytes: 1, approxTokens: 1, source: 'mcp', op: 'read', view: 'full' })
    writeFileSync(join(root, 'events', 'writer-x.jsonl'), 'not json\n{"also": "not an event"}\n', 'utf8')
    expect(a.readEvents()).toHaveLength(1)
  })
  it('sinceMs filters old events', () => {
    const a = new Archive(root, 'w')
    a.record({ session: 's', path: '/p/f.ts', repo: '/p', hash: 'h', bytes: 1, approxTokens: 1, source: 'mcp', op: 'read', view: 'full' })
    expect(a.readEvents({ sinceMs: Date.now() + 60_000 })).toHaveLength(0)
    expect(a.readEvents({ sinceMs: Date.now() - 60_000 })).toHaveLength(1)
  })
})

describe('Archive budget', () => {
  it('evicts oldest blobs over the byte budget', () => {
    const a = new Archive(root)
    const contents = ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000)]
    const hashes = contents.map((c) => {
      const h = hashContent(c)
      a.putBlob(c, h)
      return h
    })
    // Make the first blob clearly the oldest.
    const old = new Date(Date.now() - 3600_000)
    utimesSync(a.blobPath(hashes[0]), old, old)
    const { evictedBlobs } = a.enforceBudget(2500)
    expect(evictedBlobs).toBe(1)
    expect(a.hasBlob(hashes[0])).toBe(false)
    expect(a.hasBlob(hashes[1])).toBe(true)
    expect(a.hasBlob(hashes[2])).toBe(true)
  })
})

describe('approxTokens', () => {
  it('is chars/4 rounded up', () => {
    expect(approxTokens('abcd')).toBe(1)
    expect(approxTokens('abcde')).toBe(2)
    expect(approxTokens('')).toBe(0)
  })
})
