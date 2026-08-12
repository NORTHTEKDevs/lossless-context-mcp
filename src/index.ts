#!/usr/bin/env node
// lossless-context-mcp — the flight recorder for your agent's context.
//
// A persistent, hook-fed ledger of every file version the agent was shown, with three
// views on top: RESTORE (a compaction can no longer destroy the working set — the sweep
// hook archives it, the inject hook brings the manifest back, restore_context re-emits
// it), PACKS (stable hot files rendered once for a fan-out fleet's system prompt so
// siblings hit the prompt cache instead of re-reading), and RECEIPTS (HMAC-signed,
// git-bound attestation of exactly which file versions the model saw, with an explicit
// coverage statement). Reads through the ledger remain provably lossless: the server
// only withholds or diffs content it can PROVE the model still has (context epochs via
// the bundled hooks); otherwise full content.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync, statSync } from 'node:fs'
import { encode } from 'gpt-tokenizer'
import { LosslessEngine, hashContent, normalizeKey, type ReadResult } from './engine.js'
import { getEpoch } from './sentinel.js'
import { outlineOf, renderOutline } from './outline.js'
import { looksBinary, findSymbol, sliceLines } from './slice.js'
import { ContextMeter, repoRootOf, usd } from './meter.js'
import { buildContextReceipt, receiptKey, signReceipt, verifyReceipt, type ContextReceipt } from './receipt.js'
import { SingleSessionGuard } from './session-guard.js'
import { Archive, approxTokens, isExcluded } from './archive.js'
import { gitBlobSha1 } from './gitid.js'
import { loadManifest, renderManifest, MANIFEST_TOP_K } from './restore.js'
import { buildPack, renderPack } from './pack.js'
import { blameContext, renderBlame } from './blame.js'
import { intentFreshMs, loadOthers as loadPresence } from './presence.js'

// ---------------------------------------------------------------------------
// Subcommands (no server startup): `init` wires the hooks, `blame` queries the
// archive from the shell. No args -> stdio MCP server (the normal mode).
const argv = process.argv.slice(2)
if (argv[0] === 'init') {
  const { runInit, renderInitResult } = await import('./init.js')
  try {
    console.log(renderInitResult(runInit({ dryRun: argv.includes('--dry-run') })))
    process.exit(0)
  } catch (e) {
    console.error(`[lossless-context] init failed: ${(e as Error).message}`)
    process.exit(1)
  }
}
if (argv[0] === 'blame') {
  const target = argv[1]
  if (!target || target.startsWith('--')) {
    console.error('usage: lossless-context-mcp blame <path> [--at <ISO timestamp>]')
    process.exit(1)
  }
  const atIdx = argv.indexOf('--at')
  try {
    const a = new Archive()
    console.log(renderBlame(blameContext(a, target, { at: atIdx >= 0 ? argv[atIdx + 1] : undefined })))
    process.exit(0)
  } catch (e) {
    console.error(`[lossless-context] blame failed: ${(e as Error).message}`)
    process.exit(1)
  }
}

const engine = new LosslessEngine()
const meter = new ContextMeter()
// The flight-recorder substrate. Archive failures must never break a read: every archive
// call on the hot path is wrapped, and a broken disk degrades the product to v1.2 behavior.
let archive: Archive | null = null
try {
  archive = new Archive()
  archive.enforceBudget()
} catch (e) {
  process.stderr.write(`[lossless-context] archive disabled: ${(e as Error).message}\n`)
}
// The MCP server cannot learn the harness session id (not exposed to MCP processes);
// this pseudo-id groups this process's events. Hook-side sweeps use the real session id.
const SERVER_SESSION = `mcp-${process.pid}-${Date.now().toString(36)}`
// See session-guard.ts: this process is single-session by construction (stdio transport +
// SDK connect() guard). Claim it explicitly so a violated invariant fails loud, not silent.
const sessionGuard = new SingleSessionGuard()
sessionGuard.claim()
const MAX_BYTES = Number(process.env.LOSSLESS_MAX_BYTES || 2_000_000)

