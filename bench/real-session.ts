// Real-session benchmark: replay actual Claude Code Read tool calls through the lossless engine
// to measure TRUE savings (the milestone the README flags as required before any headline claim).
//
// Method: for each transcript file (treated as ONE epoch = most favorable to the engine, so the
// result is an UPPER BOUND; intra-session compaction which clears the ledger is not modeled),
// replay every native `Read` result in order. baseline = full content every read (what native Read
// injects); lossless = full on first read of a (path,view), tiny marker on unchanged re-read,
// unified diff on changed re-read. Losslessness is verified by reconstructing the model view.
//
// Tokens: gpt-tokenizer on a calibration sample; chars/4 across the full corpus for speed. Both reported.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LosslessEngine, applyToModelView, normalizeKey, type ReadResult } from '../src/engine.ts'
import { encode } from 'gpt-tokenizer'

const ROOT = process.argv[2] || join(process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'projects')
const REAL_TOK = process.argv.includes('--real')
const est = (s: string) => Math.ceil(s.length / 4)
const tok = REAL_TOK ? (s: string) => encode(s).length : est
const MARKER = (r: ReadResult) => JSON.stringify({ unchanged: true, path: r.path, hash: r.hash, note: r.note })

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let s
    try { s = statSync(p) } catch { continue }
    if (s.isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

function viewKey(input: any): string {
  if (input?.symbol) return 'sym:' + input.symbol
  if (input?.offset != null || input?.limit != null) return `lines:${input.offset ?? 0}-${input.limit ?? ''}`
  return 'full'
}

let sessions = 0, sessionsWithReads = 0
let reads = 0, firstReads = 0, unchanged = 0, diffs = 0, violations = 0
let baseTok = 0, lossTok = 0
let baseBytes = 0
const rereadPerSession: number[] = []

const files = walk(ROOT)
for (const file of files) {
  sessions++
  let data: string
  try { data = readFileSync(file, 'utf8') } catch { continue }
  const engine = new LosslessEngine()
  const view = new Map<string, string>()
  const pending = new Map<string, { path: string; view: string }>() // tool_use_id -> read meta
  let sessReads = 0, sessRereads = 0

  for (const line of data.split('\n')) {
    if (!line) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    const content = o.message?.content
    if (!Array.isArray(content)) continue
    for (const it of content) {
      if (it.type === 'tool_use' && it.name === 'Read' && it.input?.file_path) {
        pending.set(it.id, { path: String(it.input.file_path), view: viewKey(it.input) })
      } else if (it.type === 'tool_result' && pending.has(it.tool_use_id)) {
        const meta = pending.get(it.tool_use_id)!
        pending.delete(it.tool_use_id)
        const body = typeof it.content === 'string'
          ? it.content
          : Array.isArray(it.content) ? it.content.map((x: any) => x?.text ?? '').join('') : ''
        if (!body || it.is_error) continue
        reads++; sessReads++
        baseTok += tok(body); baseBytes += body.length
        const r = engine.read(meta.path, body, { view: meta.view })
        if (r.kind === 'full') { firstReads++; lossTok += tok(r.content!) }
        else if (r.kind === 'unchanged') { unchanged++; sessRereads++; lossTok += tok(MARKER(r)) }
        else { diffs++; sessRereads++; lossTok += tok(r.patch!) }
        const recon = applyToModelView(view.get(normalizeKey(meta.path) + '::' + meta.view), r)
        view.set(normalizeKey(meta.path) + '::' + meta.view, recon)
        if (recon !== body) violations++
      }
    }
  }
  if (sessReads > 0) { sessionsWithReads++; rereadPerSession.push(sessRereads / sessReads) }
}

const saved = baseTok - lossTok
const pct = baseTok ? (saved / baseTok) * 100 : 0
const rereadRate = reads ? ((unchanged + diffs) / reads) * 100 : 0
const medianRR = rereadPerSession.sort((a, b) => a - b)[Math.floor(rereadPerSession.length / 2)] ?? 0

console.log('\n=== lossless-context-mcp REAL-SESSION benchmark ===')
console.log(`tokenizer:        ${REAL_TOK ? 'gpt-tokenizer (real)' : 'chars/4 (estimate)'}`)
console.log(`transcripts:      ${sessions} files, ${sessionsWithReads} with >=1 Read`)
console.log(`Read calls:       ${reads.toLocaleString()}`)
console.log(`  first-reads:    ${firstReads.toLocaleString()} (full content always sent)`)
console.log(`  unchanged re:   ${unchanged.toLocaleString()} (-> tiny marker)`)
console.log(`  changed re:     ${diffs.toLocaleString()} (-> unified diff)`)
console.log(`re-read rate:     ${rereadRate.toFixed(1)}%  (savings ONLY come from these)`)
console.log(`median per-session re-read share: ${(medianRR * 100).toFixed(1)}%`)
console.log(`baseline tokens:  ${Math.round(baseTok).toLocaleString()}  (${(baseBytes / 1e6).toFixed(0)} MB read)`)
console.log(`lossless tokens:  ${Math.round(lossTok).toLocaleString()}`)
console.log(`SAVED:            ${Math.round(saved).toLocaleString()} tokens = ${pct.toFixed(1)}%  (UPPER BOUND: 1 epoch/session)`)
console.log(`losslessness:     ${violations === 0 ? 'CLEAN (0 violations)' : 'VIOLATIONS=' + violations}`)
