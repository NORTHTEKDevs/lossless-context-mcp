// Demo generator: drives the REAL server + REAL hooks through two scripted scenarios,
// captures their genuine outputs, and renders terminal-recording GIFs via asciinema's
// `agg`. Nothing shown in the GIFs is mocked — every deny reason, manifest, and radar
// line is produced by the shipped code at render time. Re-run anytime:
//
//   npm run build && node docs/demo/make-demo.mjs [path-to-agg]
//
// Outputs: docs/demo/restore.gif, docs/demo/coordination.gif (+ .cast sources).
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const agg = process.argv[2] || join(homedir(), 'tools', 'agg.exe')

const tmp = mkdtempSync(join(tmpdir(), 'lcm-demo-'))
const ctxDir = join(tmp, 'ctx').replace(/\\/g, '/')
const work = join(tmp, 'project').replace(/\\/g, '/')
mkdirSync(work, { recursive: true })

// A small, realistic working set.
const files = {
  'src/auth.ts': `export async function login(user: string, pass: string) {\n  const session = await createSession(user)\n  return session.token\n}\n`,
  'src/api.ts': `export function handler(req: Request) {\n  return route(req.url, req.method)\n}\n`,
  'src/db.ts': `export const pool = createPool(process.env.DATABASE_URL)\n`,
  'README.md': `# checkout-service\nThe payments checkout service.\n`,
}
for (const [rel, content] of Object.entries(files)) {
  mkdirSync(join(work, dirname(rel)), { recursive: true })
  writeFileSync(join(work, rel), content)
}
const P = (rel) => `${work}/${rel}`
const pretty = (s) => s.replaceAll(work, '~/checkout-service').replaceAll(ctxDir, '~/.lossless-context')

// --- real-component drivers (same wire mechanics as bench/smoke.mjs) -------------------
function runHook(script, payload) {
  return new Promise((resolve) => {
    const p = spawn('node', [join(repo, 'hooks', script)], { env: { ...process.env, LOSSLESS_CONTEXT_DIR: ctxDir }, cwd: repo })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', () => resolve({ out, err }))
    p.stdin.write(JSON.stringify(payload))
    p.stdin.end()
  })
}
function connect() {
  const p = spawn('node', [join(repo, 'dist', 'index.js')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, LOSSLESS_CONTEXT_DIR: ctxDir }, cwd: repo })
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
const ts = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()
const readLine = (path, content, offsetMs) =>
  JSON.stringify({ timestamp: ts(offsetMs), toolUseResult: { type: 'text', file: { filePath: path, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } } })
const editLine = (path, offsetMs) =>
  JSON.stringify({ timestamp: ts(offsetMs), message: { content: [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }] } })

// --- scenario A: compaction -> inject -> blind edit denied -> restore -> allowed --------
const A = []
{
  const transcript = join(tmp, 'session-a.jsonl').replace(/\\/g, '/')
  writeFileSync(
    transcript,
    Object.entries(files).map(([rel, content], i) => readLine(P(rel), content, -300_000 + i * 1000)).join('\n') +
      '\n' + editLine(P('src/auth.ts'), -240_000) + '\n',
  )
  const sid = 'demo-session'
  const sweep = await runHook('sweep-transcript.mjs', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: sid, transcript_path: transcript })
  A.push({ cmd: '# context hits the limit — Claude Code compacts. File contents are GONE from context.', out: '' })
  A.push({ cmd: '# but the PreCompact hook swept the transcript first:', out: pretty(sweep.err.trim()) })
  const inject = await runHook('inject-manifest.mjs', { hook_event_name: 'SessionStart', source: 'compact', session_id: sid })
  const injected = JSON.parse(inject.out).hookSpecificOutput.additionalContext
  A.push({ cmd: '# after compaction, the manifest is injected into the fresh context:', out: pretty(injected) })
  const deny = await runHook('guard-edit.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: P('src/auth.ts') }, session_id: sid, transcript_path: transcript })
  A.push({ cmd: '# the model tries to edit src/auth.ts from its MEMORY of the summary…', out: pretty(JSON.parse(deny.out).hookSpecificOutput.permissionDecisionReason) })
  const server = connect()
  await server.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '0' } })
  server.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const restored = (await server.rpc('tools/call', { name: 'restore_context', arguments: {} })).result.content[0].text
  const shown = restored.split('\n').slice(0, 9).join('\n') + '\n  … (full working set re-emitted, budget-capped)'
  A.push({ cmd: '> restore_context', out: pretty(shown) })
  server.p.stdin.end()
  appendFileSync(transcript, JSON.stringify({ timestamp: ts(0), message: { content: [{ type: 'tool_result', tool_use_id: 'r', content: [{ type: 'text', text: restored }] }] } }) + '\n')
  const allow = await runHook('guard-edit.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: P('src/auth.ts') }, session_id: sid, transcript_path: transcript })
  A.push({ cmd: '# retry the edit:', out: allow.out === '' ? '✓ allowed — the model is editing what it can actually see again.' : 'DENIED (unexpected)' })
}

