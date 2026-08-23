#!/usr/bin/env node
// Claude Code hook for lossless-context-mcp: the post-compaction recovery pass.
// Wire this to SessionStart with matcher "compact" (add "resume" if you want recovery
// after resumes too). It loads the working-set manifest the sweep hook wrote and injects
// a compact table of what the session was working on, so the model knows exactly what is
// recoverable instead of flailing or guessing at lost file contents.
//
// Output uses hookSpecificOutput.additionalContext (capped at 10k chars by the harness;
// renderManifest budgets well under that). Any internal error exits 0 with no output.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let payload = {}
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {}

try {
  const source = payload.source
  if (source !== 'compact' && source !== 'resume') process.exit(0)

  const { loadManifest, renderManifest } = await import(pathToFileURL(join(here, '..', 'dist', 'restore.js')).href)
  const manifest = loadManifest(payload.session_id)
  if (!manifest || manifest.entries.length === 0) process.exit(0)

  let text = renderManifest(manifest)
  if (text.length > 9500) text = text.slice(0, 9500) + '\n[truncated]'
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }),
  )
} catch (e) {
  try { process.stderr.write(`[lossless-context] inject failed (non-fatal): ${e?.message}\n`) } catch {}
}
process.exit(0)
