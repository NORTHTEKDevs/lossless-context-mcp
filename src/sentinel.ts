// Epoch sentinel: a tiny shared file the bundled Claude Code hooks bump to signal
// "the model just lost prior context" (SessionStart = new session, PreCompact = compaction).
// The server reads it before every request; when it changes, the engine clears its ledger
// and reverts to full content. A bump ALWAYS produces a strictly larger value, so a
// compaction can never be missed (a missed reset is the only way to lose quality).

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const DIR = process.env.LOSSLESS_CONTEXT_DIR || join(homedir(), '.lossless-context')
const EPOCH_FILE = join(DIR, 'epoch')

export function getEpoch(): number {
  try {
    const n = Number(readFileSync(EPOCH_FILE, 'utf8').trim())
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function bumpEpoch(): number {
  mkdirSync(DIR, { recursive: true })
  const next = Math.max(Date.now(), getEpoch() + 1) // strictly increasing -> never a missed reset
  writeFileSync(EPOCH_FILE, String(next))
  return next
}
