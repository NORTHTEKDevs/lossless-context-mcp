// Blind-edit guard: the active safety net over the flight recorder.
//
// Two incident classes it prevents, both live in the wild:
//   1. POST-COMPACT GUESS-EDITS — after a compaction (or resume/clear), the model no
//      longer holds a file's contents, but the harness's own read-before-edit state may
//      still consider it "read". The model edits from memory of a summary. This guard
//      denies the edit with a one-line reason; the model re-reads and retries — a
//      self-healing loop costing exactly one extra read.
//   2. STALE-BASE EDITS — the file changed on disk since the model last saw it (another
//      agent, the user, a formatter). Denied with the same re-read instruction.
//
// Non-negotiables: FAIL-OPEN (any internal doubt → allow; a broken guard must never
// brick editing) and fast (incremental transcript indexing from a persisted byte
// offset — only new lines are parsed per invocation).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextRoot } from './archive.js'
import { hashContent, normalizeKey } from './engine.js'

export interface SeenEntry {
  /** ms timestamp of the latest event that put this file's content in the model's view */
  ts: number
  /** SHA-256 of that content when knowable (full Read result, Write content) */
  hash?: string
}

export interface GuardState {
  /** Legacy single-transcript cursor. Retained so older state files still load,
   *  but never consulted for reads -- see `offsets` for why. */
  offset: number
  /** Byte cursor PER transcript path. A session has more than one transcript:
   *  Claude Code gives every subagent its own file while keeping the parent's
   *  session_id, so a single scalar cursor got applied to files it did not
   *  belong to. When the parent cursor exceeded a subagent transcript's size,
   *  readNewLines took its truncated/rotated branch, returned no lines, and the
   *  agent's own Read calls were never recorded -- the guard then denied edits
   *  to files that agent had just read. Keyed by normalized path. */
  offsets?: Record<string, number>
  seen: Record<string, SeenEntry>
  /** ms timestamp of THIS SESSION's last context-loss event (compaction, /clear).
   *  Session-scoped on purpose: the machine-global epoch file is bumped by EVERY
   *  session's start/compaction, so using it here caused false-deny storms for
   *  concurrent sessions (session A starting made session B's whole seen-state look
   *  pre-epoch). The global file still serves the dedup ENGINE, where cross-session
   *  bumps are merely conservative (a full re-send), never wrong. */
  epochMs?: number
}

export const GUARDED_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

const LOSSLESS_TOOL_PREFIX = /^mcp__[^_]*lossless[^_]*__/
// First line of each part of this server's own read render (we control this format).
const LOSSLESS_RENDER_HEAD = /^\[lossless-context\] (.+?)(?: \((?:symbol|lines)[^)]*\))? (?:\u2014 full content|is byte-identical|changed since your last read)/
const BATCH_SEPARATOR = '\n\n---\n\n'

/** Update seen-state from one transcript line. Returns true if the line parsed.
 *
 *  SELF-VOUCH RULE (the guard's load-bearing invariant): for guarded tools
 *  (Edit/Write/MultiEdit), only tool RESULTS may mark a file as seen — never the
 *  tool_use intent block. The current call's own tool_use is already in the transcript
 *  when PreToolUse fires, so intent-based marking would let every edit approve itself
 *  (and a Write's input content would false-trip the drift check against pre-write
 *  disk). Results only exist after successful execution, so a pending call can never
 *  vouch for itself, regardless of hook/transcript write ordering. */
