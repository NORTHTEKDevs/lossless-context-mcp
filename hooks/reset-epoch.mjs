#!/usr/bin/env node
// Claude Code hook for lossless-context-mcp.
// Wire this to SessionStart (the init installer does). It bumps the machine-global epoch
// sentinel so the dedup ENGINE reverts to full content whenever any model may have lost
// prior file bodies — cross-session bumps there are merely conservative (a full
// re-send), never wrong. For CONTEXT-LOSS sources (compact, clear) it additionally marks
// the per-session guard epoch, which is what the blind-edit guard consults — the guard
// must never be tripped by OTHER sessions starting (that caused false-deny storms).
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

let payload = {}
try { payload = JSON.parse(readFileSync(0, 'utf8')) } catch {}

const dir = process.env.LOSSLESS_CONTEXT_DIR || join(homedir(), '.lossless-context')
const file = join(dir, 'epoch')
let cur = 0
try { cur = Number(readFileSync(file, 'utf8').trim()) || 0 } catch {}
mkdirSync(dir, { recursive: true })
writeFileSync(file, String(Math.max(Date.now(), cur + 1)))

try {
  const lossy = payload.source === 'compact' || payload.source === 'clear'
  if (lossy && typeof payload.session_id === 'string') {
    const here = dirname(fileURLToPath(import.meta.url))
    const { markSessionEpoch } = await import(pathToFileURL(join(here, '..', 'dist', 'guard.js')).href)
    markSessionEpoch(payload.session_id)
  }
} catch {} // guard-epoch marking is best-effort; the global bump above already happened
