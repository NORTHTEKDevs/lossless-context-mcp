import { describe, it, expect } from 'vitest'
import { LosslessEngine, applyToModelView } from '../src/engine.ts'

// A harness that mirrors the model's reconstructed view and the on-disk truth, so every
// assertion is the real losslessness invariant: what the model can reconstruct == truth.
function harness() {
  const engine = new LosslessEngine()
  const view = new Map<string, string>() // what the model holds (full + diffs + markers)
  const truth = new Map<string, string>() // current file content
  const read = (path: string, forceFull = false) => {
    const r = engine.read(path, truth.get(path) ?? '', { forceFull })
    view.set(path, applyToModelView(view.get(path), r))
    return r
  }
  const write = (path: string, content: string) => truth.set(path, content)
  const compact = (e: number) => {
    engine.setEpoch(e)
    view.clear() // the model genuinely lost prior bodies
  }
  const check = (path: string) => expect(view.get(path)).toBe(truth.get(path))
  return { engine, view, truth, read, write, compact, check }
}

describe('LosslessEngine', () => {
  it('returns full on first read, unchanged marker on identical re-read', () => {
    const h = harness()
    h.write('a.ts', 'hello\nworld\n')
    expect(h.read('a.ts').kind).toBe('full')
    expect(h.read('a.ts').kind).toBe('unchanged')
    h.check('a.ts')
  })

  it('returns a diff after an edit and the model can reconstruct truth', () => {
    const h = harness()
    h.write('a.ts', Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'))
    h.read('a.ts')
    h.write('a.ts', Array.from({ length: 200 }, (_, i) => (i === 100 ? 'EDITED 100' : `line ${i}`)).join('\n'))
    const r = h.read('a.ts')
    expect(r.kind).toBe('diff')
    // the diff must be far smaller than the full file
    expect(r.patch!.length).toBeLessThan(h.truth.get('a.ts')!.length / 2)
    h.check('a.ts')
  })

  it('reverts to full content after an epoch change (compaction) — never diffs across it', () => {
    const h = harness()
    h.write('a.ts', 'x\ny\nz\n')
    expect(h.read('a.ts').kind).toBe('full')
    expect(h.read('a.ts').kind).toBe('unchanged')
    h.compact(1)
    expect(h.read('a.ts').kind).toBe('full') // model lost it -> full again
    h.check('a.ts')
  })

  it('force_full returns full content even when a diff/marker would apply', () => {
    const h = harness()
    h.write('a.ts', 'a\nb\nc\n')
    h.read('a.ts')
    expect(h.read('a.ts', true).kind).toBe('full')
    h.check('a.ts')
  })

  it('LOSSLESS INVARIANT: 400 randomized ops (read/edit/reread/compact) never desync', () => {
    const h = harness()
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts']
    for (const p of paths) h.write(p, Array.from({ length: 120 }, (_, i) => `${p} line ${i}`).join('\n'))
    let seed = 99
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    let epoch = 0
    for (let op = 0; op < 400; op++) {
      const roll = rnd()
      if (roll < 0.12) {
        h.compact(++epoch) // compaction
      } else {
        const p = paths[Math.floor(rnd() * paths.length)]
        if (roll < 0.45) {
          // edit a few lines
          const lines = h.truth.get(p)!.split('\n')
          const at = Math.floor(rnd() * (lines.length - 2)) + 1
          lines[at] = `${p} EDITED ${op}`
          h.write(p, lines.join('\n'))
        }
        const r = h.read(p, rnd() < 0.05)
        expect(['full', 'diff', 'unchanged']).toContain(r.kind)
        h.check(p) // reconstruction must equal truth after every read
      }
    }
  })
})
