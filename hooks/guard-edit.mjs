#!/usr/bin/env node
// Claude Code hook for lossless-context-mcp: the blind-edit guard.
// Wire to PreToolUse with matcher "Edit|Write|MultiEdit". Denies (with a re-read
// instruction the model sees) edits to files the model has not read in the current
// context epoch, and edits whose on-disk content changed since the model read it.
//
// FAIL-OPEN by design: any internal error, unparseable payload, missing state, or the
// LOSSLESS_GUARD=off env var → the edit proceeds untouched. Exit code is always 0; a
// deny is expressed via stdout JSON only.
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let payload = {}
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {}

try {
  if ((process.env.LOSSLESS_GUARD || '').toLowerCase() === 'off') process.exit(0)
  const toolName = payload.tool_name
  const filePath = payload?.tool_input?.file_path
  const sessionId = payload.session_id
  const transcriptPath = payload.transcript_path
  if (typeof toolName !== 'string' || typeof filePath !== 'string' || typeof sessionId !== 'string') process.exit(0)

  const guard = await import(pathToFileURL(join(here, '..', 'dist', 'guard.js')).href)
  const { hashContent } = await import(pathToFileURL(join(here, '..', 'dist', 'engine.js')).href)

  const state = guard.loadGuardState(sessionId)
  if (typeof transcriptPath === 'string') {
    try {
      const { lines, offset } = guard.readNewLines(transcriptPath, state.offset)
      for (const line of lines) guard.updateSeenFromLine(state.seen, line)
      state.offset = offset
      guard.saveGuardState(sessionId, state)
    } catch {} // transcript unreadable → decide on what we have (fail-open bias below)
  }

  let disk = { exists: false }
  try {
    const st = statSync(filePath)
    if (st.isFile() && st.size <= Number(process.env.LOSSLESS_MAX_BYTES || 2_000_000)) {
      disk = { exists: true, hash: hashContent(readFileSync(filePath, 'utf8')) }
    } else if (st.isFile()) {
      disk = { exists: true } // too big to hash cheaply — epoch rule still applies
    }
  } catch {}

  const d = guard.decideEdit(toolName, filePath, state.seen, guard.readEpochMs(), disk)
  if (!d.allow) {
    // PreToolUse decision control is hookSpecificOutput.permissionDecision (docs-verified);
    // permissionDecisionReason is what the model sees as the block reason.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: d.reason,
        },
      }),
    )
  }
} catch (e) {
  try { process.stderr.write(`[lossless-context] guard failed open: ${e?.message}\n`) } catch {}
}
process.exit(0)