export function updateSeenFromLine(seen: Record<string, SeenEntry>, line: string): boolean {
  let j: any
  try {
    j = JSON.parse(line)
  } catch {
    return false
  }
  if (!j || typeof j !== 'object') return false
  const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN
  if (Number.isNaN(ts)) return false
  const mark = (path: unknown, hash?: string) => {
    if (typeof path !== 'string' || path.length === 0) return
    const key = normalizeKey(path)
    const cur = seen[key]
    if (!cur || ts >= cur.ts) seen[key] = { ts, hash }
  }

  const tur = j?.toolUseResult
  const file = tur?.file
  if (
    file &&
    typeof file.filePath === 'string' &&
    typeof file.content === 'string' &&
    (file.startLine === undefined || file.startLine === 1) &&
    (file.numLines === undefined || file.totalLines === undefined || file.numLines === file.totalLines)
  ) {
    // Full native-Read result: the exact content the model was shown → comparable hash.
    mark(file.filePath, hashContent(file.content))
  } else if (file && typeof file.filePath === 'string') {
    mark(file.filePath) // partial read: seen, but no comparable hash
  } else if (tur && typeof tur.filePath === 'string') {
    // Edit/Write/MultiEdit RESULT (real shape: filePath at toolUseResult top level).
    // A Write result carries the written content → that IS the post-write disk state.
    mark(tur.filePath, typeof tur.content === 'string' ? hashContent(tur.content) : undefined)
  }

  const content = j?.message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      // Intent-based marks: ONLY for this server's read tools (never guarded tools —
      // see the self-vouch rule above). Worst case here is a false ALLOW when a read
      // later errors, which is the fail-open direction.
      if (block?.type === 'tool_use' && typeof block.name === 'string' && LOSSLESS_TOOL_PREFIX.test(block.name)) {
        const input = block.input ?? {}
        mark(input.path)
        for (const p of Array.isArray(input.paths) ? input.paths : []) mark(p)
        for (const p of Array.isArray(input.files) ? input.files : []) mark(p)
      }
      // Result-based marks for this server's reads (covers restore_context's default
      // manifest restore, whose input names no files): parse our own render headers.
      if (block?.type === 'tool_result') {
        const texts: string[] = []
        if (typeof block.content === 'string') texts.push(block.content)
        else if (Array.isArray(block.content))
          for (const c of block.content) if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text)
        for (const t of texts) {
          if (!t.startsWith('[lossless-context]')) continue
          for (const part of t.split(BATCH_SEPARATOR)) {
            // A batch/restore part may carry a collection header (and, in older wire
            // formats, a blank line) before the file render — scan the first THREE
            // lines. (Bounded so embedded file CONTENT can't spray fake seen-marks; a
            // crafted early content line could still fake one, which errs fail-open,
            // not fail-closed.)
            for (const lineText of part.split('\n', 3)) {
              const m = LOSSLESS_RENDER_HEAD.exec(lineText)
              if (m) mark(m[1])
            }
          }
        }
      }
    }
  }
  return true
}

