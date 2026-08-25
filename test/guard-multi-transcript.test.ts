import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { offsetFor, readNewLines, setOffsetFor, type GuardState } from '../src/guard.ts'

// Regression: one session, many transcripts.
//
// A session's guard state used to carry a single scalar `offset`. Claude Code
// gives subagents their OWN transcript file while keeping the parent's
// session_id, so every parallel subagent's guard invocation loaded the parent's
// offset and applied it to a much smaller file. readNewLines then hit its
// `size <= offset` branch, returned zero lines, and the subagent's own Read
// calls were never recorded -- so the guard denied edits to files the agent had
// just read. Observed 2026-08-25 with a 1,073,989-byte parent offset against a
// 133,728-byte agent transcript, during a 6-agent parallel wave.

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'lcm-multi-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

const line = (path: string, content: string) =>
  JSON.stringify({
    timestamp: new Date(1_800_000_000_000).toISOString(),
    toolUseResult: { type: 'text', file: { filePath: path, content, numLines: 1, startLine: 1, totalLines: 1 } },
  }) + '\n'

describe('per-transcript offsets', () => {
  it('does not apply the parent transcript offset to a smaller subagent transcript', () => {
    const parent = join(work, 'parent.jsonl')
    const agent = join(work, 'agent.jsonl')
    // Parent is large; agent is small -- the exact shape that broke.
    writeFileSync(parent, line('/x/big.ts', 'x'.repeat(50_000)))
    writeFileSync(agent, line('/x/agent-read.ts', 'hello'))

    const state: GuardState = { offset: 0, seen: {} }

    const p = readNewLines(parent, offsetFor(state, parent))
    setOffsetFor(state, parent, p.offset)
    expect(p.lines).toHaveLength(1)
    expect(offsetFor(state, parent)).toBeGreaterThan(40_000)

    // The agent's transcript must start from ITS own offset (0), not the parent's.
    const a = readNewLines(agent, offsetFor(state, agent))
    expect(offsetFor(state, agent)).toBe(0)
    expect(a.lines).toHaveLength(1)
    expect(a.lines[0]).toContain('agent-read.ts')
  })

  it('advances each transcript independently across repeated invocations', () => {
    const a = join(work, 'a.jsonl')
    const b = join(work, 'b.jsonl')
    writeFileSync(a, line('/x/a1.ts', 'a1'))
    writeFileSync(b, line('/x/b1.ts', 'b1'))
    const state: GuardState = { offset: 0, seen: {} }

    for (const t of [a, b]) setOffsetFor(state, t, readNewLines(t, offsetFor(state, t)).offset)
    // Nothing new in either.
    expect(readNewLines(a, offsetFor(state, a)).lines).toHaveLength(0)
    expect(readNewLines(b, offsetFor(state, b)).lines).toHaveLength(0)

    // Append only to b; a must stay quiet and b must yield exactly the new line.
    writeFileSync(b, line('/x/b1.ts', 'b1') + line('/x/b2.ts', 'b2'))
    expect(readNewLines(a, offsetFor(state, a)).lines).toHaveLength(0)
    const nb = readNewLines(b, offsetFor(state, b))
    expect(nb.lines).toHaveLength(1)
    expect(nb.lines[0]).toContain('b2.ts')
  })

  it('falls back to 0 for an unknown transcript rather than a legacy scalar offset', () => {
    const t = join(work, 't.jsonl')
    writeFileSync(t, line('/x/only.ts', 'v'))
    // State written by an older version: a scalar offset far past this file's size.
    const legacy: GuardState = { offset: 1_073_989, seen: {} }
    expect(offsetFor(legacy, t)).toBe(0)
    expect(readNewLines(t, offsetFor(legacy, t)).lines).toHaveLength(1)
  })

  it('bounds the offsets map so long sessions cannot grow it without limit', () => {
    const state: GuardState = { offset: 0, seen: {} }
    for (let i = 0; i < 400; i++) setOffsetFor(state, join(work, `t${i}.jsonl`), i)
    const n = Object.keys(state.offsets ?? {}).length
    expect(n).toBeLessThanOrEqual(256)
    // The most recent writes must survive the trim.
    expect(offsetFor(state, join(work, 't399.jsonl'))).toBe(399)
  })
})
