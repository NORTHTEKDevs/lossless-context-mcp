import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SeenEntry } from '../src/guard.ts'
import { extractLandedEdit } from '../src/guard.ts'
import {
  attributeEdit,
  evaluateCross,
  loadOthers,
  loadOwnPresence,
  presenceDir,
  publishEdit,
  renderConflictReason,
  saveOwnPresence,
  writerKey,
  type PresenceRecord,
} from '../src/presence.ts'

let ctx: string
beforeEach(() => {
  ctx = mkdtempSync(join(tmpdir(), 'lcm-presence-'))
  process.env.LOSSLESS_CONTEXT_DIR = ctx
})
afterEach(() => {
  delete process.env.LOSSLESS_CONTEXT_DIR
  rmSync(ctx, { recursive: true, force: true })
})

// Anchored to the real clock: loadOthers filters by file MTIME, so a synthetic NOW far
// from the actual write time would filter everything out (or nothing).
const NOW = Date.now()
const record = (over: Partial<PresenceRecord>): PresenceRecord => ({
  sid: 'other-session',
  agent: 'main',
  pid: 999,
  updatedAt: NOW,
  intents: [],
  edits: [],
  ...over,
})

describe('presence store (logical-agent identity)', () => {
  it('identity is session+agent, stable across one-shot hook invocations', () => {
    // Two "invocations" of the same logical agent write to ONE file.
    saveOwnPresence(record({ sid: 's1', agent: 'main', intents: [{ path: '/x/a.ts', ts: NOW }] }), NOW)
    const secondInvocation = loadOwnPresence('s1', undefined, NOW)
    expect(secondInvocation.intents).toHaveLength(1) // sees its own earlier intent
    expect(readdirSync(presenceDir()).filter((n) => n.endsWith('.json'))).toHaveLength(1)
    // And loadOthers with the own key excludes it entirely → no self-conflict possible.
    expect(loadOthers(writerKey('s1', undefined), NOW)).toHaveLength(0)
  })
  it('sibling subagents (same sid, different agent) are separate, visible writers', () => {
    saveOwnPresence(record({ sid: 's1', agent: 'main' }), NOW)
    saveOwnPresence(record({ sid: 's1', agent: 'sub-42', intents: [{ path: '/x/a.ts', ts: NOW }] }), NOW)
    const others = loadOthers(writerKey('s1', undefined), NOW)
    expect(others).toHaveLength(1)
    expect(others[0].agent).toBe('sub-42')
  })
  it('prunes stale records, bounds lists, and dedupes double-published edits', () => {
    const old = NOW - 3 * 3600_000
    saveOwnPresence(
      record({
        sid: 's',
        intents: [{ path: '/x/dead.ts', ts: old }],
        // Same landed edit via publisher (hashed) and transcript sweep (hashless), ~same time.
        edits: [
          { path: '/x/f.ts', ts: NOW - 1000 },
          { path: '/x/f.ts', ts: NOW - 1000, hash: 'h1' },
        ],
      }),
      NOW,
    )
    const r = loadOwnPresence('s', undefined, NOW)
    expect(r.intents).toHaveLength(0)
    expect(r.edits).toHaveLength(1)
    expect(r.edits[0].hash).toBe('h1') // richer record wins
  })
  it('garbage-collects provably stale presence files during loadOthers', () => {
    saveOwnPresence(record({ sid: 'live' }), NOW)
    saveOwnPresence(record({ sid: 'dead' }), NOW)
    const deadFile = join(presenceDir(), `${writerKey('dead', undefined)}.json`)
    const old = new Date(NOW - 3 * 3600_000)
    utimesSync(deadFile, old, old)
    const others = loadOthers('', NOW)
    expect(others).toHaveLength(1)
    expect(others[0].sid).toBe('live')
    expect(existsSync(deadFile)).toBe(false) // deleted, not just skipped
  })
  it('ignores corrupt presence files instead of failing', () => {
    saveOwnPresence(record({ sid: 's1' }), NOW)
    writeFileSync(join(presenceDir(), 'garbage.json'), '{{{', 'utf8')
    expect(loadOthers('', NOW)).toHaveLength(1)
  })
})

describe('publishEdit (the PostToolUse publisher)', () => {
  it('publishes a landed edit immediately and retires the matching intent', () => {
    saveOwnPresence(record({ sid: 's1', agent: 'sub-1', intents: [{ path: '/x/f.ts', ts: NOW - 5000 }, { path: '/x/other.ts', ts: NOW - 5000 }] }), NOW)
    publishEdit('s1', 'sub-1', '/x/f.ts', 'post-edit-hash', NOW)
    const r = loadOwnPresence('s1', 'sub-1', NOW)
    expect(r.edits).toHaveLength(1)
    expect(r.edits[0].hash).toBe('post-edit-hash')
    expect(r.intents.map((i) => i.path)).toEqual(['/x/other.ts'])
    // A single-shot subagent's edit is now visible to other sessions with no further invocations.
    const seenByOthers = loadOthers(writerKey('s2', undefined), NOW)
    expect(seenByOthers.some((o) => o.edits.some((e) => e.path === '/x/f.ts'))).toBe(true)
  })
})

