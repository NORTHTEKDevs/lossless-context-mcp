import { describe, it, expect } from 'vitest'
import { findSymbol, sliceLines, looksBinary } from '../src/slice.ts'
import { LosslessEngine, applyToModelView } from '../src/engine.ts'

const TS = `import { x } from './x'

export function alpha(a: number): number {
  const y = a + 1
  const acc: number[] = []
  for (let i = 0; i < 16; i++) {
    acc.push(y * i + a)
  }
  const total = acc.reduce((s, v) => s + v, 0)
  const scaled = total > 100 ? total / 2 : total * 2
  const label = 'alpha result for input ' + String(a)
  if (scaled > 1000) {
    return Math.floor(scaled)
  }
  return y + total + label.length
}

export class Beta {
  private n = 0
  method(z: string): number {
    if (z.length > 0) {
      return z.length
    }
    return 0
  }
}

const gamma = (q: number) => {
  return q * 2
}

export type Delta = { a: number; b: string }
`

const PY = `import os

def foo(a):
    b = a + 1
    if b > 0:
        return b
    return 0

class Bar:
    def m(self):
        return 1

x = 5
`

describe('findSymbol (brace family / TS)', () => {
  it('extracts a function body by name', () => {
    const s = findSymbol(TS, 'alpha', 'a.ts')!
    expect(s).not.toBeNull()
    expect(s.text).toContain('export function alpha')
    expect(s.text.trim().endsWith('}')).toBe(true)
    expect(s.text).toContain('return y')
    expect(s.text).not.toContain('class Beta') // stops at alpha's close
  })
  it('extracts a class with nested braces', () => {
    const s = findSymbol(TS, 'Beta', 'a.ts')!
    expect(s.text).toContain('class Beta')
    expect(s.text).toContain('method(z: string)')
    expect(s.text.trim().endsWith('}')).toBe(true)
    expect(s.text).not.toContain('const gamma')
  })
  it('extracts an arrow assignment', () => {
    const s = findSymbol(TS, 'gamma', 'a.ts')!
    expect(s.text).toContain('const gamma')
    expect(s.text).toContain('return q * 2')
  })
  it('extracts a one-liner type', () => {
    const s = findSymbol(TS, 'Delta', 'a.ts')!
    expect(s.text).toContain('export type Delta')
  })
  it('does not truncate at a brace inside a string or comment (M2 fix)', () => {
    const src = `function f() {\n  const s = "}"  // a } in a comment too\n  return 1\n}\nfunction g() { return 2 }`
    const s = findSymbol(src, 'f', 'a.ts')!
    expect(s.text).toContain('return 1')
    expect(s.text.trim().endsWith('}')).toBe(true)
    expect(s.text).not.toContain('function g')
  })
  it('returns null for an unknown symbol', () => {
    expect(findSymbol(TS, 'doesNotExist', 'a.ts')).toBeNull()
  })
})

describe('findSymbol (indent family / Python)', () => {
  it('extracts a def by indentation', () => {
    const s = findSymbol(PY, 'foo', 'a.py')!
    expect(s.text).toContain('def foo(a):')
    expect(s.text).toContain('return 0')
    expect(s.text).not.toContain('class Bar') // dedent ends the block
  })
  it('extracts a class block', () => {
    const s = findSymbol(PY, 'Bar', 'a.py')!
    expect(s.text).toContain('class Bar:')
    expect(s.text).toContain('def m(self):')
    expect(s.text).not.toContain('x = 5')
  })
})

describe('sliceLines + looksBinary', () => {
  it('returns the requested inclusive range, clamped', () => {
    const c = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n')
    expect(sliceLines(c, 3, 5).text).toBe('L3\nL4\nL5')
    expect(sliceLines(c, 8, 100).end).toBe(10) // clamped
  })
  it('detects binary content', () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true) // NUL
    expect(looksBinary(Buffer.from('plain text\nok', 'utf8'))).toBe(false)
  })
})

describe('slice views dedup independently and losslessly', () => {
  it('re-reading the same symbol unchanged -> marker; changed -> diff', () => {
    const e = new LosslessEngine()
    const symV = { view: 'sym:alpha' }
    const view = new Map<string, string>()
    const apply = (r: any) => view.set(r.view, applyToModelView(view.get(r.view), r))

    const r1 = e.read('a.ts', findSymbol(TS, 'alpha', 'a.ts')!.text, symV)
    apply(r1)
    expect(r1.kind).toBe('full')
    const r2 = e.read('a.ts', findSymbol(TS, 'alpha', 'a.ts')!.text, symV)
    apply(r2)
    expect(r2.kind).toBe('unchanged')

    // full view is a DIFFERENT key — first full read is full even though the symbol was seen
    const rFull = e.read('a.ts', TS, { view: 'full' })
    expect(rFull.kind).toBe('full')

    // change the symbol's content -> diff on the symbol view, reconstructable
    const edited = TS.replace('const y = a + 1', 'const y = a + 99')
    const r3 = e.read('a.ts', findSymbol(edited, 'alpha', 'a.ts')!.text, symV)
    apply(r3)
    expect(r3.kind).toBe('diff')
    expect(view.get('sym:alpha')).toBe(findSymbol(edited, 'alpha', 'a.ts')!.text)
  })
})
