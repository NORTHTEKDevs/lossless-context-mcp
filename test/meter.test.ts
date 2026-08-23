import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextMeter, repoRootOf, usd } from '../src/meter.js'

describe('repoRootOf', () => {
  it('finds the nearest .git ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'meter-'))
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'src', 'deep'), { recursive: true })
    writeFileSync(join(root, 'src', 'deep', 'x.ts'), 'x')
    expect(repoRootOf(join(root, 'src', 'deep', 'x.ts'))).toBe(root)
  })
  it('falls back to the filesystem root when no .git exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'meter-nogit-'))
    writeFileSync(join(root, 'y.ts'), 'y')
    const r = repoRootOf(join(root, 'y.ts'))
    expect(r).toBeTruthy()
    expect(r.includes('.git')).toBe(false)
  })
})

describe('ContextMeter', () => {
  const rec = (m: ContextMeter, path: string, kind: 'full' | 'diff' | 'unchanged', baseline: number, sent: number) =>
    m.record({ path, view: 'full', kind, epoch: 0, hash: 'h', bytes: 1, baselineTokens: baseline, sentTokens: sent })

  it('totals and kind counts', () => {
    const m = new ContextMeter()
    rec(m, 'C:/a.ts', 'full', 100, 100)
    rec(m, 'C:/a.ts', 'unchanged', 100, 10)
    rec(m, 'C:/b.ts', 'diff', 100, 30)
    expect(m.totals()).toEqual({
      reads: 3,
      kinds: { full: 1, diff: 1, unchanged: 1 },
      baselineTokens: 300,
      sentTokens: 140,
      savedTokens: 160,
    })
  })

  it('byRepo aggregates and sorts by sent tokens', () => {
    const m = new ContextMeter()
    rec(m, 'C:/a.ts', 'full', 10, 10)
    rec(m, 'C:/b.ts', 'full', 500, 500)
    const repos = m.byRepo()
    expect(repos[0].sentTokens).toBeGreaterThanOrEqual(repos[repos.length - 1].sentTokens)
    expect(repos.reduce((n, r) => n + r.reads, 0)).toBe(2)
  })

  it('topFiles ranks by sent tokens', () => {
    const m = new ContextMeter()
    rec(m, 'C:/small.ts', 'full', 10, 10)
    rec(m, 'C:/big.ts', 'full', 900, 900)
    rec(m, 'C:/big.ts', 'unchanged', 900, 9)
    const top = m.topFiles(2)
    expect(top[0].path).toBe('C:/big.ts')
    expect(top[0].reads).toBe(2)
    expect(top[0].sentTokens).toBe(909)
  })
})

describe('usd', () => {
  it('prices tokens per MTok', () => {
    expect(usd(1_000_000, 3)).toBe('$3.0000')
    expect(usd(50_000, 3)).toBe('$0.1500')
  })
})
