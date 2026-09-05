import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentTranscriptPath,
  decideEdit,
  guardStateKey,
  offsetFor,
  readNewLines,
  setOffsetFor,
  updateSeenFromLine,
  type GuardState,
} from '../src/guard.ts'
import { hashContent } from '../src/engine.ts'

// Regression: subagent edits denied as never-seen.
//
// Claude Code fires PreToolUse for a subagent's Edit with the PARENT session's
// transcript_path and an `agent_id`; the agent's own Read results are recorded in
// `<transcript dir>/<session id>/subagents/agent-<agent_id>.jsonl` (each line
// carries isSidechain: true and agentId). The hook only scanned the parent
// transcript, so no subagent Read was ever marked seen and every subagent Edit
// was denied. Observed 2026-09-04 across three implementer subagents and a
// two-tool probe (Read, then Edit of the same file).

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'lcm-agent-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

const readLine = (path: string, content: string, agentId?: string) =>
  JSON.stringify({
    timestamp: new Date(1_800_000_000_000).toISOString(),
    ...(agentId ? { isSidechain: true, agentId } : {}),
    toolUseResult: { type: 'text', file: { filePath: path, content, numLines: 1, startLine: 1, totalLines: 1 } },
  }) + '\n'

describe('agentTranscriptPath', () => {
  it('resolves the subagent file next to the parent transcript, keyed by the session basename', () => {
    const parent = join('C:', 'Users', 'k', '.claude', 'projects', 'C--x', 'abc-123.jsonl')
    expect(agentTranscriptPath(parent, 'a0355f5')).toBe(
      join('C:', 'Users', 'k', '.claude', 'projects', 'C--x', 'abc-123', 'subagents', 'agent-a0355f5.jsonl'),
    )
  })
  it('is case-insensitive about the .jsonl suffix', () => {
    expect(agentTranscriptPath('/t/s.JSONL', 'x')).toBe(join('/t/s', 'subagents', 'agent-x.jsonl'))
  })
})

describe('guardStateKey', () => {
  it('keeps the plain session id for the main loop and namespaces subagents under it', () => {
    expect(guardStateKey('sess')).toBe('sess')
    expect(guardStateKey('sess', 'ag1')).toBe('sess.agent-ag1')
    expect(guardStateKey('sess', 'ag1')).not.toBe(guardStateKey('sess', 'ag2'))
  })
})

describe('subagent edit after its own Read', () => {
  it('is allowed once the agent transcript is scanned, and the parent transcript alone never vouches for it', () => {
    const parent = join(work, 'sess.jsonl')
    const file = join(work, 'target.ts')
    const content = 'export const x = 1\n'
    writeFileSync(file, content)
    // Parent read something else; the agent read the target.
    writeFileSync(parent, readLine(join(work, 'other.ts'), 'other'))
    const agentPath = agentTranscriptPath(parent, 'ag1')
    mkdirSync(join(agentPath, '..'), { recursive: true })
    writeFileSync(agentPath, readLine(file, content, 'ag1'))

    const disk = { exists: true, hash: hashContent(content) }

    // Scanning only the parent (the old behavior) denies the agent's edit.
    const parentOnly: GuardState = { offset: 0, seen: {} }
    const p = readNewLines(parent, offsetFor(parentOnly, parent))
    for (const l of p.lines) updateSeenFromLine(parentOnly.seen, l)
    setOffsetFor(parentOnly, parent, p.offset)
    expect(decideEdit('Edit', file, parentOnly.seen, 0, disk)).toMatchObject({ allow: false, kind: 'never-seen' })

    // Scanning the agent's own transcript into the agent's own state allows it.
    const agentState: GuardState = { offset: 0, seen: {} }
    const a = readNewLines(agentPath, offsetFor(agentState, agentPath))
    for (const l of a.lines) updateSeenFromLine(agentState.seen, l)
    setOffsetFor(agentState, agentPath, a.offset)
    expect(decideEdit('Edit', file, agentState.seen, 0, disk)).toEqual({ allow: true })
  })
})
