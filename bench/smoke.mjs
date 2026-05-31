// Drives the compiled MCP server over stdio like a real client: initialize, tools/list,
// then read the same file (full -> unchanged), edit it, read again (diff), and stats.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'lc-smoke-'))
const f = join(tmp, 'demo.ts').replace(/\\/g, '/')
writeFileSync(f, Array.from({ length: 120 }, (_, i) => `const v${i} = compute(${i}) // line ${i}`).join('\n'))

const p = spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] })
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
const rpc = (obj) => new Promise((r) => { waiters.push(r); p.stdin.write(JSON.stringify(obj) + '\n') })
const notify = (obj) => p.stdin.write(JSON.stringify(obj) + '\n')
const callText = (res) => res.result.content[0].text

await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })
notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
console.log('tools:', tools.result.tools.map((t) => t.name).join(', '))

const read = async (id) => callText(await rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read_file', arguments: { path: f } } }))
const first = await read(3)
console.log('1. first read   ->', first.slice(0, 48).replace(/\n/g, ' '))
const second = await read(4)
console.log('2. reread       ->', second.slice(0, 70).replace(/\n/g, ' '))
// edit the file
writeFileSync(f, Array.from({ length: 120 }, (_, i) => (i === 60 ? 'const v60 = PATCHED(60)' : `const v${i} = compute(${i}) // line ${i}`)).join('\n'))
const third = await read(5)
console.log('3. after edit   ->', third.slice(0, 70).replace(/\n/g, ' '))
const stats = callText(await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'lossless_stats', arguments: {} } }))
console.log('4. stats        ->', stats.split('\n').slice(-1)[0])

const pass =
  /full content/.test(first) &&
  /byte-identical|reuse/.test(second) &&
  /unified diff/.test(third)
console.log('\nSMOKE:', pass ? 'PASS (full -> unchanged -> diff over the wire)' : 'FAIL')
p.stdin.end(); process.exit(pass ? 0 : 1)
