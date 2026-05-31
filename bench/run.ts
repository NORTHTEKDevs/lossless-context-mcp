// Benchmark + losslessness proof, across scenarios, to bracket savings honestly.
//
//   edit-loop  (ceiling): explore -> repeated edit/reread -> compaction -> continue
//   read-once  (floor):   read every file once, never re-read  (savings ~0 by design)
//
// baseline = full file on every read (what native Read injects); lossless = what this
// engine returns. Real tokenizer. After every op, the model's reconstructed view is checked
// byte-for-byte against truth — "drastically saves" is meaningless if it isn't lossless.

import { encode } from 'gpt-tokenizer'
import { LosslessEngine, applyToModelView, type ReadResult } from '../src/engine.ts'

const tok = (s: string) => encode(s).length

function genFile(name: string, lines: number): string[] {
  const out: string[] = [`// ${name} — generated source`, `import { thing } from './thing'`, '']
  for (let i = 0; i < lines; i++) {
    if (i % 17 === 0) out.push(`export function fn_${name}_${i}(a: number, b: number): number {`)
    else if (i % 17 === 16) out.push('}')
    else out.push(`  const v${i} = compute(a, b) + ${i} // line ${i} of ${name}`)
  }
  return out
}

interface Scenario {
  name: string
  run: (ctx: Ctx) => void
}

interface Ctx {
  files: Record<string, string[]>
  read: (p: string) => void
  edit: (p: string) => void
  compact: (e: number) => void
  rnd: () => number
}

function runScenario(s: Scenario) {
  const files: Record<string, string[]> = {
    'src/app.ts': genFile('app', 600),
    'src/router.ts': genFile('router', 420),
    'src/db.ts': genFile('db', 300),
    'src/auth.ts': genFile('auth', 260),
    'src/util.ts': genFile('util', 150),
    'src/handlers.ts': genFile('handlers', 500),
  }
  const content = (p: string) => files[p].join('\n')
  const engine = new LosslessEngine()
  const view = new Map<string, string>()
  let baseTokens = 0
  let lossTokens = 0
  let violations = 0
  const counts: Record<ReadResult['kind'], number> = { full: 0, unchanged: 0, diff: 0 }

  let seed = 1234567
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

  const read = (p: string) => {
    const truth = content(p)
    baseTokens += tok(truth)
    const r = engine.read(p, truth)
    counts[r.kind]++
    const body = r.kind === 'full' ? r.content! : r.kind === 'diff' ? r.patch! : JSON.stringify({ unchanged: true, path: r.path, hash: r.hash, note: r.note })
    lossTokens += tok(body)
    view.set(p, applyToModelView(view.get(p), r))
    if (view.get(p) !== truth) violations++
  }
  const edit = (p: string) => {
    const arr = files[p]
    const start = Math.floor(rnd() * (arr.length - 10)) + 5
    for (let i = 0; i < 4; i++) arr[start + i] = `  const edited${start + i} = patched(${start + i}) // changed`
  }
  const compact = (e: number) => { engine.setEpoch(e); view.clear() }

  s.run({ files, read, edit, compact, rnd })

  const total = counts.full + counts.diff + counts.unchanged
  const saved = baseTokens - lossTokens
  const pct = baseTokens ? ((saved / baseTokens) * 100).toFixed(1) : '0.0'
  console.log(
    `  ${s.name.padEnd(11)} | ${String(total).padStart(3)} reads ` +
      `(${counts.full}f/${counts.diff}d/${counts.unchanged}u) | base ${baseTokens.toLocaleString().padStart(9)} | ` +
      `sent ${lossTokens.toLocaleString().padStart(9)} | saved ${pct.padStart(5)}% | ` +
      `lossless: ${violations === 0 ? 'YES' : `NO(${violations})`}`,
  )
  return { pct: Number(pct), violations }
}

const editLoop: Scenario = {
  name: 'edit-loop',
  run: ({ files, read, edit, compact, rnd }) => {
    const paths = Object.keys(files)
    for (const p of paths) read(p) // explore
    for (let i = 0; i < 12; i++) { const p = paths[Math.floor(rnd() * paths.length)]; edit(p); read(p); read(paths[Math.floor(rnd() * paths.length)]) }
    compact(1)
    for (const p of paths.slice(0, 4)) read(p)
    for (let i = 0; i < 6; i++) { const p = paths[Math.floor(rnd() * paths.length)]; edit(p); read(p); read(paths[Math.floor(rnd() * paths.length)]) }
  },
}

const readOnce: Scenario = {
  name: 'read-once',
  run: ({ files, read }) => { for (const p of Object.keys(files)) read(p) },
}

console.log('\n=== lossless-context-mcp benchmark (gpt-tokenizer; relative savings hold across tokenizers) ===')
const results = [editLoop, readOnce].map(runScenario)
const anyViol = results.some((r) => r.violations > 0)
console.log(
  `\nrange: ${Math.min(...results.map((r) => r.pct))}%–${Math.max(...results.map((r) => r.pct))}% ` +
    `(floor = read-once, ceiling = edit-heavy). Quality: ${anyViol ? 'VIOLATIONS' : 'lossless in all scenarios'}.`,
)
if (anyViol) process.exit(1)