const text = (s: string, isError = false) => ({ content: [{ type: 'text' as const, text: s }], isError })
// Operational logging goes to stderr only (stdout is reserved for JSON-RPC framing).
const logErr = (m: string) => { try { process.stderr.write(`[lossless-context] ${m}\n`) } catch {} }

function render(r: ReadResult, label = ''): string {
  if (r.kind === 'full') return `[lossless-context] ${r.path}${label} — full content (${r.bytes} bytes):\n${r.content}`
  if (r.kind === 'diff')
    return (
      `[lossless-context] ${r.path}${label} changed since your last read this context. ` +
      `Apply this unified diff to the copy you already have. If you no longer have that prior ` +
      `version (e.g. it was compacted away), call read_file again with force_full:true instead of guessing:\n\n${r.patch}`
    )
  return (
    `[lossless-context] ${r.path}${label} is byte-identical to your last read this context (hash ${r.hash.slice(0, 12)}). ` +
    `Reuse the content you already have. If you no longer have it, call read_file with force_full:true.`
  )
}

interface ReadOpts {
  symbol?: string
  lines?: string
  force_full?: boolean
}

/** Shared single-file read path used by read_file and read_files. */
function readOne(path: string, opts: ReadOpts): { text: string; isError: boolean } {
  engine.setEpoch(getEpoch()) // honor any compaction/session reset signalled by the hooks
  let buf: Buffer
  try {
    const st = statSync(path)
    if (st.size > MAX_BYTES)
      return {
        text:
          `[lossless-context] ${path} is ${st.size} bytes (> LOSSLESS_MAX_BYTES=${MAX_BYTES}); ` +
          `read it with the native Read tool using offset/limit.`,
        isError: true,
      }
    buf = readFileSync(path)
  } catch (e) {
    logErr(`read failed for ${path}: ${(e as Error).message}`)
    return { text: `[lossless-context] cannot read ${path}: ${(e as Error).message}`, isError: true }
  }
  if (looksBinary(buf))
    return { text: `[lossless-context] ${path} looks like binary / non-UTF-8 content; use the native Read tool.`, isError: true }
  const fileContent = buf.toString('utf8')

  // Resolve the requested view: a named symbol, an explicit line range, or the whole file.
  let view = 'full'
  let viewContent = fileContent
  let label = ''
  if (typeof opts.symbol === 'string' && opts.symbol.length > 0) {
    const s = findSymbol(fileContent, opts.symbol, path)
    if (!s)
      return {
        text: `[lossless-context] symbol '${opts.symbol}' not found in ${path}. Call outline(${path}) to see what's there, or read without 'symbol'.`,
        isError: true,
      }
    view = `sym:${opts.symbol}`
    viewContent = s.text
    label = ` (symbol ${opts.symbol}, lines ${s.start}-${s.end})`
  } else if (typeof opts.lines === 'string' && opts.lines.length > 0) {
    const m = opts.lines.match(/^(\d+)\s*-\s*(\d+)$/)
    if (!m) return { text: `[lossless-context] 'lines' must be "start-end" (e.g. "40-90").`, isError: true }
    const sl = sliceLines(fileContent, Number(m[1]), Number(m[2]))
    view = `lines:${sl.start}-${sl.end}`
    viewContent = sl.text
    label = ` (lines ${sl.start}-${sl.end})`
  }

  const r = engine.read(path, viewContent, { forceFull: opts.force_full === true, view })
  // Honest accounting: baseline = the resolved view's content (what we'd send without
  // dedup); sent = what we actually sent. This measures ONLY the lossless dedup/diff win.
  const body = r.kind === 'full' ? r.content! : r.kind === 'diff' ? r.patch! : (r.note ?? '')
  const excluded = isExcluded(path)
  const blobSha1 = view === 'full' && !excluded ? gitBlobSha1(viewContent) : undefined
  // Excluded (secret-pattern) paths: no content-derived metadata in the meter either —
  // meter events feed SIGNED receipts, and a hash of a low-entropy secret in an
  // exportable artifact invites offline confirmation attacks.
  meter.record({
    path: r.path,
    view: r.view,
    kind: r.kind,
    epoch: r.epoch,
    hash: excluded ? '' : r.hash,
    baseHash: excluded ? undefined : r.baseHash,
    gitBlobSha1: blobSha1,
    excluded: excluded || undefined,
    bytes: r.bytes,
    baselineTokens: encode(viewContent).length,
    sentTokens: encode(body).length,
  })
  // Flight recorder: archive the exact version shown (full views only; slices are views
  // over the same bytes). Never let archive trouble break the read itself. Excluded
  // (secret-pattern) paths leave only path + counts on disk — no content-derived metadata.
  if (archive && view === 'full') {
    try {
      if (!excluded) archive.putBlob(viewContent, r.hash)
      archive.record({
        session: SERVER_SESSION,
        path: r.path,
        repo: repoRootOf(r.path),
        hash: excluded ? '' : r.hash,
        gitBlobSha1: blobSha1,
        bytes: excluded ? 0 : r.bytes,
        approxTokens: excluded ? 0 : approxTokens(viewContent),
        source: 'mcp',
        op: 'read',
        view: r.view,
        excluded: excluded || undefined,
      })
    } catch (e) {
      logErr(`archive write failed for ${path}: ${(e as Error).message}`)
    }
  }
  return { text: render(r, label), isError: false }
}