describe('evaluateCross', () => {
  const seen = (tsOffset: number, hash?: string): SeenEntry => ({ ts: NOW + tsOffset, hash })

  it('C2: denies on a fresh in-flight intent from another agent', () => {
    const others = [record({ intents: [{ path: '/x/f.ts', ts: NOW - 10_000 }] })]
    const c = evaluateCross('/x/f.ts', seen(-60_000, 'h'), 'my-session', others, NOW)
    expect(c?.kind).toBe('in-flight')
    expect(c?.sameSession).toBe(false)
    expect(renderConflictReason('/x/f.ts', c!)).toContain('may not have landed yet')
  })
  it('C2: flags sibling subagents of the SAME session', () => {
    const others = [record({ sid: 'my-session', agent: 'sub-7', intents: [{ path: '/x/f.ts', ts: NOW - 5_000 }] })]
    const c = evaluateCross('/x/f.ts', seen(-60_000, 'h'), 'my-session', others, NOW)
    expect(c?.sameSession).toBe(true)
    expect(renderConflictReason('/x/f.ts', c!)).toContain('THIS session')
  })
  it('C2: stale intents and intents older than my own read do not conflict', () => {
    const stale = [record({ intents: [{ path: '/x/f.ts', ts: NOW - 10 * 60_000 }] })]
    expect(evaluateCross('/x/f.ts', seen(-60_000, 'h'), 'me', stale, NOW)).toBeNull()
    const beforeMyRead = [record({ intents: [{ path: '/x/f.ts', ts: NOW - 30_000 }] })]
    expect(evaluateCross('/x/f.ts', seen(-10_000, 'h'), 'me', beforeMyRead, NOW)).toBeNull()
  })
  it('C1: denies a landed edit newer than my hashless seen-entry', () => {
    const others = [record({ edits: [{ path: '/x/f.ts', ts: NOW - 20_000 }] })]
    const c = evaluateCross('/x/f.ts', seen(-60_000, undefined), 'me', others, NOW)
    expect(c?.kind).toBe('landed-edit')
    expect(renderConflictReason('/x/f.ts', c!)).toContain('AFTER you last saw it')
  })
  it('C1: yields to the drift check when I hold a comparable hash', () => {
    const others = [record({ edits: [{ path: '/x/f.ts', ts: NOW - 20_000 }] })]
    expect(evaluateCross('/x/f.ts', seen(-60_000, 'my-hash'), 'me', others, NOW)).toBeNull()
  })
  it('no conflict for unrelated paths or never-seen files (single-session rules own those)', () => {
    const others = [record({ intents: [{ path: '/x/other.ts', ts: NOW - 5_000 }], edits: [{ path: '/x/other.ts', ts: NOW - 5_000 }] })]
    expect(evaluateCross('/x/f.ts', seen(-60_000), 'me', others, NOW)).toBeNull()
    expect(evaluateCross('/x/other.ts', undefined, 'me', [record({ edits: [{ path: '/x/other.ts', ts: NOW }] })], NOW)).toBeNull()
  })
})

describe('attribution + landed-edit extraction', () => {
  it('attributeEdit finds the most recent culprit and flags same-session', () => {
    const others = [
      record({ sid: 'older', edits: [{ path: '/x/f.ts', ts: NOW - 90_000 }] }),
      record({ sid: 'me', agent: 'sub-2', edits: [{ path: '/x/f.ts', ts: NOW - 5_000 }] }),
    ]
    const who = attributeEdit('/x/f.ts', others, 'me', NOW)
    expect(who?.otherSid).toBe('me')
    expect(who?.sameSession).toBe(true)
  })
  it('extractLandedEdit parses Edit (no hash) and Write (hashed) results, nothing else', () => {
    const ts = new Date(NOW).toISOString()
    const edit = extractLandedEdit(JSON.stringify({ timestamp: ts, toolUseResult: { filePath: '/x/e.ts', oldString: 'a', newString: 'b' } }))
    expect(edit).toMatchObject({ path: '/x/e.ts' })
    expect(edit?.hash).toBeUndefined()
    const write = extractLandedEdit(JSON.stringify({ timestamp: ts, toolUseResult: { type: 'create', filePath: '/x/w.ts', content: 'abc' } }))
    expect(write?.hash).toBeDefined()
    expect(extractLandedEdit(JSON.stringify({ timestamp: ts, toolUseResult: { type: 'text', file: { filePath: '/x/r.ts', content: 'read' } } }))).toBeNull()
    expect(extractLandedEdit('{{{')).toBeNull()
  })
})