// --- scenario B: two concurrent agents, in-flight conflict + radar ----------------------
const B = []
{
  const tA = join(tmp, 'agent-a.jsonl').replace(/\\/g, '/')
  const tB = join(tmp, 'agent-b.jsonl').replace(/\\/g, '/')
  writeFileSync(tA, readLine(P('src/api.ts'), files['src/api.ts'], -60_000) + '\n')
  writeFileSync(tB, readLine(P('src/api.ts'), files['src/api.ts'], -90_000) + '\n')
  const allowA = await runHook('guard-edit.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: P('src/api.ts') }, session_id: 'agent-session-a', transcript_path: tA })
  B.push({ cmd: 'A> Edit src/api.ts', out: allowA.out === '' ? '✓ allowed — intent published to the coordination plane' : 'denied?' })
  const denyB = await runHook('guard-edit.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: P('src/api.ts') }, session_id: 'agent-session-b', transcript_path: tB })
  B.push({ cmd: 'B> Edit src/api.ts   (seconds later, different session)', out: pretty(JSON.parse(denyB.out).hookSpecificOutput.permissionDecisionReason) })
  const server = connect()
  await server.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '0' } })
  server.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const radar = (await server.rpc('tools/call', { name: 'coordination_status', arguments: {} })).result.content[0].text
  B.push({ cmd: '> coordination_status', out: pretty(radar) })
  server.p.stdin.end()
}

// --- cast composer: deterministic typing + line-by-line reveal --------------------------
function buildCast(title, steps, cols = 100, rows = 30) {
  const ev = []
  let t = 0.6
  const emit = (delay, text) => { t += delay; ev.push([Number(t.toFixed(3)), 'o', text]) }
  emit(0, `[1;34m${title}[0m\r\n[90m(real output from lossless-context-mcp — rendered, not mocked)[0m\r\n\r\n`)
  for (const s of steps) {
    const promptColor = s.cmd.startsWith('#') ? '[90m' : s.cmd.startsWith('A>') ? '[1;32m' : s.cmd.startsWith('B>') ? '[1;35m' : '[1;36m'
    emit(0.7, promptColor)
    for (const ch of s.cmd) emit(ch === ' ' ? 0.012 : 0.024, ch)
    emit(0.15, '[0m\r\n')
    if (s.out) {
      for (const line of s.out.split('\n')) emit(0.05, line + '\r\n')
    }
    emit(0.4, '\r\n')
  }
  emit(1.6, '[90m— lossless-context-mcp · npm i -g lossless-context-mcp && lossless-context-mcp init —[0m\r\n')
  emit(2.2, '')
  return JSON.stringify({ version: 2, width: cols, height: rows, title }) + '\n' + ev.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

mkdirSync(here, { recursive: true })
const scenarios = [
  ['restore', 'Compaction destroys your agent’s working set. Not anymore.', A, 100, 32],
  ['coordination', 'Two agents. One file. Air traffic control.', B, 100, 28],
]
for (const [name, title, steps, cols, rows] of scenarios) {
  const cast = join(here, `${name}.cast`)
  writeFileSync(cast, buildCast(title, steps, cols, rows))
  execFileSync(agg, [cast, join(here, `${name}.gif`), '--cols', String(cols), '--rows', String(rows), '--font-size', '15', '--theme', '0d1117,c9d1d9,21262d,ff7b72,3fb950,d29922,58a6ff,bc8cff,39c5cf,b1bac4,30363d,ffa198,56d364,e3b341,79c0ff,d2a8ff,56d4dd,f0f6fc', '--speed', '1'], { stdio: 'inherit' })
  console.log(`rendered docs/demo/${name}.gif`)
}
rmSync(tmp, { recursive: true, force: true })
console.log('done.')