const server = new McpServer({ name: 'lossless-context', version: '2.0.0' })

server.tool(
  'read_file',
  'Read a text file through the context ledger. The FIRST read of a file/view (or the ' +
    'first after a context compaction) returns full content. A later read of an UNCHANGED ' +
    'view returns a short "reuse what you have" marker. A later read of a CHANGED view ' +
    'returns a unified DIFF to apply to the copy you already have. Optionally read just one ' +
    'symbol (function/class by name) or a line range instead of the whole file. All dedup is ' +
    'lossless: it only diffs/withholds content it can prove you still have. Every read is ' +
    'metered (see context_stats) and attested in the signed context receipt. Pass ' +
    'force_full:true for the whole content regardless.',
  {
    path: z.string().describe('Path to the file to read (absolute, or relative to the server cwd).'),
    symbol: z
      .string()
      .optional()
      .describe('Return only this function/class/type by name (heuristic brace/indent extraction).'),
    lines: z.string().optional().describe('Return only this 1-based inclusive line range, e.g. "40-90".'),
    force_full: z
      .boolean()
      .optional()
      .describe('Return full content even when a diff or unchanged-marker would suffice.'),
  },
  async ({ path, symbol, lines, force_full }) => {
    const r = readOne(path, { symbol, lines, force_full })
    return text(r.text, r.isError)
  },
)

server.tool(
  'read_files',
  'Read a working set of text files in one call, each through the same lossless ledger as ' +
    'read_file (full on first contact, unchanged-marker or diff on re-reads). One call for N ' +
    'files instead of N calls. Per-file errors are reported inline without failing the batch.',
  {
    paths: z.array(z.string()).min(1).max(50).describe('Files to read, in order.'),
    force_full: z.boolean().optional().describe('Return full content for every file regardless of ledger state.'),
  },
  async ({ paths, force_full }) => {
    const parts: string[] = []
    let errors = 0
    for (const p of paths) {
      const r = readOne(p, { force_full })
      if (r.isError) errors++
      parts.push(r.text)
    }
    // Header line then the first render on the NEXT line (no blank between): the guard's
    // tool_result parser reads the first lines of each '---'-separated part, and the
    // restored/batched files must land inside its window to be marked as seen.
    const head = `[lossless-context] working set: ${paths.length} file(s), ${errors} error(s)\n`
    return text(head + parts.join('\n\n---\n\n'), errors === paths.length)
  },
)

