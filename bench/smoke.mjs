// Over-the-wire smoke: drives the compiled MCP server like a real client and covers the
// happy path (full -> unchanged -> diff), slice views, every error path (binary, bad
// args, missing symbol, missing file, oversize), and the full flight-recorder loop:
// transcript sweep hook -> manifest -> inject hook -> restore_context -> export_pack ->
// receipt v2 with git binding. Exits non-zero on any failure.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'lc-smoke-'))
const fwd = (p) => p.replace(/\\/g, '/')
const ctxDir = fwd(join(tmp, 'ctx')) // isolated flight-recorder root — never the real one
const f = fwd(join(tmp, 'demo.ts'))
writeFileSync(f, Array.from({ length: 120 }, (_, i) => `const v${i} = compute(${i}) // line ${i}`).join('\n'))

function connect(env = {}) {
  const p = spawn('node', ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, LOSSLESS_CONTEXT_DIR: ctxDir, ...env },
  })
  let buf = ''
  const waiters = []
  p.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (line.trim()) (waiters.shift() || (() => {}))(JSON.parse(line))
    }
  })
  let id = 0
  const rpc = (method, params) => new Promise((r) => { waiters.push(r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n') })
  return { p, rpc }
}

async function handshake(c) {
  await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  c.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
}
const callRF = async (c, args) => { const r = await c.rpc('tools/call', { name: 'read_file', arguments: args }); return { t: r.result.content[0].text, err: r.result.isError === true } }
const callTool = async (c, name, args = {}) => (await c.rpc('tools/call', { name, arguments: args })).result.content[0].text

/** Run a hook script with a stdin payload, capturing stdout. */
function runHook(script, payload) {
  return new Promise((resolve) => {
    const p = spawn('node', [script], { env: { ...process.env, LOSSLESS_CONTEXT_DIR: ctxDir }, stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ out, code }))
    p.stdin.write(JSON.stringify(payload))
    p.stdin.end()
  })
}

const main = await connect()
await handshake(main)
const tools = (await main.rpc('tools/list')).result.tools.map((t) => t.name)
console.log('tools:', tools.join(', '))

const first = (await callRF(main, { path: f })).t
const second = (await callRF(main, { path: f })).t
writeFileSync(f, Array.from({ length: 120 }, (_, i) => (i === 60 ? 'const v60 = PATCHED(60)' : `const v${i} = compute(${i}) // line ${i}`)).join('\n'))
const third = (await callRF(main, { path: f })).t
console.log('1. first read   ->', first.slice(0, 46).replace(/\n/g, ' '))
console.log('2. reread       ->', second.slice(0, 64).replace(/\n/g, ' '))
console.log('3. after edit   ->', third.slice(0, 64).replace(/\n/g, ' '))

const sym = await callRF(main, { path: f, symbol: 'v30' })
const rng = await callRF(main, { path: f, lines: '10-12' })
console.log('4. symbol slice ->', sym.t.slice(0, 56).replace(/\n/g, ' '))
console.log('5. lines slice  ->', rng.t.slice(0, 56).replace(/\n/g, ' '))

const binFile = fwd(join(tmp, 'b.bin')); writeFileSync(binFile, Buffer.from([0x61, 0x00, 0x62, 0x00, 0x03]))
const bin = await callRF(main, { path: binFile })
const badLines = await callRF(main, { path: f, lines: 'nope' })
const noSym = await callRF(main, { path: f, symbol: 'zzz_missing' })
const missing = await callRF(main, { path: fwd(join(tmp, 'nope.ts')) })
console.log('6. error paths  -> binary:', bin.err, '| bad-lines:', badLines.err, '| no-symbol:', noSym.err, '| missing-file:', missing.err)

const stats = await callTool(main, 'context_stats')
console.log('7. stats        ->', stats.split('\n')[4].trim())

// Batch working-set read: g.ts is fresh (full), demo.ts should dedup to unchanged.
const g = fwd(join(tmp, 'g.ts')); writeFileSync(g, 'export const gg = 1\n')
const batch = await callTool(main, 'read_files', { paths: [f, g] })
console.log('8. read_files   ->', batch.split('\n')[0])

// --- Flight-recorder loop: sweep hook -> inject hook -> restore -> pack -----------------
// A fake session transcript in the (empirically observed) shape: the model natively Read
// g.ts and edited demo.ts. The sweep must archive both; the manifest must rank the edited
// file first.
const transcript = fwd(join(tmp, 'session.jsonl'))
const ts = new Date().toISOString()
writeFileSync(
  transcript,
  [
    JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: g } }] } }),
    JSON.stringify({ timestamp: ts, toolUseResult: { type: 'text', file: { filePath: g, content: 'export const gg = 1\n', numLines: 1, startLine: 1, totalLines: 1 } } }),
    JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: f, old_string: 'a', new_string: 'b' } }] } }),
  ].join('\n') + '\n',
)
const sweep = await runHook('hooks/sweep-transcript.mjs', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'smoke-session', transcript_path: transcript })
const inject = await runHook('hooks/inject-manifest.mjs', { hook_event_name: 'SessionStart', source: 'compact', session_id: 'smoke-session' })
let injected = ''
try { injected = JSON.parse(inject.out).hookSpecificOutput.additionalContext } catch {}
console.log('11. sweep+inject ->', 'sweep exit:', sweep.code, '| injected manifest head:', injected.split('\n')[1]?.trim().slice(0, 60))

const restored = await callTool(main, 'restore_context', {})
console.log('12. restore      ->', restored.split('\n')[0])

const workingSet = await callTool(main, 'working_set', {})
console.log('13. working_set  ->', workingSet.split('\n')[0])

