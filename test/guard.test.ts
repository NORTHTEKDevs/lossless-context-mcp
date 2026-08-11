import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashContent } from '../src/engine.ts'
import { decideEdit, readNewLines, updateSeenFromLine, type SeenEntry } from '../src/guard.ts'

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'lcm-guard-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

const ts = (offsetMs = 0) => new Date(1_800_000_000_000 + offsetMs).toISOString()
const T0 = 1_800_000_000_000

const readResultLine = (path: string, content: string, offsetMs = 0, partial = false) =>
  JSON.stringify({
    timestamp: ts(offsetMs),
    toolUseResult: {
      type: 'text',
      file: partial
        ? { filePath: path, content, numLines: 3, startLine: 5, totalLines: 50 }
        : { filePath: path, content, numLines: 1, startLine: 1, totalLines: 1 },
    },
  })
const toolUseLine = (name: string, input: Record<string, unknown>, offsetMs = 0) =>
  JSON.stringify({ timestamp: ts(offsetMs), message: { content: [{ type: 'tool_use', id: 'x', name, input }] } })

describe('updateSeenFromLine', () => {
  it('marks full Read results with a comparable hash; partial reads without one', () => {
    const seen: Record<string, SeenEntry> = {}
    updateSeenFromLine(seen, readResultLine('/x/a.ts', 'abc'))
    updateSeenFromLine(seen, readResultLine('/x/b.ts', 'partial view', 0, true))
    expect(Object.values(seen)).toHaveLength(2)
    const [a, b] = [seen[Object.keys(seen).find((k) => k.endsWith('a.ts'))!], seen[Object.keys(seen).find((k) => k.endsWith('b.ts'))!]]
    expect(a.hash).toBe(hashContent('abc'))
    expect(b.hash).toBeUndefined()
  })
  it('SELF-VOUCH RULE: tool_use blocks for guarded tools mark NOTHING', () => {
    // The current call's own tool_use is already in the transcript when PreToolUse
    // fires. If intent marked "seen", every edit would approve itself.
    const seen: Record<string, SeenEntry> = {}
    updateSeenFromLine(seen, toolUseLine('Edit', { file_path: '/x/e.ts', old_string: 'a', new_string: 'b' }))
    updateSeenFromLine(seen, toolUseLine('Write', { file_path: '/x/w.ts', content: 'new stuff' }))
    updateSeenFromLine(seen, toolUseLine('MultiEdit', { file_path: '/x/m.ts', edits: [] }))
    expect(Object.keys(seen)).toHaveLength(0)
  })
  it('marks guarded tools from their RESULTS: Edit without hash, Write with written-content hash', () => {
    const seen: Record<string, SeenEntry> = {}
    // Real shapes (verified against live transcripts): Edit result has filePath at
    // toolUseResult top level; Write result additionally carries the written content.
    updateSeenFromLine(seen, JSON.stringify({ timestamp: ts(), toolUseResult: { filePath: '/x/e.ts', oldString: 'a', newString: 'b', structuredPatch: [] } }))
    updateSeenFromLine(seen, JSON.stringify({ timestamp: ts(), toolUseResult: { type: 'create', filePath: '/x/w.ts', content: 'new stuff', structuredPatch: [] } }))
    expect(seen[Object.keys(seen).find((k) => k.endsWith('e.ts'))!].hash).toBeUndefined()
    expect(seen[Object.keys(seen).find((k) => k.endsWith('w.ts'))!].hash).toBe(hashContent('new stuff'))
  })
  it('marks files from this server\'s own tool_result renders (heals restore_context default)', () => {
    const seen: Record<string, SeenEntry> = {}
    const restoreText =
      '[lossless-context] restore: 2 file(s), ~500 tokens\n' +
      '[lossless-context] /x/first.ts — full content (100 bytes):\ncontents here' +
      '\n\n---\n\n' +
      '[lossless-context] /x/second.ts is byte-identical to your last read this context (hash abcdef123456). Reuse the content you already have.'
    updateSeenFromLine(seen, JSON.stringify({
      timestamp: ts(),
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: restoreText }] }] },
    }))
    expect(Object.keys(seen).some((k) => k.endsWith('first.ts'))).toBe(true)
    expect(Object.keys(seen).some((k) => k.endsWith('second.ts'))).toBe(true)
  })
  it('marks lossless-context MCP tool inputs (path, paths, files)', () => {
    const seen: Record<string, SeenEntry> = {}
    updateSeenFromLine(seen, toolUseLine('mcp__lossless-context__read_file', { path: '/x/one.ts' }))
    updateSeenFromLine(seen, toolUseLine('mcp__lossless-context__read_files', { paths: ['/x/two.ts', '/x/three.ts'] }))
    updateSeenFromLine(seen, toolUseLine('mcp__lossless-context__restore_context', { files: ['/x/four.ts'] }))
    expect(Object.keys(seen)).toHaveLength(4)
  })
  it('newer events win; corrupt lines are ignored', () => {
    const seen: Record<string, SeenEntry> = {}
    updateSeenFromLine(seen, readResultLine('/x/a.ts', 'v1', 0))
    updateSeenFromLine(seen, readResultLine('/x/a.ts', 'v2', 5000))
    expect(updateSeenFromLine(seen, '{{{nope')).toBe(false)
    const key = Object.keys(seen)[0]
    expect(seen[key].hash).toBe(hashContent('v2'))
    expect(seen[key].ts).toBe(T0 + 5000)
  })
})