server.tool(
  'outline',
  'Return a cheap structural outline of a file: declaration lines (functions, classes, ' +
    'types, methods) with line numbers, bodies elided. Use this to navigate a large/unknown ' +
    'file before reading specific parts with read_file.',
  { path: z.string().describe('Path to the file to outline.') },
  async ({ path }) => {
    try {
      const st = statSync(path)
      if (st.size > MAX_BYTES) return text(`[lossless-context] ${path} too large to outline; use native Read.`, true)
      const content = readFileSync(path, 'utf8')
      return text(renderOutline(path, outlineOf(content)))
    } catch (e) {
      return text(`[lossless-context] cannot outline ${path}: ${(e as Error).message}`, true)
    }
  },
)

server.tool(
  'context_stats',
  'Where did this session’s file-read tokens go? Totals, per-repo breakdown, heaviest ' +
    'files, dedup savings, and a USD estimate (LOSSLESS_PRICE_PER_MTOK, default $3/MTok ' +
    'input). Counted with a real tokenizer on exactly what this server sent.',
  {},
  async () => {
    const t = meter.totals()
    const pct = t.baselineTokens ? ((t.savedTokens / t.baselineTokens) * 100).toFixed(1) : '0.0'
    const repos = meter
      .byRepo()
      .map((r) => `  ${r.repo}  reads=${r.reads} files=${r.files} sent=${r.sentTokens} saved=${r.savedTokens} (${usd(r.sentTokens)})`)
      .join('\n')
    const files = meter
      .topFiles(8)
      .map((f) => `  ${f.path}  reads=${f.reads} sent=${f.sentTokens}`)
      .join('\n')
    return text(
      `[lossless-context] session context stats\n` +
        `reads: ${t.reads} (${t.kinds.full} full, ${t.kinds.diff} diff, ${t.kinds.unchanged} unchanged)\n` +
        `baseline tokens (full every read): ${t.baselineTokens} (${usd(t.baselineTokens)})\n` +
        `sent tokens (this server):         ${t.sentTokens} (${usd(t.sentTokens)})\n` +
        `dedup saved: ${t.savedTokens} tokens (${pct}%)\n` +
        (repos ? `\nby repo:\n${repos}\n` : '') +
        (files ? `\nheaviest files:\n${files}` : ''),
    )
  },
)

server.tool(
  'working_set',
  'What has this session been working on? A heat-ranked table of the files the flight ' +
    'recorder knows about — from this server\'s own reads plus any transcript sweeps the ' +
    'hooks performed (last 24h) — with sizes, touch counts, and staleness vs current disk ' +
    'state. Use after a compaction to see what is recoverable, or anytime for orientation.',
  {
    limit: z.number().int().min(1).max(50).optional().describe('Max files to list (default 15).'),
  },
  async ({ limit }) => {
    const n = limit ?? 15
    // Keyed by normalizeKey like every other path-keyed structure — the same file seen
    // via backslash and forward-slash spellings must not split into two rows.
    const rows = new Map<string, { path: string; touches: number; approxTokens: number; hash: string; sources: Set<string>; lastTs: string }>()
    const manifest = loadManifest()
    if (manifest) {
      for (const e of manifest.entries) {
        rows.set(normalizeKey(e.path), { path: e.path, touches: e.reads + e.edits, approxTokens: e.approxTokens, hash: e.hash, sources: new Set(['sweep']), lastTs: manifest.ts })
      }
    }
    if (archive) {
      try {
        for (const e of archive.readEvents({ sinceMs: Date.now() - 24 * 3600_000 })) {
          let r = rows.get(normalizeKey(e.path))
          if (!r) {
            r = { path: e.path, touches: 0, approxTokens: e.approxTokens, hash: e.hash, sources: new Set(), lastTs: e.ts }
            rows.set(normalizeKey(e.path), r)
          }
          r.touches++
          r.sources.add(e.source)
          if (e.ts > r.lastTs) {
            r.lastTs = e.ts
            r.hash = e.hash
            r.approxTokens = e.approxTokens
          }
        }
      } catch (e) {
        logErr(`working_set: archive read failed: ${(e as Error).message}`)
      }
    }
    if (rows.size === 0)
      return text(
        '[lossless-context] the flight recorder has no session history yet. Reads through ' +
          'read_file/read_files are recorded automatically; native-tool activity is captured ' +
          'when the sweep hooks are installed (see README).',
      )
    const ranked = [...rows.values()].sort((a, b) => b.touches - a.touches || (a.lastTs < b.lastTs ? 1 : -1)).slice(0, n)
    const lines = ranked.map((r) => {
      let stale = 'missing on disk'
      if (!r.hash) {
        stale = 'not archived (secret-pattern)'
      } else {
        try {
          const cur = hashContent(readFileSync(r.path, 'utf8'))
          stale = cur === r.hash ? 'current' : 'CHANGED on disk since last seen'
        } catch {}
      }
      return `  ${r.path}  ~${r.approxTokens} tok, ${r.touches} touch(es), [${[...r.sources].join('+')}], ${stale}`
    })
    return text(`[lossless-context] working set (${ranked.length} of ${rows.size} known files):\n` + lines.join('\n'))
  },
)

