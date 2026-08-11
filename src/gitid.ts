// Git identity without spawning git: blob SHA-1 computation and HEAD resolution.
//
// Receipts bind file content to git identity two ways: `gitBlobSha1` lets any verifier
// with a clone check `git cat-file -e <sha1>` to see whether an attested version was ever
// committed, and `gitHead` records where the repo stood when the receipt was issued.
// Everything here reads .git files directly (HEAD, loose refs, packed-refs, worktree
// redirections) — no subprocess, so it works in restricted environments and costs
// microseconds. Failure of any step degrades to "unknown", never to an exception.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** SHA-1 of the git blob object for `content` — identical to `git hash-object` on it. */
export function gitBlobSha1(content: string): string {
  const body = Buffer.from(content, 'utf8')
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8')
  return createHash('sha1').update(header).update(body).digest('hex')
}

export interface GitHead {
  branch?: string
  sha?: string
}

/** The real .git directory for a repo root; handles worktrees where .git is a FILE. */
function gitDirOf(repoRoot: string): string | null {
  const dotGit = join(repoRoot, '.git')
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return dotGit
    const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)
    if (m) return isAbsolute(m[1]) ? m[1] : join(repoRoot, m[1])
  } catch {}
  return null
}

/** The directory holding shared refs (differs from gitDir inside a linked worktree). */
function commonDirOf(gitDir: string): string {
  try {
    const f = join(gitDir, 'commondir')
    if (existsSync(f)) {
      const cd = readFileSync(f, 'utf8').trim()
      return isAbsolute(cd) ? cd : join(gitDir, cd)
    }
  } catch {}
  return gitDir
}

/** Current HEAD (branch + commit sha) of the repo at `repoRoot`, best-effort. */
export function readGitHead(repoRoot: string): GitHead {
  const gitDir = gitDirOf(repoRoot)
  if (!gitDir) return {}
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = head.match(/^ref:\s*(.+)$/)
    if (!ref) return /^[0-9a-f]{40}/.test(head) ? { sha: head.slice(0, 40) } : {}
    const refPath = ref[1].trim()
    const branch = refPath.replace(/^refs\/heads\//, '')
    const common = commonDirOf(gitDir)
    for (const base of [gitDir, common]) {
      const loose = join(base, ...refPath.split('/'))
      if (existsSync(loose)) {
        const sha = readFileSync(loose, 'utf8').trim().slice(0, 40)
        if (/^[0-9a-f]{40}$/.test(sha)) return { branch, sha }
      }
    }
    const packed = join(common, 'packed-refs')
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        if (line.slice(41).trim() === refPath && /^[0-9a-f]{40}$/.test(line.slice(0, 40))) {
          return { branch, sha: line.slice(0, 40) }
        }
      }
    }
    return { branch }
  } catch {
    return {}
  }
}