describe('readNewLines (incremental)', () => {
  it('reads only new complete lines and advances the offset', () => {
    const t = join(work, 't.jsonl')
    writeFileSync(t, 'line1\nline2\n')
    const first = readNewLines(t, 0)
    expect(first.lines).toEqual(['line1', 'line2'])
    appendFileSync(t, 'line3\npartial-no-newline')
    const second = readNewLines(t, first.offset)
    expect(second.lines).toEqual(['line3'])
    const third = readNewLines(t, second.offset)
    expect(third.lines).toEqual([])
  })
  it('resets on truncation instead of erroring', () => {
    const t = join(work, 't.jsonl')
    writeFileSync(t, 'a very long line here\n')
    const first = readNewLines(t, 0)
    writeFileSync(t, 'x\n') // rotated/truncated
    const after = readNewLines(t, first.offset)
    expect(after.offset).toBe(0) // caller re-reads from the start next time
  })
})

describe('decideEdit', () => {
  const seenAt = (offsetMs: number, hash?: string): Record<string, SeenEntry> => ({
    ['/x/f.ts']: { ts: T0 + offsetMs, hash },
  })
  const disk = (hash?: string) => ({ exists: true, hash })

  it('allows non-guarded tools, missing paths, and file creation', () => {
    expect(decideEdit('Read', '/x/f.ts', {}, 0, disk()).allow).toBe(true)
    expect(decideEdit('Edit', undefined, {}, 0, disk()).allow).toBe(true)
    expect(decideEdit('Write', '/x/new.ts', {}, 0, { exists: false }).allow).toBe(true)
  })
  it('DENIES an edit to a file never seen this session', () => {
    const d = decideEdit('Edit', '/x/f.ts', {}, 0, disk())
    expect(d.allow).toBe(false)
    expect(d.reason).toContain('not read')
  })
  it('DENIES the post-compaction class: seen only BEFORE the epoch bump', () => {
    const d = decideEdit('Edit', '/x/f.ts', seenAt(1000), T0 + 60_000, disk())
    expect(d.allow).toBe(false)
    expect(d.reason).toContain('compacted')
  })
  it('allows when seen after the epoch bump', () => {
    expect(decideEdit('Edit', '/x/f.ts', seenAt(120_000, hashContent('v1')), T0 + 60_000, disk(hashContent('v1'))).allow).toBe(true)
  })
  it('DENIES the drift class: disk hash differs from the seen hash', () => {
    const d = decideEdit('Edit', '/x/f.ts', seenAt(120_000, hashContent('what-model-saw')), T0, disk(hashContent('changed-on-disk')))
    expect(d.allow).toBe(false)
    expect(d.reason).toContain('CHANGED on disk')
  })
  it('fails open on drift when no comparable hash exists (post-edit, partial reads)', () => {
    expect(decideEdit('Edit', '/x/f.ts', seenAt(120_000, undefined), T0, disk(hashContent('whatever'))).allow).toBe(true)
    expect(decideEdit('Edit', '/x/f.ts', seenAt(120_000, hashContent('v')), T0, disk(undefined)).allow).toBe(true)
  })
})

describe('end-to-end self-vouch regression (review finding: CRITICAL #1)', () => {
  it('an Edit whose own tool_use is in the transcript is still denied when never read', () => {
    const seen: Record<string, SeenEntry> = {}
    // Realistic transcript tail at PreToolUse time: the pending call's own tool_use line.
    updateSeenFromLine(seen, toolUseLine('Edit', { file_path: '/x/f.ts', old_string: 'a', new_string: 'b' }, 10_000))
    const d = decideEdit('Edit', '/x/f.ts', seen, 0, { exists: true, hash: hashContent('disk') })
    expect(d.allow).toBe(false)
  })
  it('a legit Write after a real read is ALLOWED even with its own tool_use in the transcript', () => {
    const seen: Record<string, SeenEntry> = {}
    const diskContent = 'original content'
    updateSeenFromLine(seen, readResultLine('/x/f.ts', diskContent, 1000)) // real prior read
    updateSeenFromLine(seen, toolUseLine('Write', { file_path: '/x/f.ts', content: 'brand new content' }, 10_000))
    // Disk still holds what the model read; the pending Write's input must not trip drift.
    const d = decideEdit('Write', '/x/f.ts', seen, 0, { exists: true, hash: hashContent(diskContent) })
    expect(d.allow).toBe(true)
  })
})
