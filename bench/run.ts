// Benchmark + losslessness proof.
//
// Replays a realistic agent workload (explore -> edit/reread loop -> compaction ->
// continue) two ways and counts REAL tokens with a real tokenizer:
//   baseline  = what the native Read tool injects (full file content on every read)
//   lossless  = what this engine returns (full first time, diff after an edit, marker if
//               unchanged), resetting at the compaction boundary (epoch bump)
//
// While running, it maintains the model's reconstructed view (full + diffs + markers) and
// asserts byte-for-byte that it equals the true file content after EVERY op. If any op
// breaks that, the run fails: "drastically saves tokens" is meaningless if it isn't lossless.

import { encode } from 'gpt-tokenizer'
import { LosslessEngine, applyToModelView, hashContent, type ReadResult } from '../src/engine.ts'

const tok = (s: string) => encode(s).length

// ---- deterministic pseudo-random (reproducible benchmark) ----
let seed = 1234567
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]

// ---- a tiny "filesystem" of source files (arrays of lines we can mutate) ----
function genFile(name: string, lines: number): string[] {
  const out: string[] = [`// ${name} — generated source`, `import { thing } from './thing'`, '']
  for (let i = 0; i < lines; i++) {
    if (i % 17 === 0) out.push(`export function fn_${name}_${i}(a: number, b: number): number {`)
    else if (i % 17 === 16) out.push('}')
    else out.push(`  const v${i} = compute(a, b) + ${i} // line ${i} of ${name}`)
  }
  return out
}

const files: Record<string, string[]> = {
  'src/app.ts': genFile('app', 600),
  'src/router.ts': genFile('router', 420),
  'src/db.ts': genFile('db', 300),
  'src/auth.ts': genFile('auth', 260),
  'src/util.ts': genFile('util', 150),
  'src/handlers.ts': genFile('handlers', 500),
}
const content = (p: string) => files[p].join('\n')
function edit(p: string): void {
  // realistic small edit: change ~4 lines somewhere in the middle
  const arr = files[p]
  const start = Math.floor(rnd() * (arr.length - 10)) + 5
  for (let i = 0; i < 4; i++) arr[start + i] = `  const edited${start + i} = patched(${start + i}) // changed`
}

// ---- the model's reconstructed view, for the losslessness assertion ----
const modelView = new Map<string, string>()
let qualityViolations = 0
function applyAndCheck(p: string, r: ReadResult): void {
  const reconstructed = applyToModelView(modelView.get(p), r)
  modelView.set(p, reconstructed)
  if (reconstructed !== content(p)) {
    qualityViolations++
    console.error(`  QUALITY VIOLATION on ${p}: model view != truth`)
  }
}

// ---- token accounting ----
const engine = new LosslessEngine()
let baseTokens = 0
let lossTokens = 0
const counts: Record<ReadKind, number> = { full: 0, unchanged: 0, diff: 0 }
type ReadKind = ReadResult['kind']

function doRead(p: string): void {
  const truth = content(p)
  baseTokens += tok(truth) // native Read injects the whole file
  const r = engine.read(p, truth)
  counts[r.kind]++
  const body = r.kind === 'full' ? r.content! : r.kind === 'diff' ? r.patch! : JSON.stringify({ unchanged: true, path: r.path, hash: r.hash, note: r.note })
  lossTokens += tok(body)
  applyAndCheck(p, r)
}

const paths = Object.keys(files)

// ---- Phase A: first-contact exploration (no savings expected) ----
for (const p of paths) doRead(p)

// ---- Phase B: edit/reread loop (the real token sink) ----
for (let i = 0; i < 12; i++) {
  const p = pick(paths)
  edit(p)
  doRead(p) // reread after edit -> diff
  doRead(pick(paths)) // glance at another file -> often unchanged -> marker
}

// ---- COMPACTION: Claude Code compacts; the model loses prior bodies ----
engine.setEpoch(1)
modelView.clear() // the model genuinely no longer has the old content

// ---- Phase C: continue working after compaction (full again first time, then diffs) ----
for (const p of paths.slice(0, 4)) doRead(p) // re-acquire (full, honest)
for (let i = 0; i < 6; i++) {
  const p = pick(paths)
  edit(p)
  doRead(p)
  doRead(pick(paths))
}

// ---- report ----
const saved = baseTokens - lossTokens
const pct = ((saved / baseTokens) * 100).toFixed(1)
console.log('\n=== lossless-context-mcp benchmark ===')
console.log(`workload: ${paths.length} files, ${counts.full + counts.unchanged + counts.diff} reads ` +
  `(${counts.full} full, ${counts.diff} diff, ${counts.unchanged} unchanged), 1 compaction`)
console.log(`tokenizer: gpt-tokenizer (o200k) — relative savings hold across tokenizers`)
console.log('')
console.log(`baseline tokens (native Read, full file every time): ${baseTokens.toLocaleString()}`)
console.log(`lossless tokens (this engine):                       ${lossTokens.toLocaleString()}`)
console.log(`tokens saved:                                        ${saved.toLocaleString()}  (${pct}%)`)
console.log('')
console.log(`QUALITY: reconstruction == truth after every op? ${qualityViolations === 0 ? 'YES (0 violations) — lossless' : `NO (${qualityViolations} violations)`}`)
if (qualityViolations > 0) process.exit(1)