server.tool(
  'restore_context',
  'Re-emit the working set after a compaction (or /clear) destroyed it. Serves CURRENT ' +
    'disk content of the requested files — by default the top of the pre-compaction ' +
    'manifest the sweep hook wrote — through the lossless ledger, annotating any file that ' +
    'changed since the model last saw it. Budget-capped so a restore cannot blow the fresh ' +
    'context; files over budget are listed, not silently dropped.',
  {
    files: z.array(z.string()).min(1).max(50).optional().describe('Specific files to restore (default: the manifest working set).'),
    budget_tokens: z.number().int().min(500).optional().describe('Approx token budget for restored content (default 25000).'),
  },
  async ({ files, budget_tokens }) => {
    const budget = budget_tokens ?? 25_000
    let targets: { path: string; lastHash?: string }[]
    if (files && files.length > 0) {
      targets = files.map((p) => ({ path: p }))
    } else {
      const manifest = loadManifest()
      if (!manifest || manifest.entries.length === 0)
        return text(
          '[lossless-context] nothing to restore: no working-set manifest found (the sweep ' +
            'hook writes one at PreCompact/SessionEnd — see README for hook setup). Pass ' +
            '`files` explicitly to restore specific paths.',
          true,
        )
      targets = manifest.entries.slice(0, MANIFEST_TOP_K).map((e) => ({ path: e.path, lastHash: e.hash }))
    }
    const parts: string[] = []
    const overBudget: string[] = []
    let spent = 0
    let errors = 0
    for (const t of targets) {
      let content: string
      try {
        const st = statSync(t.path)
        if (st.size > MAX_BYTES) {
          parts.push(`[lossless-context] ${t.path}: too large to restore here; use native Read with offset/limit.`)
          errors++
          continue
        }
        const buf = readFileSync(t.path)
        if (looksBinary(buf)) {
          parts.push(`[lossless-context] ${t.path}: binary content; use native Read.`)
          errors++
          continue
        }
        content = buf.toString('utf8')
      } catch (e) {
        parts.push(`[lossless-context] ${t.path}: cannot restore — ${(e as Error).message}`)
        errors++
        continue
      }
      const tok = approxTokens(content)
      if (spent + tok > budget) {
        overBudget.push(`${t.path} (~${tok} tok)`)
        continue
      }
      spent += tok
      const changed = t.lastHash && hashContent(content) !== t.lastHash ? ' [NOTE: changed on disk since you last saw it]' : ''
      const r = readOne(t.path, { force_full: false })
      parts.push(changed && !r.isError ? r.text.replace('\n', changed + '\n') : r.text)
      if (r.isError) errors++
    }
    // Single newline after the header — the first restored file's render must land inside
    // the guard's per-part parse window or the guard would deny editing the very file
    // this tool just restored (the exact recovery flow it exists to protect).
    const head =
      `[lossless-context] restore: ${parts.length} file(s), ~${spent} tokens` +
      (overBudget.length ? `; NOT restored (over ~${budget} token budget): ${overBudget.join(', ')} — call again with just those files or a higher budget_tokens` : '') +
      '\n'
    return text(head + parts.join('\n\n---\n\n'), errors > 0 && parts.length === errors)
  },
)

