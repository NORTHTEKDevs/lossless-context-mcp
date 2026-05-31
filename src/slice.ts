// Parser-free slicing: line ranges + heuristic symbol extraction (brace-matching for
// C-family, indentation for Python-family). Deterministic, cross-platform, no native/WASM
// deps. Precise tree-sitter symbol extraction is a planned upgrade; this is the reliable
// baseline and the permanent fallback for languages without a grammar.

import { extname } from 'node:path'

export interface Slice {
  text: string
  start: number // 1-based first line
  end: number // 1-based last line (inclusive)
}

/** True if the bytes look binary / non-UTF-8 text (NUL byte, or many control chars). */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  if (n === 0) return false
  let ctrl = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) ctrl++
  }
  return ctrl / n > 0.3
}

export function sliceLines(content: string, start: number, end: number): Slice {
  const lines = content.split('\n')
  const s = Math.max(1, Math.min(start, lines.length))
  const e = Math.max(s, Math.min(end, lines.length))
  return { text: lines.slice(s - 1, e).join('\n'), start: s, end: e }
}

type Family = 'brace' | 'indent'
const INDENT_EXT = new Set(['.py', '.pyi', '.pyw', '.rb', '.coffee'])
function familyFor(path: string): Family {
  return INDENT_EXT.has(extname(path).toLowerCase()) ? 'indent' : 'brace'
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/)
  return m ? m[0].replace(/\t/g, '    ').length : 0
}

/** Find a declaration of `name` and return its line range. null if not found. */
export function findSymbol(content: string, name: string, path: string): Slice | null {
  const lines = content.split('\n')
  const nm = escapeRe(name)
  const declRe = new RegExp(
    `(^|[^\\w$])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+)*` +
      `(?:function|class|interface|type|enum|struct|trait|impl|module|namespace|def|fn|func|const|let|var)\\s+${nm}\\b`,
  )
  const assignRe = new RegExp(`(^|[^\\w$])${nm}\\s*[:=]\\s*(async\\s*)?(\\([^)]*\\)|[\\w$]+)\\s*=>`) // arrow
  const methodRe = new RegExp(`(^|[^\\w$])${nm}\\s*(<[^>]*>)?\\s*\\([^)]*\\)\\s*(:[^={]+)?\\{`) // method/func with body

  let declLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(lines[i]) || assignRe.test(lines[i]) || methodRe.test(lines[i])) {
      declLine = i
      break
    }
  }
  if (declLine < 0) return null

  return familyFor(path) === 'indent' ? indentRange(lines, declLine) : braceRange(lines, declLine)
}

function braceRange(lines: string[], declLine: number): Slice {
  // Scan forward for the first '{' starting at the declaration; if found, brace-match to
  // its close. If no '{' appears soon (one-liner type/arrow), capture to the first ';' or
  // a blank line.
  let i = declLine
  let openIdx = -1
  for (; i < lines.length && i < declLine + 8; i++) {
    if (lines[i].includes('{')) { openIdx = i; break }
    if (/;\s*$/.test(lines[i])) return { text: lines.slice(declLine, i + 1).join('\n'), start: declLine + 1, end: i + 1 }
  }
  if (openIdx < 0) {
    // no body brace nearby: capture the declaration line plus any continuation until blank
    let e = declLine
    while (e + 1 < lines.length && lines[e + 1].trim() !== '' && !/[;}]\s*$/.test(lines[e])) e++
    return { text: lines.slice(declLine, e + 1).join('\n'), start: declLine + 1, end: e + 1 }
  }
  let depth = 0
  let started = false
  for (let j = openIdx; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth++; started = true }
      else if (ch === '}') depth--
    }
    if (started && depth <= 0) return { text: lines.slice(declLine, j + 1).join('\n'), start: declLine + 1, end: j + 1 }
  }
  return { text: lines.slice(declLine).join('\n'), start: declLine + 1, end: lines.length } // unbalanced: to EOF
}

function indentRange(lines: string[], declLine: number): Slice {
  const base = indentOf(lines[declLine])
  let e = declLine
  for (let j = declLine + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') { e = j; continue } // blank lines belong to the block
    if (indentOf(lines[j]) <= base) break // dedent to base or less ends the block
    e = j
  }
  // trim trailing blank lines from the slice
  while (e > declLine && lines[e].trim() === '') e--
  return { text: lines.slice(declLine, e + 1).join('\n'), start: declLine + 1, end: e + 1 }
}
