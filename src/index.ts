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

const engine = new LosslessEngine()
const MAX_BYTES = Number(process.env.LOSSLESS_MAX_BYTES || 2_000_000)

// cumulative session accounting (real tokens)
const stats = { full: 0, diff: 0, unchanged: 0, baselineTokens: 0, sentTokens: 0 }

const text = (s: string, isError = false) => ({ content: [{ type: 'text' as const, text: s }], isError })

function render(r: ReadResult): string {
  if (r.kind === 'full') return `[lossless-context] ${r.path} — full content (${r.bytes} bytes):\n${r.content}`
  if (r.kind === 'diff')
    return (
      `[lossless-context] ${r.path} changed since your last read this context. ` +
      `Apply this unified diff to the copy you already have (do NOT re-request the whole file):\n\n${r.patch}`
    )
  return (
    `[lossless-context] ${r.path} is byte-identical to your last read this context (hash ${r.hash}). ` +
    `Reuse the content you already have — nothing to add.`
  )
}

const server = new McpServer({ name: 'lossless-context', version: '0.1.0' })

server.tool(
  'read_file',
  'Read a text file with lossless token savings. The FIRST read of a file (or the first ' +
    'after a context compaction) returns full content. A later read of an UNCHANGED file ' +
    'returns a short "reuse what you have" marker. A later read of a CHANGED file returns a ' +
    'unified DIFF to apply to the copy you already have — never the whole file again. All ' +
    'savings are lossless: it only diffs/withholds content it can prove you still have. ' +
    'When you receive a diff, apply it mentally to your prior copy; when unchanged, reuse ' +
    'your copy. Pass force_full:true if you want the whole file regardless.',
  {
    path: z.string().describe('Path to the file to read (absolute, or relative to the server cwd).'),
    force_full: z
      .boolean()
      .optional()
      .describe('Return the full file content even when a diff or unchanged-marker would suffice.'),
  },
  async ({ path, force_full }) => {
    engine.setEpoch(getEpoch()) // honor any compaction/session reset signalled by the hooks
    let content: string
    try {
      const st = statSync(path)
      if (st.size > MAX_BYTES)
        return text(
          `[lossless-context] ${path} is ${st.size} bytes (> LOSSLESS_MAX_BYTES=${MAX_BYTES}); ` +
            `read it with the native Read tool using offset/limit.`,
          true,
        )
      content = readFileSync(path, 'utf8')
    } catch (e) {
      return text(`[lossless-context] cannot read ${path}: ${(e as Error).message}`, true)
    }

    const r = engine.read(path, content, force_full === true)
    const baseT = encode(content).length
    const body = r.kind === 'full' ? r.content! : r.kind === 'diff' ? r.patch! : (r.note ?? '')
    const sentT = encode(body).length
    stats.baselineTokens += baseT
    stats.sentTokens += sentT
    stats[r.kind]++
    return text(render(r))
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