server.tool(
  'export_pack',
  'Build a fan-out context pack: the stable, hot files (ranked across sessions from the ' +
    'flight-recorder history) rendered as one deterministic block to embed VERBATIM in a ' +
    'custom agent-type\'s SYSTEM PROMPT. Siblings in a fan-out then hit the prompt cache on ' +
    'that shared prefix instead of each re-reading the same files (measured on a real ' +
    'review fan-out: 46.55% cheaper; per-task injection measured WORSE — see README). ' +
    'Files matching secret patterns are never packed.',
  {
    repo: z.string().optional().describe('Only pack files from this repo root.'),
    top: z.number().int().min(1).max(30).optional().describe('Max files in the pack (default 8).'),
    budget_tokens: z.number().int().min(1000).optional().describe('Approx token ceiling for the pack (default 30000).'),
    days: z.number().int().min(1).max(90).optional().describe('History window for ranking (default 14).'),
  },
  async ({ repo, top, budget_tokens, days }) => {
    if (!archive) return text('[lossless-context] archive unavailable; cannot build a pack.', true)
    try {
      const pack = buildPack(archive, { repo, top, budgetTokens: budget_tokens, days })
      if (pack.files.length === 0)
        return text(
          '[lossless-context] no pack candidates: the archive has no (non-excluded) read ' +
            'history in the window. Read files through this server or install the sweep hooks, ' +
            'then try again.',
          true,
        )
      return text(renderPack(pack))
    } catch (e) {
      return text(`[lossless-context] pack build failed: ${(e as Error).message}`, true)
    }
  },
)

server.tool(
  'coordination_status',
  'The air-traffic radar for concurrent agents on this machine: which agent processes ' +
    'are active (from the coordination plane the guard hooks maintain), what they have ' +
    'been editing, which files have cross-session activity, and where edit conflicts are ' +
    'brewing. Advisory visibility only — sessions without the hooks installed are invisible.',
  {},
  async () => {
    try {
      const now = Date.now()
      const all = loadPresence('', now) // every live logical agent, none excluded
      if (all.length === 0)
        return text(
          '[lossless-context] coordination plane: no active agent processes visible. ' +
            'Presence appears once the guard hook (lossless-context-mcp init) runs in a session.',
        )
      const bySid = new Map<string, { agents: Set<string>; lastMs: number; edits: number; intents: number }>()
      const byFile = new Map<string, { sids: Set<string>; lastMs: number; inFlight: boolean }>()
      for (const r of all) {
        let s = bySid.get(r.sid)
        if (!s) {
          s = { agents: new Set(), lastMs: 0, edits: 0, intents: 0 }
          bySid.set(r.sid, s)
        }
        s.agents.add(r.agent)
        s.lastMs = Math.max(s.lastMs, r.updatedAt)
        s.edits += r.edits.length
        s.intents += r.intents.length
        for (const e of [...r.edits, ...r.intents]) {
          let f = byFile.get(e.path)
          if (!f) {
            f = { sids: new Set(), lastMs: 0, inFlight: false }
            byFile.set(e.path, f)
          }
          f.sids.add(r.sid)
          f.lastMs = Math.max(f.lastMs, e.ts)
        }
        // Same threshold the guard enforces (LOSSLESS_COORD_INTENT_SECS) — never a literal.
        for (const i of r.intents) if (now - i.ts < intentFreshMs()) byFile.get(i.path)!.inFlight = true
      }
      const sessions = [...bySid.entries()]
        .sort((a, b) => b[1].lastMs - a[1].lastMs)
        .map(
          ([sid, s]) =>
            `  ${sid.slice(0, 8)}  ${s.agents.size} agent(s), ${s.edits} landed edit(s), ${s.intents} intent(s), active ${Math.round((now - s.lastMs) / 60000)}min ago`,
        )
      const hot = [...byFile.entries()]
        .filter(([, f]) => f.sids.size >= 2 || f.inFlight)
        .sort((a, b) => b[1].lastMs - a[1].lastMs)
        .slice(0, 12)
        .map(([p, f]) => `  ${p}  [${f.sids.size} session(s)${f.inFlight ? ', EDIT IN FLIGHT' : ''}]`)
      return text(
        `[lossless-context] coordination radar — ${bySid.size} agent session(s) visible\n` +
          sessions.join('\n') +
          (hot.length ? `\n\ncross-session / in-flight files:\n${hot.join('\n')}` : '\n\nno cross-session file activity in the window.'),
      )
    } catch (e) {
      return text(`[lossless-context] coordination status failed: ${(e as Error).message}`, true)
    }
  },
)