/** Incrementally read complete lines from `offset`; returns new offset + lines. */
export function readNewLines(transcriptPath: string, offset: number): { lines: string[]; offset: number } {
  const size = statSync(transcriptPath).size
  if (size <= offset) return { lines: [], offset: size < offset ? 0 : offset } // truncated/rotated → reset
  const fd = openSync(transcriptPath, 'r')
  try {
    const buf = Buffer.alloc(size - offset)
    const read = readSync(fd, buf, 0, buf.length, offset)
    const chunk = buf.subarray(0, read).toString('utf8')
    const lastNl = chunk.lastIndexOf('\n')
    if (lastNl < 0) return { lines: [], offset } // no complete new line yet
    return { lines: chunk.slice(0, lastNl).split('\n').filter((l) => l.trim()), offset: offset + Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf8') }
  } finally {
    closeSync(fd)
  }
}

export interface Decision {
  allow: boolean
  reason?: string
  /** Deny class — lets the coordination layer attribute drift denies to a culprit. */
  kind?: 'never-seen' | 'drift'
}

/** Extract a landed guarded-tool edit (Edit/Write/MultiEdit RESULT) from a transcript
 *  line, for publication to the presence plane. Returns null for everything else. */
export function extractLandedEdit(line: string): { path: string; ts: number; hash?: string } | null {
  let j: any
  try {
    j = JSON.parse(line)
  } catch {
    return null
  }
  const tur = j?.toolUseResult
  if (!tur || typeof tur !== 'object' || tur.file || typeof tur.filePath !== 'string') return null
  const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN
  if (Number.isNaN(ts)) return null
  return { path: tur.filePath, ts, hash: typeof tur.content === 'string' ? hashContent(tur.content) : undefined }
}

/** The core verdict. Pure given its inputs; every uncertain branch allows. */
export function decideEdit(
  toolName: string,
  filePath: unknown,
  seen: Record<string, SeenEntry>,
  epochMs: number,
  disk: { exists: boolean; hash?: string },
): Decision {
  if (!GUARDED_TOOLS.has(toolName)) return { allow: true }
  if (typeof filePath !== 'string' || filePath.length === 0) return { allow: true }
  if (!disk.exists) return { allow: true } // creation (Write) or a path the harness will reject anyway
  const entry = seen[normalizeKey(filePath)]
  if (!entry || entry.ts <= epochMs) {
    return {
      allow: false,
      kind: 'never-seen',
      reason:
        `[lossless-context guard] You have not read ${filePath} in the CURRENT context epoch ` +
        `(your context was compacted/reset since it was last seen, or it was never read). ` +
        `Editing from remembered or summarized content is how post-compaction corruption happens. ` +
        `Read the file (or call restore_context), then retry this edit.`,
    }
  }
  if (entry.hash && disk.hash && disk.hash !== entry.hash) {
    return {
      allow: false,
      kind: 'drift',
      reason:
        `[lossless-context guard] ${filePath} has CHANGED on disk since the version you read ` +
        `(content hash differs — another agent, the user, or a tool modified it). ` +
        `Re-read it and re-derive your edit against the current content, then retry.`,
    }
  }
  return { allow: true }
}

// ---------------------------------------------------------------------------
// State persistence for the hook wrapper (one small JSON per session).

export function guardStatePath(sessionId: string): string {
  const dir = join(contextRoot(), 'guard')
  mkdirSync(dir, { recursive: true })
  return join(dir, sessionId.replace(/[^A-Za-z0-9._-]/g, '_') + '.json')
}

/** Cap on tracked transcripts. A long session with many subagents would
 *  otherwise grow this map without bound. Oldest insertions are dropped first;
 *  a dropped transcript costs one re-parse, which is self-healing. */
const OFFSETS_CAP = Number(process.env.LOSSLESS_GUARD_OFFSETS_CAP || 256)

/** Byte cursor for ONE transcript. Unknown transcripts start at 0 rather than
 *  inheriting the legacy scalar: re-parsing a transcript is merely slow, while
 *  starting past its end silently loses every Read in it. */
export function offsetFor(state: GuardState, transcriptPath: string): number {
  const v = state.offsets?.[normalizeKey(transcriptPath)]
  return typeof v === 'number' && v >= 0 ? v : 0
}

export function setOffsetFor(state: GuardState, transcriptPath: string, offset: number): void {
  if (!state.offsets) state.offsets = {}
  const key = normalizeKey(transcriptPath)
  delete state.offsets[key] // re-insert so insertion order tracks recency
  state.offsets[key] = offset
  const keys = Object.keys(state.offsets)
  if (keys.length > OFFSETS_CAP) {
    for (const k of keys.slice(0, keys.length - OFFSETS_CAP)) delete state.offsets[k]
  }
}

export function loadGuardState(sessionId: string): GuardState {
  try {
    const s = JSON.parse(readFileSync(guardStatePath(sessionId), 'utf8')) as GuardState
    if (typeof s.offset === 'number' && s.seen && typeof s.seen === 'object') return s
  } catch {}
  return { offset: 0, seen: {} }
}

/** Record a context-loss moment (compaction, /clear) for ONE session's guard state.
 *  Called by the hooks that witness the event; the guard then requires re-reads only
 *  for content THIS session actually lost. */
export function markSessionEpoch(sessionId: string, now = Date.now()): void {
  const state = loadGuardState(sessionId)
  state.epochMs = now
  saveGuardState(sessionId, state)
}

const SEEN_CAP = Number(process.env.LOSSLESS_GUARD_SEEN_CAP || 5000)

export function saveGuardState(sessionId: string, state: GuardState): void {
  // Bound the map (drop oldest by ts) and write atomically: parallel tool calls spawn
  // concurrent guard processes against this file; a torn write would force a full
  // transcript re-index on the next call (self-healing but slow).
  const keys = Object.keys(state.seen)
  if (keys.length > SEEN_CAP) {
    keys.sort((a, b) => state.seen[a].ts - state.seen[b].ts)
    for (const k of keys.slice(0, keys.length - SEEN_CAP)) delete state.seen[k]
  }
  const target = guardStatePath(sessionId)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state), 'utf8')
  try {
    renameSync(tmp, target)
  } catch {
    try { writeFileSync(target, JSON.stringify(state), 'utf8') } catch {}
    try { unlinkSync(tmp) } catch {}
  }
}

/** Current epoch value (ms) from the sentinel file; 0 when absent (guard then only
 *  enforces the has-it-ever-been-seen rule within this session's transcript). */
export function readEpochMs(): number {
  try {
    const file = join(contextRoot(), 'epoch')
    if (!existsSync(file)) return 0
    return Number(readFileSync(file, 'utf8').trim()) || 0
  } catch {
    return 0
  }
}
