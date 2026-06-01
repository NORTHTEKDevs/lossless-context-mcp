#!/usr/bin/env node
// lossless-context-mcp — an MCP server that cuts file-read tokens in agent sessions
// without sacrificing quality. It only ever withholds or diffs content it can PROVE the
// model still has (bounded by context epochs via the bundled SessionStart/PreCompact
// hooks); otherwise it returns full content.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync, statSync } from 'node:fs'
import { encode } from 'gpt-tokenizer'
import { LosslessEngine, type ReadResult } from './engine.js'
import { getEpoch } from './sentinel.js'
import { outlineOf, renderOutline } from './outline.js'
import { looksBinary, findSymbol, sliceLines } from './slice.js'

const engine = new LosslessEngine()
const MAX_BYTES = Number(process.env.LOSSLESS_MAX_BYTES || 2_000_000)

// cumulative session accounting (real tokens)
const stats = { full: 0, diff: 0, unchanged: 0, baselineTokens: 0, sentTokens: 0 }

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

const server = new McpServer({ name: 'lossless-context', version: '1.0.1' })

server.tool(
  'read_file',
  'Read a text file with lossless token savings. The FIRST read of a file/view (or the ' +
    'first after a context compaction) returns full content. A later read of an UNCHANGED ' +
    'view returns a short "reuse what you have" marker. A later read of a CHANGED view ' +
    'returns a unified DIFF to apply to the copy you already have — never the whole thing ' +
    'again. Optionally read just one symbol (function/class by name) or a line range instead ' +
    'of the whole file. All savings are lossless: it only diffs/withholds content it can ' +
    'prove you still have. When you get a diff, apply it to your prior copy; when unchanged, ' +
    'reuse your copy. Pass force_full:true for the whole content regardless.',
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
    engine.setEpoch(getEpoch()) // honor any compaction/session reset signalled by the hooks
    let buf: Buffer
    try {
      const st = statSync(path)
      if (st.size > MAX_BYTES)
        return text(
          `[lossless-context] ${path} is ${st.size} bytes (> LOSSLESS_MAX_BYTES=${MAX_BYTES}); ` +
            `read it with the native Read tool using offset/limit.`,
          true,
        )
      buf = readFileSync(path)
    } catch (e) {
      logErr(`read_file failed for ${path}: ${(e as Error).message}`)
      return text(`[lossless-context] cannot read ${path}: ${(e as Error).message}`, true)
    }
    if (looksBinary(buf))
      return text(`[lossless-context] ${path} looks like binary / non-UTF-8 content; use the native Read tool.`, true)
    const fileContent = buf.toString('utf8')

    // Resolve the requested view: a named symbol, an explicit line range, or the whole file.
    let view = 'full'
    let viewContent = fileContent
    let label = ''
    if (typeof symbol === 'string' && symbol.length > 0) {
      const s = findSymbol(fileContent, symbol, path)
      if (!s)
        return text(
          `[lossless-context] symbol '${symbol}' not found in ${path}. Call outline(${path}) to see what's there, or read without 'symbol'.`,
          true,
        )
      view = `sym:${symbol}`
      viewContent = s.text
      label = ` (symbol ${symbol}, lines ${s.start}-${s.end})`
    } else if (typeof lines === 'string' && lines.length > 0) {
      const m = lines.match(/^(\d+)\s*-\s*(\d+)$/)
      if (!m) return text(`[lossless-context] 'lines' must be "start-end" (e.g. "40-90").`, true)
      const sl = sliceLines(fileContent, Number(m[1]), Number(m[2]))
      view = `lines:${sl.start}-${sl.end}`
      viewContent = sl.text
      label = ` (lines ${sl.start}-${sl.end})`
    }

    const r = engine.read(path, viewContent, { forceFull: force_full === true, view })
    // Honest accounting: baseline = the resolved view's content (what we'd send without
    // dedup); sent = what we actually sent. This measures ONLY the lossless dedup/diff win.
    const body = r.kind === 'full' ? r.content! : r.kind === 'diff' ? r.patch! : (r.note ?? '')
    stats.baselineTokens += encode(viewContent).length
    stats.sentTokens += encode(body).length
    stats[r.kind]++
    return text(render(r, label))
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
  'lossless_stats',
  'Report this session’s real token savings: reads by kind, baseline vs sent tokens, and ' +
    'percent saved. Numbers are computed with a real tokenizer (gpt-tokenizer / o200k).',
  {},
  async () => {
    const saved = stats.baselineTokens - stats.sentTokens
    const pct = stats.baselineTokens ? ((saved / stats.baselineTokens) * 100).toFixed(1) : '0.0'
    return text(
      `[lossless-context] session stats\n` +
        `reads: ${stats.full + stats.diff + stats.unchanged} (${stats.full} full, ${stats.diff} diff, ${stats.unchanged} unchanged)\n` +
        `baseline tokens (full every read): ${stats.baselineTokens}\n` +
        `sent tokens (this server):         ${stats.sentTokens}\n` +
        `saved: ${saved} (${pct}%)`,
    )
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
