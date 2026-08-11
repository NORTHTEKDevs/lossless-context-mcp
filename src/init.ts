// One-command install: `lossless-context-mcp init` wires every flight-recorder hook into
// ~/.claude/settings.json so nobody has to hand-edit JSON to feel the product work.
//
// The form-factor lesson this exists for: automatic, hook-driven tools get adopted;
// tools requiring settings surgery do not. Idempotent (re-running updates paths instead
// of duplicating entries), fail-closed on unparseable settings (NEVER clobber a file we
// couldn't read), and always writes a timestamped backup before changing anything.
//
// Hook entries merge across settings scopes in Claude Code, so installing at user level
// is additive to any project-level hooks.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface HookCommand {
  type: 'command'
  command: string
  timeout?: number
}
interface HookEntry {
  matcher?: string
  hooks: HookCommand[]
}
type HooksConfig = Record<string, HookEntry[]>

/** The hook wiring this package needs, given its installed root. */
export function desiredHooks(pkgRoot: string): { event: string; matcher?: string; script: string; timeout: number }[] {
  const p = (name: string) => join(pkgRoot, 'hooks', name).replace(/\\/g, '/')
  return [
    { event: 'PreCompact', script: p('sweep-transcript.mjs'), timeout: 60 },
    { event: 'SessionEnd', script: p('sweep-transcript.mjs'), timeout: 60 },
    { event: 'SessionStart', matcher: 'compact', script: p('inject-manifest.mjs'), timeout: 15 },
    { event: 'SessionStart', script: p('reset-epoch.mjs'), timeout: 15 },
    { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit', script: p('guard-edit.mjs'), timeout: 20 },
  ]
}

const OURS = /lossless-context-mcp[\\/]hooks[\\/](sweep-transcript|inject-manifest|reset-epoch|guard-edit)\.mjs/

/** Pure merge: returns the new hooks config + a change list. Never removes non-ours entries. */
export function mergeHooks(
  existing: HooksConfig | undefined,
  pkgRoot: string,
): { hooks: HooksConfig; changes: string[] } {
  const hooks: HooksConfig = JSON.parse(JSON.stringify(existing ?? {}))
  // Fail closed with a FRIENDLY message on hand-edited shapes we don't understand —
  // valid JSON is not enough; the nested structure must be what Claude Code expects.
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries))
      throw new Error(`refusing to modify settings: hooks.${event} is not an array. Fix or remove it and re-run init.`)
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || !Array.isArray((entry as HookEntry).hooks))
        throw new Error(`refusing to modify settings: an entry under hooks.${event} has no hooks[] array. Fix or remove it and re-run init.`)
    }
  }
  const changes: string[] = []
  // Drop every entry that points at our hook scripts (stale paths from old installs),
  // then re-add the current set. Entries mixing our script with others in one hooks[]
  // array keep the others.
  for (const event of Object.keys(hooks)) {
    for (const entry of hooks[event]) {
      const before = entry.hooks.length
      entry.hooks = entry.hooks.filter((h) => !(h.type === 'command' && OURS.test(h.command)))
      if (entry.hooks.length !== before) changes.push(`updated: removed stale lossless-context hook(s) under ${event}`)
    }
    hooks[event] = hooks[event].filter((e) => e.hooks.length > 0)
    if (hooks[event].length === 0) delete hooks[event]
  }
  for (const want of desiredHooks(pkgRoot)) {
    const cmd: HookCommand = { type: 'command', command: `node "${want.script}"`, timeout: want.timeout }
    const list = (hooks[want.event] ??= [])
    // Bucket by literal matcher equality only. A semantically identical matcher written
    // differently (e.g. "Write|Edit") gets its own entry — harmless, both still run.
    let entry = list.find((e) => (e.matcher ?? '') === (want.matcher ?? ''))
    if (!entry) {
      entry = want.matcher ? { matcher: want.matcher, hooks: [] } : { hooks: [] }
      list.push(entry)
    }
    entry.hooks.push(cmd)
    changes.push(`wired: ${want.event}${want.matcher ? `(${want.matcher})` : ''} -> ${want.script.split('/').pop()}`)
  }
  return { hooks, changes }
}

export interface InitResult {
  settingsPath: string
  backupPath?: string
  changes: string[]
  wroteFile: boolean
}

export function runInit(opts: { settingsPath?: string; pkgRoot?: string; dryRun?: boolean } = {}): InitResult {
  const settingsPath = opts.settingsPath ?? join(homedir(), '.claude', 'settings.json')
  // dist/init.js lives at <pkgRoot>/dist/init.js.
  const pkgRoot = opts.pkgRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..')

  for (const h of desiredHooks(pkgRoot)) {
    if (!existsSync(h.script)) throw new Error(`hook script missing: ${h.script} (is the package built/installed correctly?)`)
  }

  let settings: Record<string, unknown> = {}
  let backupPath: string | undefined
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8')
    try {
      settings = JSON.parse(raw) as Record<string, unknown>
    } catch (e) {
      // Fail closed: a settings file we can't parse is a settings file we don't touch.
      throw new Error(`refusing to modify ${settingsPath}: it is not valid JSON (${(e as Error).message}). Fix it and re-run init.`)
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings))
      throw new Error(`refusing to modify ${settingsPath}: top level is not an object.`)
  }

  const { hooks, changes } = mergeHooks(settings.hooks as HooksConfig | undefined, pkgRoot)
  settings.hooks = hooks

  if (!opts.dryRun) {
    mkdirSync(dirname(settingsPath), { recursive: true })
    if (existsSync(settingsPath)) {
      backupPath = `${settingsPath}.lossless-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(settingsPath, backupPath)
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  }
  return { settingsPath, backupPath, changes, wroteFile: !opts.dryRun }
}

export function renderInitResult(r: InitResult): string {
  return (
    `[lossless-context] init ${r.wroteFile ? 'complete' : '(dry run)'} — ${r.settingsPath}\n` +
    r.changes.map((c) => `  ${c}`).join('\n') +
    (r.backupPath ? `\n  backup: ${r.backupPath}` : '') +
    `\n\nHooks wired: transcript sweep (PreCompact/SessionEnd), manifest inject ` +
    `(post-compaction), epoch reset, blind-edit guard (set LOSSLESS_GUARD=off to disable).\n` +
    `If the MCP server itself is not registered yet, run:\n` +
    `  claude mcp add lossless-context --scope user -- lossless-context-mcp\n` +
    `Restart Claude Code to pick up the hooks.`
  )
}
