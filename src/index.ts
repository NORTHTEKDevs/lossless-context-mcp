#!/usr/bin/env node
// lossless-context-mcp — a context ledger for agent file reads.
//
// Reads are provably lossless: the server only withholds or diffs content it can PROVE
// the model still has (bounded by context epochs via the bundled SessionStart/PreCompact
// hooks); otherwise it returns full content. On top of that ledger it meters where
// file-read tokens go (per repo, per file, in dollars) and issues HMAC-signed context
// receipts — an auditable record of exactly which file versions the model was shown.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync, statSync } from 'node:fs'
import { encode } from 'gpt-tokenizer'
import { LosslessEngine, type ReadResult } from './engine.js'
import { getEpoch } from './sentinel.js'
import { outlineOf, renderOutline } from './outline.js'
import { looksBinary, findSymbol, sliceLines } from './slice.js'
import { ContextMeter, usd } from './meter.js'
import { buildContextReceipt, receiptKey, signReceipt, verifyReceipt, type ContextReceipt } from './receipt.js'

const engine = new LosslessEngine()
const meter = new ContextMeter()
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
  meter.record({
    path: r.path,
    view: r.view,
    kind: r.kind,
    epoch: r.epoch,
    hash: r.hash,
    baseHash: r.baseHash,
    bytes: r.bytes,
    baselineTokens: encode(viewContent).length,
    sentTokens: encode(body).length,
  })
  return { text: render(r, label), isError: false }
}

const server = new McpServer({ name: 'lossless-context', version: '1.1.0' })

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
    const head = `[lossless-context] working set: ${paths.length} file(s), ${errors} error(s)\n`
    return text(head + '\n' + parts.join('\n\n---\n\n'), errors === paths.length)
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
  'context_receipt',
  'Issue an HMAC-SHA256-signed context receipt for this session: every file/view the model ' +
    'was shown, the SHA-256 of each content version, how it was delivered (full/diff/' +
    'unchanged), and token totals. The auditable answer to "what did the AI see when it did ' +
    'this?". Signs with LOSSLESS_RECEIPT_KEY or the shared trust key file, so it verifies ' +
    'with the same key as trust-mcp receipts. Verify later with verify_context_receipt.',
  {
    artifact: z.string().describe('What this context evidence is for (repo, ticket, deploy, session id).'),
  },
  async ({ artifact }) => {
    const receipt = buildContextReceipt(meter.events, artifact)
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