server.tool(
  'context_blame',
  'Forensics: what did the agent see of this file, and when? Every content version the ' +
    'flight recorder observed (SHA-256 + git blob SHA-1, first/last seen, capture source, ' +
    'sessions), plus what else was in context around a focus moment. The evidence-backed ' +
    'answer to "why did the agent do that?" — query history instead of trusting self-report.',
  {
    path: z.string().describe('The file to blame.'),
    at: z.string().optional().describe('Focus moment (ISO timestamp). Default: last time the file was seen.'),
    window_minutes: z.number().int().min(1).max(720).optional().describe('Co-context window around the focus (default 30).'),
  },
  async ({ path, at, window_minutes }) => {
    if (!archive) return text('[lossless-context] archive unavailable; no history to blame.', true)
    try {
      return text(renderBlame(blameContext(archive, path, { at, windowMinutes: window_minutes })))
    } catch (e) {
      return text(`[lossless-context] blame failed: ${(e as Error).message}`, true)
    }
  },
)

server.tool(
  'context_receipt',
  'Issue an HMAC-SHA256-signed context receipt: every file/view the model was shown via ' +
    'this ledger, the SHA-256 of each content version, git binding (blob SHA-1 per version, ' +
    'repo HEAD at issue time), delivery kinds, token totals, and an explicit coverage ' +
    'statement. With include_sweep, also attests native-tool reads captured by the ' +
    'transcript-sweep hooks. The auditable answer to "what did the AI see when it did ' +
    'this?". Signs with LOSSLESS_RECEIPT_KEY or the shared trust key file, so it verifies ' +
    'with the same key as trust-mcp receipts. Verify later with verify_context_receipt.',
  {
    artifact: z.string().describe('What this context evidence is for (repo, ticket, deploy, session id).'),
    include_sweep: z
      .boolean()
      .optional()
      .describe('Also attest files captured by transcript sweeps in the last 24h (source: sweep).'),
  },
  async ({ artifact, include_sweep }) => {
    let sweepEvents
    if (include_sweep && archive) {
      try {
        sweepEvents = archive.readEvents({ sinceMs: Date.now() - 24 * 3600_000 }).filter((e) => e.source === 'sweep')
      } catch (e) {
        logErr(`context_receipt: sweep events unavailable: ${(e as Error).message}`)
      }
    }
    const receipt = buildContextReceipt(meter.events, artifact, new Date(), { sweepEvents })
    const { key, source } = receiptKey()
    return text(JSON.stringify({ receipt, signature: signReceipt(receipt, key), algorithm: 'HMAC-SHA256', key_source: source }, null, 2))
  },
)

server.tool(
  'verify_context_receipt',
  'Verify a context receipt + signature pair against the local receipt key (timing-safe, ' +
    'canonicalized so JSON field order does not matter).',
  {
    receipt: z.record(z.unknown()).describe('The receipt object exactly as returned by context_receipt.'),
    signature: z.string(),
  },
  async ({ receipt, signature }) => {
    const { key, source } = receiptKey()
    const valid = verifyReceipt(receipt as unknown as ContextReceipt, signature, key)
    return text(JSON.stringify({ valid, key_source: source }))
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
