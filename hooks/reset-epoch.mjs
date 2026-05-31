#!/usr/bin/env node
// Claude Code hook for lossless-context-mcp.
// Wire this to BOTH SessionStart and PreCompact. It bumps the epoch sentinel so the MCP
// server reverts to full content whenever the model loses prior file bodies (new session,
// or compaction). A bump is strictly increasing, so a compaction can never be missed.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

try { readFileSync(0) } catch {} // drain the hook payload on stdin so the pipe closes

const dir = process.env.LOSSLESS_CONTEXT_DIR || join(homedir(), '.lossless-context')
const file = join(dir, 'epoch')
let cur = 0
try { cur = Number(readFileSync(file, 'utf8').trim()) || 0 } catch {}
mkdirSync(dir, { recursive: true })
writeFileSync(file, String(Math.max(Date.now(), cur + 1)))
