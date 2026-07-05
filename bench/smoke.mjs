// Over-the-wire smoke: drives the compiled MCP server like a real client and covers the
// happy path (full -> unchanged -> diff), slice views, and every error path (binary, bad
// args, missing symbol, missing file, oversize). Exits non-zero on any failure.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'lc-smoke-'))
const fwd = (p) => p.replace(/\\/g, '/')
const f = fwd(join(tmp, 'demo.ts'))
writeFileSync(f, Array.from({ length: 120 }, (_, i) => `const v${i} = compute(${i}) // line ${i}`).join('\n'))

function connect(env = {}) {
  const p = spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } })
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

const stats = (await main.rpc('tools/call', { name: 'context_stats', arguments: {} })).result.content[0].text
console.log('7. stats        ->', stats.split('\n')[4].trim())

// Batch working-set read: g.ts is fresh (full), demo.ts should dedup to unchanged.
const g = fwd(join(tmp, 'g.ts')); writeFileSync(g, 'export const gg = 1\n')
const batch = (await main.rpc('tools/call', { name: 'read_files', arguments: { paths: [f, g] } })).result.content[0].text
console.log('8. read_files   ->', batch.split('\n')[0])

// Signed context receipt roundtrip + tamper rejection.
const issued = JSON.parse((await main.rpc('tools/call', { name: 'context_receipt', arguments: { artifact: 'smoke' } })).result.content[0].text)
const okVerify = JSON.parse((await main.rpc('tools/call', { name: 'verify_context_receipt', arguments: { receipt: issued.receipt, signature: issued.signature } })).result.content[0].text)
const tampered = JSON.parse((await main.rpc('tools/call', { name: 'verify_context_receipt', arguments: { receipt: { ...issued.receipt, artifact: 'evil' }, signature: issued.signature } })).result.content[0].text)
console.log('9. receipt      -> valid:', okVerify.valid, '| tampered rejected:', tampered.valid === false, '| files attested:', issued.receipt.totals.files)
main.p.stdin.end()

// Oversize path on an isolated server with a tiny cap.
const tiny = await connect({ LOSSLESS_MAX_BYTES: '5' })
await handshake(tiny)
const over = await callRF(tiny, { path: f })
console.log('10. oversize    ->', over.err, over.t.slice(0, 40).replace(/\n/g, ' '))
tiny.p.stdin.end()

const pass =
  /full content/.test(first) && /byte-identical|reuse/.test(second) && /unified diff/.test(third) &&
  /symbol v30/.test(sym.t) && /lines 10-12/.test(rng.t) &&
  bin.err && /binary/i.test(bin.t) && badLines.err && noSym.err && missing.err && over.err &&
  /byte-identical|reuse/.test(batch) && /gg = 1/.test(batch) &&
  okVerify.valid === true && tampered.valid === false
console.log('\nSMOKE:', pass ? 'PASS (reads + slices + batch + receipts + all error paths + oversize)' : 'FAIL')
process.exit(pass ? 0 : 1)
