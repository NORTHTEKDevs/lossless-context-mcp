#!/usr/bin/env node
// Claude Code hook for lossless-context-mcp: landed-edit publication.
// Wire to PostToolUse with matcher "Edit|Write|MultiEdit". Fires right after a guarded
// tool SUCCEEDS and immediately publishes the landed edit to the coordination plane —
// so even a subagent that makes exactly one edit and exits is visible to concurrent
// agents (the guard's transcript sweep only publishes on a NEXT invocation, which a
// single-shot agent never has). Also retires this agent's own in-flight intent.
//
// Fail-open, never blocking: any error exits 0 silently.
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let payload = {}
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {}

try {
  if ((process.env.LOSSLESS_COORD || '').toLowerCase() === 'off') process.exit(0)
  const filePath = payload?.tool_input?.file_path
  const sessionId = payload.session_id
  if (typeof filePath !== 'string' || typeof sessionId !== 'string') process.exit(0)

  const { publishEdit } = await import(pathToFileURL(join(here, '..', 'dist', 'presence.js')).href)
  const { hashContent } = await import(pathToFileURL(join(here, '..', 'dist', 'engine.js')).href)

  // The edit just landed: disk state IS the post-edit content (modulo immediate races).
  let hash
  try {
    const st = statSync(filePath)
    if (st.isFile() && st.size <= Number(process.env.LOSSLESS_MAX_BYTES || 2_000_000)) {
      hash = hashContent(readFileSync(filePath, 'utf8'))
    }
  } catch {}
  publishEdit(sessionId, typeof payload.agent_id === 'string' ? payload.agent_id : undefined, filePath, hash)
} catch (e) {
  try { process.stderr.write(`[lossless-context] publish-edit failed (non-fatal): ${e?.message}\n`) } catch {}
}
process.exit(0)
