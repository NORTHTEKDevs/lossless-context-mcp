import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archive, approxTokens } from '../src/archive.ts'
import { hashContent } from '../src/engine.ts'
import { gitBlobSha1, readGitHead } from '../src/gitid.ts'
import { buildPack, renderPack } from '../src/pack.ts'
import { loadManifest, renderManifest, writeManifest } from '../src/restore.ts'
import type { WorkingSetEntry } from '../src/sweep.ts'

let ctxRoot: string
let work: string
beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'lcm-ctx-'))
  work = mkdtempSync(join(tmpdir(), 'lcm-pwork-'))
  process.env.LOSSLESS_CONTEXT_DIR = ctxRoot
})
afterEach(() => {
  delete process.env.LOSSLESS_CONTEXT_DIR
  rmSync(ctxRoot, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

const entry = (path: string, over: Partial<WorkingSetEntry> = {}): WorkingSetEntry => ({
  path,
  hash: 'h-' + path,
  bytes: 100,
  approxTokens: 25,
  reads: 1,
  edits: 0,
  lastOp: 'read',
  lastTs: '2026-08-10T01:00:00.000Z',
  ...over,
})

describe('manifests', () => {
  it('write/load round-trips by exact session id', () => {
    writeManifest('sess-abc', [entry('/x/a.ts'), entry('/x/b.ts', { edits: 2, lastOp: 'edit' })])
    const m = loadManifest('sess-abc')
    expect(m?.session).toBe('sess-abc')
    expect(m?.entries).toHaveLength(2)
  })
  it('falls back to the most recent manifest when the session id is unknown', () => {
    writeManifest('older', [entry('/x/old.ts')], new Date(Date.now() - 1000))
    writeManifest('newer', [entry('/x/new.ts')])
    const m = loadManifest('never-seen-session')
    expect(m?.session).toBeDefined()
    // Recency by file mtime: the second write is newer.
    expect(m?.entries[0].path).toBe('/x/new.ts')
  })
  it('returns null when nothing exists (no manifest, no dir)', () => {
    expect(loadManifest('nope')).toBeNull()
  })
  it('caps stored entries at the top-K and renders under the harness injection limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => entry(`/x/file-${i}.ts`))
    writeManifest('big', many)
    const m = loadManifest('big')!
    expect(m.entries.length).toBeLessThanOrEqual(12)
    const rendered = renderManifest(m)
    expect(rendered.length).toBeLessThan(9500)
    expect(rendered).toContain('restore_context')
    expect(rendered).toContain('/x/file-0.ts')
  })
})

describe('buildPack', () => {
  const seed = (archive: Archive) => {
    // hot.ts: read in 3 sessions, 1 version -> top score. churn.ts: many versions -> divided.
    const hot = join(work, 'hot.ts')
    const churn = join(work, 'churn.ts')
    const secret = join(work, '.env')
    writeFileSync(hot, 'stable reference content\n')
    writeFileSync(churn, 'version N\n')
    writeFileSync(secret, 'KEY=v\n')
    const base = { path: hot, repo: work, bytes: 10, approxTokens: 3, source: 'sweep' as const, op: 'read' as const, view: 'full' }
    for (const s of ['s1', 's2', 's3']) archive.record({ ...base, session: s, hash: 'h-stable' })
    for (let i = 0; i < 5; i++) archive.record({ ...base, session: 's1', path: churn, hash: 'h-' + i })
    archive.record({ ...base, session: 's1', path: secret, hash: 'h-x', excluded: true })
    return { hot, churn }
  }

  it('ranks breadth-over-churn, skips excluded, and renders deterministically', () => {
    const archive = new Archive(join(ctxRoot, 'archive'), 'w1')
    const { hot, churn } = seed(archive)
    const pack = buildPack(archive, { top: 2 })
    expect(pack.files.map((f) => f.path)).toEqual([hot, churn])
    expect(pack.files[0].sessions).toBe(3)
    expect(pack.files[0].gitBlobSha1).toBe(gitBlobSha1('stable reference content\n'))
    const r1 = renderPack(pack)
    const r2 = renderPack(buildPack(archive, { top: 2 }))
    expect(r1).toBe(r2) // byte-stable — required for the prompt-cache win
    expect(r1).toContain('SYSTEM PROMPT'.toLowerCase().slice(0, 0) + 'system prompt')
    expect(r1).not.toContain('KEY=v')
  })

  it('respects the token budget and reports skips', () => {
    const archive = new Archive(join(ctxRoot, 'archive'), 'w1')
    const big = join(work, 'big.ts')
    writeFileSync(big, 'x'.repeat(8000)) // ~2000 approx tokens
    const base = { repo: work, bytes: 10, approxTokens: 3, source: 'sweep' as const, op: 'read' as const, view: 'full' }
    for (const s of ['s1', 's2']) archive.record({ ...base, session: s, path: big, hash: 'h-big' })
    const pack = buildPack(archive, { budgetTokens: 1000 })
    expect(pack.files).toHaveLength(0)
    expect(pack.skipped.some((s) => s.path === big && s.reason.includes('over budget'))).toBe(true)
  })

  it('filters by repo when asked', () => {
    const archive = new Archive(join(ctxRoot, 'archive'), 'w1')
    seed(archive)
    const other = buildPack(archive, { repo: '/some/other/repo' })
    expect(other.files).toHaveLength(0)
  })
})

describe('gitid', () => {
  it('gitBlobSha1 matches git hash-object on a known vector', () => {
    // `echo hello | git hash-object --stdin` == ce013625030ba8dba906f756967f9e9ca394464a
    expect(gitBlobSha1('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })
  it('readGitHead resolves THIS repo to a branch and 40-hex sha', () => {
    const head = readGitHead(join(import.meta.dirname, '..'))
    expect(head.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(head.branch).toBeTruthy()
  })
  it('readGitHead returns {} for a non-repo', () => {
    expect(readGitHead(work)).toEqual({})
  })
})

describe('approxTokens sanity for budgets', () => {
  it('scales with content size', () => {
    expect(approxTokens('x'.repeat(8000))).toBe(2000)
  })
})
