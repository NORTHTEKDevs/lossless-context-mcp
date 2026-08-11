import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archive } from '../src/archive.ts'
import { blameContext, renderBlame } from '../src/blame.ts'
import { desiredHooks, mergeHooks, runInit } from '../src/init.ts'

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'lcm-ib-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('mergeHooks', () => {
  const pkgRoot = 'C:/fake/lossless-context-mcp'

  it('wires all five hook entries into empty settings', () => {
    const { hooks, changes } = mergeHooks(undefined, pkgRoot)
    expect(hooks.PreCompact).toHaveLength(1)
    expect(hooks.SessionEnd).toHaveLength(1)
    expect(hooks.SessionStart).toHaveLength(2) // compact-matched inject + unmatched reset
    expect(hooks.PreToolUse?.[0].matcher).toBe('Edit|Write|MultiEdit')
    expect(changes.filter((c) => c.startsWith('wired:'))).toHaveLength(desiredHooks(pkgRoot).length)
  })

  it('is idempotent: re-running replaces our entries instead of duplicating', () => {
    const first = mergeHooks(undefined, pkgRoot)
    const second = mergeHooks(first.hooks, pkgRoot)
    expect(JSON.stringify(second.hooks)).toBe(JSON.stringify(first.hooks))
  })

  it('updates stale paths from an older install location', () => {
    const stale = mergeHooks(undefined, 'C:/old/place/lossless-context-mcp')
    const updated = mergeHooks(stale.hooks, pkgRoot)
    const all = JSON.stringify(updated.hooks)
    expect(all).not.toContain('old/place')
    expect(all).toContain('C:/fake/lossless-context-mcp')
  })

  it('preserves foreign hooks, including ones sharing an entry with ours', () => {
    const existing = {
      PreCompact: [
        { hooks: [{ type: 'command' as const, command: 'node C:/other/tool.mjs' }] },
      ],
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit',
          hooks: [
            { type: 'command' as const, command: 'node C:/someone/elses-guard.mjs' },
            { type: 'command' as const, command: 'node "C:/old/lossless-context-mcp/hooks/guard-edit.mjs"' },
          ],
        },
      ],
    }
    const { hooks } = mergeHooks(existing, pkgRoot)
    const s = JSON.stringify(hooks)
    expect(s).toContain('C:/other/tool.mjs')
    expect(s).toContain('elses-guard.mjs')
    expect(s).not.toContain('C:/old/lossless-context-mcp')
    // Ours re-added exactly once for the matcher (elses-guard.mjs doesn't match this name).
    expect(s.match(/guard-edit\.mjs/g)).toHaveLength(1)
  })
})

describe('runInit', () => {
  const makePkg = () => {
    const pkgRoot = join(work, 'pkg')
    mkdirSync(join(pkgRoot, 'hooks'), { recursive: true })
    for (const h of ['sweep-transcript.mjs', 'inject-manifest.mjs', 'reset-epoch.mjs', 'guard-edit.mjs'])
      writeFileSync(join(pkgRoot, 'hooks', h), '// hook stub')
    return pkgRoot
  }

  it('creates settings.json when missing and writes all hooks', () => {
    const settingsPath = join(work, 'claude', 'settings.json')
    const r = runInit({ settingsPath, pkgRoot: makePkg() })
    expect(r.wroteFile).toBe(true)
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(Object.keys(written.hooks).sort()).toEqual(['PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart'])
  })

  it('backs up an existing file and preserves unrelated settings', () => {
    const settingsPath = join(work, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus', env: { FOO: '1' } }))
    const r = runInit({ settingsPath, pkgRoot: makePkg() })
    expect(r.backupPath && existsSync(r.backupPath)).toBe(true)
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(written.model).toBe('opus')
    expect(written.env.FOO).toBe('1')
  })

  it('FAILS CLOSED with a friendly message on malformed hooks shapes (valid JSON, wrong structure)', () => {
    const settingsPath = join(work, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreCompact: 'not-an-array' } }))
    expect(() => runInit({ settingsPath, pkgRoot: makePkg() })).toThrow(/not an array/)
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreCompact: [{ matcher: 'x' }] } }))
    expect(() => runInit({ settingsPath, pkgRoot: makePkg() })).toThrow(/no hooks\[\] array/)
  })

  it('FAILS CLOSED on unparseable settings without touching the file', () => {
    const settingsPath = join(work, 'settings.json')
    writeFileSync(settingsPath, '{ this is not json')
    expect(() => runInit({ settingsPath, pkgRoot: makePkg() })).toThrow(/not valid JSON/)
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ this is not json')
  })

  it('dry-run changes nothing on disk', () => {
    const settingsPath = join(work, 'settings.json')
    const r = runInit({ settingsPath, pkgRoot: makePkg(), dryRun: true })
    expect(r.wroteFile).toBe(false)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('refuses when hook scripts are missing from the package', () => {
    const settingsPath = join(work, 'settings.json')
    expect(() => runInit({ settingsPath, pkgRoot: join(work, 'nope') })).toThrow(/hook script missing/)
  })
})

describe('blameContext', () => {
  it('builds a version timeline with co-context and honors excluded events', () => {
    const archive = new Archive(join(work, 'archive'), 'w')
    const base = { repo: '/r', bytes: 10, approxTokens: 3, source: 'sweep' as const, op: 'read' as const, view: 'full' }
    // Two versions of the focus file across two sessions; a co-context file in s1;
    // an excluded (secret) touch of the same focus path.
    archive.record({ ...base, session: 's1', path: '/r/focus.ts', hash: 'v1', gitBlobSha1: 'g1' })
    archive.record({ ...base, session: 's1', path: '/r/other.ts', hash: 'o1' })
    archive.record({ ...base, session: 's2', path: '/r/focus.ts', hash: 'v2' })
    archive.record({ ...base, session: 's1', path: '/r/focus.ts', hash: '', bytes: 0, approxTokens: 0, excluded: true })
    const r = blameContext(archive, '/r/focus.ts')
    expect(r.totalEvents).toBe(3)
    expect(r.excludedEvents).toBe(1)
    expect(r.versions.map((v) => v.hash)).toEqual(['v1', 'v2'])
    expect(r.versions[0].gitBlobSha1).toBe('g1')
    expect(r.coContext.some((c) => c.path === '/r/other.ts')).toBe(true)
    const text = renderBlame(r)
    expect(text).toContain('2 version(s)')
    expect(text).toContain('excluded/secret-pattern')
    expect(text).toContain('/r/other.ts')
  })

  it('reports an empty history honestly', () => {
    const archive = new Archive(join(work, 'archive'), 'w')
    expect(renderBlame(blameContext(archive, '/never/seen.ts'))).toContain('no recorded events')
  })
})
