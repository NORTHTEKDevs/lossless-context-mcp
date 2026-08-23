import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archive } from '../src/archive.ts'
import { hashContent } from '../src/engine.ts'
import { parseLine, sweepTranscript } from '../src/sweep.ts'

let root: string
let work: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lcm-sweep-'))
  work = mkdtempSync(join(tmpdir(), 'lcm-work-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

// Fixture lines mirror the empirically observed transcript shape (2026-08, CC ~2.x):
// tool_use blocks inside message.content, and a top-level toolUseResult.file for Reads.
// The parser must treat this as BEST-EFFORT: unknown shapes and corrupt lines are skipped.
const ts = '2026-08-10T01:00:00.000Z'
const readUse = (path: string, sidechain = false) =>
  JSON.stringify({
    timestamp: ts,
    isSidechain: sidechain,
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path } }] },
  })
const readResult = (path: string, content: string, partial = false) =>
  JSON.stringify({
    timestamp: ts,
    toolUseResult: {
      type: 'text',
      file: partial
        ? { filePath: path, content, numLines: 5, startLine: 10, totalLines: 100 }
        : { filePath: path, content, numLines: 2, startLine: 1, totalLines: 2 },
    },
  })
const editUse = (path: string) =>
  JSON.stringify({
    timestamp: ts,
    message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }] },
  })

describe('parseLine', () => {
  it('extracts Read/Edit/Write touches with sidechain flags', () => {
    const r = parseLine(readUse('/x/a.ts', true))
    expect(r?.touches).toEqual([{ path: '/x/a.ts', op: 'read', sidechain: true, ts }])
    const e = parseLine(editUse('/x/b.ts'))
    expect(e?.touches[0]).toMatchObject({ path: '/x/b.ts', op: 'edit' })
  })
  it('captures exact versions only for COMPLETE reads', () => {
    expect(parseLine(readResult('/x/a.ts', 'full content'))?.exact?.content).toBe('full content')
    expect(parseLine(readResult('/x/a.ts', 'partial', true))?.exact).toBeUndefined()
  })
  it('ignores MCP tool names, corrupt JSON, and unknown shapes', () => {
    const mcp = JSON.stringify({
      timestamp: ts,
      message: { content: [{ type: 'tool_use', id: 't3', name: 'mcp__lossless-context__read_file', input: { path: '/x/a.ts' } }] },
    })
    expect(parseLine(mcp)).toBeNull()
    expect(parseLine('{{{not json')).toBeNull()
    expect(parseLine(JSON.stringify({ some: 'metadata line' }))).toBeNull()
  })
})

describe('sweepTranscript', () => {
  it('archives exact versions + current disk state and ranks the working set', async () => {
    const fileA = join(work, 'a.ts')
    const fileB = join(work, 'b.ts')
    const fileEdited = join(work, 'c.ts')
    writeFileSync(fileA, 'current A on disk')
    writeFileSync(fileB, 'current B on disk')
    writeFileSync(fileEdited, 'current C on disk')
    const oldVersionA = 'the exact version the model saw'
    const transcript = join(work, 'session.jsonl')
    writeFileSync(
      transcript,
      [
        readUse(fileA),
        readResult(fileA, oldVersionA),
        readUse(fileA), // second read: heat
        readUse(fileB),
        editUse(fileEdited),
        readUse(join(work, 'missing.ts')), // deleted since — must be skipped, not fatal
        readUse(join(work, 'sidechain-only.ts'), true), // subagent: no manifest entry
        'corrupt line {{{',
      ].join('\n') + '\n',
      'utf8',
    )

    const archive = new Archive(root, 'test-sweeper')
    const { stats, workingSet } = await sweepTranscript(transcript, archive, { session: 'sess-1' })

    // Working set: edited file first, then by touches; sidechain + missing excluded.
    expect(workingSet.map((w) => w.path)).toEqual([fileEdited, fileA, fileB])
    expect(workingSet[0].lastOp).toBe('edit')
    expect(workingSet[1].reads).toBe(2)

    // Exact version archived (tier 2) AND current disk state archived (tier 1).
    expect(archive.getBlob(hashContent(oldVersionA))).toBe(oldVersionA)
    expect(archive.getBlob(hashContent('current A on disk'))).toBe('current A on disk')
    expect(stats.exactVersions).toBe(1)
    expect(stats.skipped).toBeGreaterThanOrEqual(1) // the missing file

    // Events carry the session and source.
    const events = archive.readEvents()
    expect(events.length).toBeGreaterThanOrEqual(4)
    expect(events.every((e) => e.session === 'sess-1' && e.source === 'sweep')).toBe(true)
  })

  it('never archives excluded (secret) content but still lists it in the working set', async () => {
    const secret = join(work, '.env')
    writeFileSync(secret, 'API_KEY=hunter2')
    const transcript = join(work, 't.jsonl')
    writeFileSync(transcript, readUse(secret) + '\n' + readResult(secret, 'API_KEY=hunter2') + '\n', 'utf8')
    const archive = new Archive(root, 'test-sweeper')
    const { workingSet } = await sweepTranscript(transcript, archive, { session: 's' })
    expect(workingSet).toHaveLength(1)
    expect(workingSet[0].excluded).toBe(true)
    expect(archive.getBlob(hashContent('API_KEY=hunter2'))).toBeNull()
    const events = archive.readEvents()
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events.every((e) => e.excluded === true)).toBe(true)
  })

  it('excluded paths leave NO content-derived metadata on disk (review finding #5)', async () => {
    const secret = join(work, '.env')
    writeFileSync(secret, 'API_KEY=hunter2')
    const transcript = join(work, 't.jsonl')
    writeFileSync(transcript, readUse(secret) + '\n' + readResult(secret, 'API_KEY=hunter2') + '\n', 'utf8')
    const archive = new Archive(root, 'test-sweeper')
    const { workingSet } = await sweepTranscript(transcript, archive, { session: 's' })
    // No hash, no bytes, no token estimate — path + counts only.
    expect(workingSet[0].hash).toBe('')
    expect(workingSet[0].bytes).toBe(0)
    expect(workingSet[0].approxTokens).toBe(0)
    for (const e of archive.readEvents()) {
      expect(e.hash).toBe('')
      expect(e.bytes).toBe(0)
      expect(e.approxTokens).toBe(0)
      expect(e.gitBlobSha1).toBeUndefined()
    }
  })

  it('caps the exact-version buffer by LOSSLESS_SWEEP_EXACT_BYTES (review finding #4)', async () => {
    process.env.LOSSLESS_SWEEP_EXACT_BYTES = '100'
    try {
      const big1 = 'A'.repeat(80)
      const big2 = 'B'.repeat(80) // second one exceeds the 100-byte budget
      const fa = join(work, 'a.ts')
      const fb = join(work, 'b.ts')
      writeFileSync(fa, big1)
      writeFileSync(fb, big2)
      const transcript = join(work, 't.jsonl')
      writeFileSync(transcript, [readResult(fa, big1), readResult(fb, big2)].join('\n') + '\n', 'utf8')
      const archive = new Archive(root, 'test-sweeper')
      const { stats } = await sweepTranscript(transcript, archive, { session: 's' })
      expect(stats.exactVersions).toBe(1) // only the first fit the budget
      expect(stats.skipped).toBeGreaterThanOrEqual(1)
      expect(archive.getBlob(hashContent(big1))).toBe(big1)
    } finally {
      delete process.env.LOSSLESS_SWEEP_EXACT_BYTES
    }
  })
})
