#!/usr/bin/env node
// Claude Code hook for lossless-context-mcp: the flight-recorder capture pass.
// Wire this to PreCompact AND SessionEnd. Right before a compaction destroys the
// conversation's file contents (and again when a session ends), it sweeps the session
// transcript into the persistent archive and writes the working-set manifest that
// inject-manifest.mjs restores after compaction.
//
// Non-negotiable behavior: this hook NEVER blocks or fails the session. Any internal
// error exits 0 silently (diagnostics to stderr only). It also bumps the epoch sentinel
// on PreCompact, replacing the need to wire reset-epoch.mjs separately for that event.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Windows requires file:// URLs for absolute-path dynamic imports.
const distUrl = (name) => pathToFileURL(join(here, '..', 'dist', name)).href

let payload = {}
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {}

try {
  // Epoch bump on the events where the model loses held content (PreCompact).
  if (payload.hook_event_name === 'PreCompact') {
    const dir = process.env.LOSSLESS_CONTEXT_DIR || join(homedir(), '.lossless-context')
    const file = join(dir, 'epoch')
    let cur = 0
    try { cur = Number(readFileSync(file, 'utf8').trim()) || 0 } catch {}
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, String(Math.max(Date.now(), cur + 1)))
  }

  const transcriptPath = payload.transcript_path
  const session = payload.session_id || 'unknown-session'
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) process.exit(0)

  const { Archive } = await import(distUrl('archive.js'))
  const { sweepTranscript } = await import(distUrl('sweep.js'))
  const { writeManifest } = await import(distUrl('restore.js'))

  const archive = new Archive(undefined, `sweep-${process.pid}-${Date.now().toString(36)}`)
  const { stats, workingSet } = await sweepTranscript(transcriptPath, archive, { session })
  if (workingSet.length > 0) writeManifest(session, workingSet)
  archive.enforceBudget()
  process.stderr.write(
    `[lossless-context] sweep: ${stats.lines} lines, ${workingSet.length} working-set file(s), ` +
      `${stats.exactVersions} exact + ${stats.diskVersions} disk version(s) archived\n`,
  )
} catch (e) {
  try { process.stderr.write(`[lossless-context] sweep failed (non-fatal): ${e?.message}\n`) } catch {}
}
process.exit(0)