const pack = await callTool(main, 'export_pack', { top: 3 })
console.log('14. export_pack  ->', pack.split('\n')[0])

// --- Blind-edit guard: deny (never read) -> read -> allow -------------------------------
const guardTranscript = fwd(join(tmp, 'guard-session.jsonl'))
// Realistic: the pending Edit's OWN tool_use line is already in the transcript when
// PreToolUse fires — the guard must not let the call vouch for itself.
writeFileSync(guardTranscript, JSON.stringify({
  timestamp: new Date().toISOString(),
  message: { content: [{ type: 'tool_use', id: 'pending', name: 'Edit', input: { file_path: f, old_string: 'a', new_string: 'b' } }] },
}) + '\n')
const guardPayload = (extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: f },
  session_id: 'smoke-guard', transcript_path: guardTranscript, ...extra,
})
const denied = await runHook('hooks/guard-edit.mjs', guardPayload())
let deniedDecision = ''
try { deniedDecision = JSON.parse(denied.out).hookSpecificOutput.permissionDecision } catch {}
// Model "reads" the current content -> guard must now allow.
const { readFileSync: rfs, appendFileSync: afs } = await import('node:fs')
const currentF = rfs(f, 'utf8')
afs(guardTranscript, JSON.stringify({
  timestamp: new Date(Date.now() + 1500).toISOString(),
  toolUseResult: { type: 'text', file: { filePath: f, content: currentF, numLines: 120, startLine: 1, totalLines: 120 } },
}) + '\n')
const allowed = await runHook('hooks/guard-edit.mjs', guardPayload())
console.log('15. guard        -> unread edit:', deniedDecision, '| after read: ', allowed.out === '' ? 'allowed' : 'STILL BLOCKED', '| exit codes:', denied.code, allowed.code)

// --- Context blame: MCP tool + CLI ------------------------------------------------------
const blameOut = await callTool(main, 'context_blame', { path: f })
console.log('16. blame tool   ->', blameOut.split('\n')[0])
const blameCli = await new Promise((resolve) => {
  const p = spawn('node', ['dist/index.js', 'blame', f], { env: { ...process.env, LOSSLESS_CONTEXT_DIR: ctxDir } })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.on('close', (code) => resolve({ out, code }))
})
console.log('17. blame CLI    -> exit', blameCli.code, '|', blameCli.out.split('\n')[0].slice(0, 70))

// --- init --dry-run (must not touch any real settings) ----------------------------------
const initDry = await new Promise((resolve) => {
  const p = spawn('node', ['dist/index.js', 'init', '--dry-run'], { env: { ...process.env, LOSSLESS_CONTEXT_DIR: ctxDir } })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.on('close', (code) => resolve({ out, code }))
})
console.log('18. init dry-run -> exit', initDry.code, '|', (initDry.out.split('\n')[0] || '').slice(0, 60))

// Signed context receipt v2: git binding + coverage + sweep attestation + tamper reject.
const issued = JSON.parse(await callTool(main, 'context_receipt', { artifact: 'smoke', include_sweep: true }))
const okVerify = JSON.parse(await callTool(main, 'verify_context_receipt', { receipt: issued.receipt, signature: issued.signature }))
const tampered = JSON.parse(await callTool(main, 'verify_context_receipt', { receipt: { ...issued.receipt, artifact: 'evil' }, signature: issued.signature }))
console.log(
  '19. receipt v2   -> valid:', okVerify.valid,
  '| tampered rejected:', tampered.valid === false,
  '| version:', issued.receipt.version,
  '| coverage:', issued.receipt.coverage?.sources.join('+'),
  '| swept:', (issued.receipt.sweptFiles || []).length,
  '| blob sha1 bound:', /^[0-9a-f]{40}$/.test(issued.receipt.files[0]?.gitBlobSha1 || ''),
)
main.p.stdin.end()

// Oversize path on an isolated server with a tiny cap.
const tiny = await connect({ LOSSLESS_MAX_BYTES: '5' })
await handshake(tiny)
const over = await callRF(tiny, { path: f })
console.log('20. oversize     ->', over.err, over.t.slice(0, 40).replace(/\n/g, ' '))
tiny.p.stdin.end()

const pass =
  /full content/.test(first) && /byte-identical|reuse/.test(second) && /unified diff/.test(third) &&
  /symbol v30/.test(sym.t) && /lines 10-12/.test(rng.t) &&
  bin.err && /binary/i.test(bin.t) && badLines.err && noSym.err && missing.err && over.err &&
  /byte-identical|reuse/.test(batch) && /gg = 1/.test(batch) &&
  sweep.code === 0 && injected.includes(f) && injected.includes('restore_context') &&
  restored.includes('restore:') && new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(restored) &&
  workingSet.includes('working set') &&
  pack.includes('context pack') && pack.includes('system prompt') &&
  deniedDecision === 'deny' && allowed.out === '' && denied.code === 0 && allowed.code === 0 &&
  blameOut.includes('version(s) shown to the model') && blameCli.code === 0 && blameCli.out.includes('blame') &&
  initDry.code === 0 && initDry.out.includes('dry run') &&
  okVerify.valid === true && tampered.valid === false &&
  issued.receipt.version === 2 && issued.receipt.coverage.sources.includes('transcript-sweep') &&
  (issued.receipt.sweptFiles || []).length >= 1
console.log('\nSMOKE:', pass ? 'PASS (reads + slices + batch + flight-recorder loop + guard + blame + init + receipts v2 + error paths)' : 'FAIL')
process.exit(pass ? 0 : 1)
