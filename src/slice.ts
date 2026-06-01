// Parser-free slicing: line ranges + heuristic symbol extraction. Brace-matching (C-family)
// runs over a MASKED copy of the source where string and comment contents are blanked, so
// braces inside string/comment literals no longer corrupt the range. Indentation matching
// (Python-family) runs over a hash-comment-masked copy. Deterministic, cross-platform, no
// native/WASM deps. Precise tree-sitter extraction is a tracked upgrade; this is the reliable
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
const INDENT_EXT = new Set(['.py', '.pyi', '.pyw', '.coffee'])
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

// Blank string/comment contents (preserving newlines and length) so structural scanning sees
// only real code punctuation. C-family: // /* */ and ' " ` strings (with escapes).
function maskBrace(s: string): string {
  let out = ''
  let i = 0
  const n = s.length
  let mode: 'n' | 'l' | 'b' | 's' = 'n'
  let quote = ''
  while (i < n) {
    const c = s[i]
    const d = i + 1 < n ? s[i + 1] : ''
    if (mode === 'n') {
      if (c === '/' && d === '/') { out += '  '; i += 2; mode = 'l'; continue }
      if (c === '/' && d === '*') { out += '  '; i += 2; mode = 'b'; continue }
      if (c === '"' || c === "'" || c === '`') { out += c; quote = c; mode = 's'; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'l') { out += c === '\n' ? '\n' : ' '; if (c === '\n') mode = 'n'; i++; continue }
    if (mode === 'b') {
      if (c === '*' && d === '/') { out += '  '; i += 2; mode = 'n'; continue }
      out += c === '\n' ? '\n' : ' '; i++; continue
    }
    // string
    if (c === '\\') { out += '  '; i += 2; continue }
    if (c === quote) { out += c; mode = 'n'; i++; continue }
    out += c === '\n' ? '\n' : ' '; i++; continue
  }
  return out
}

// Python-family: blank '#' line comments outside of strings (enough to keep declaration search
// honest; indentation matching does not depend on braces).
function maskHash(s: string): string {
  let out = ''
  let mode: 'n' | 's' = 'n'
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (mode === 'n') {
      if (c === '#') { while (i < s.length && s[i] !== '\n') i++; out += (s[i] === '\n' ? '\n' : ''); continue }
      if (c === '"' || c === "'") { quote = c; mode = 's'; out += c; continue }
      out += c
    } else {
      if (c === '\\') { out += '  '; i++; continue }
      if (c === quote) { mode = 'n'; out += c; continue }
      out += c === '\n' ? '\n' : ' '
    }
  }
  return out
}

function maskCode(content: string, path: string): string {
  return familyFor(path) === 'indent' ? maskHash(content) : maskBrace(content)
}

/** Find a declaration of `name` and return its line range from the ORIGINAL source.
 *  Declaration search and structural matching run over a masked copy. null if not found. */
export function findSymbol(content: string, name: string, path: string): Slice | null {
  const lines = content.split('\n')
  const masked = maskCode(content, path).split('\n')
  const nm = escapeRe(name)
  const declRe = new RegExp(
    `(^|[^\\w$])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+)*` +
      `(?:function|class|interface|type|enum|struct|trait|impl|module|namespace|def|fn|func|const|let|var)\\s+${nm}\\b`,
  )
  const assignRe = new RegExp(`(^|[^\\w$])${nm}\\s*[:=]\\s*(async\\s*)?(\\([^)]*\\)|[\\w$]+)\\s*=>`)
  const methodRe = new RegExp(`(^|[^\\w$])${nm}\\s*(<[^>]*>)?\\s*\\([^)]*\\)\\s*(:[^={]+)?\\{`)

  let declLine = -1
  for (let i = 0; i < masked.length; i++) {
    if (declRe.test(masked[i]) || assignRe.test(masked[i]) || methodRe.test(masked[i])) { declLine = i; break }
  }
  if (declLine < 0) return null

  const [start, end] = familyFor(path) === 'indent' ? indentSpan(masked, declLine) : braceSpan(masked, declLine)
  return { text: lines.slice(start - 1, end).join('\n'), start, end }
}

// Returns [start1, end1] (1-based inclusive) over masked lines.
function braceSpan(masked: string[], declLine: number): [number, number] {
  let openIdx = -1
  for (let i = declLine; i < masked.length && i < declLine + 8; i++) {
    if (masked[i].includes('{')) { openIdx = i; break }
    if (/;\s*$/.test(masked[i])) return [declLine + 1, i + 1]
  }
  if (openIdx < 0) {
    // No body brace: a single-line declaration (const/let/type/...). Extend ONLY across explicit
    // continuations (unbalanced parens/brackets or a trailing continuation operator) so a
    // terminator-less statement doesn't run away to EOF. Hard cap as a backstop.
    let e = declLine
    while (e + 1 < masked.length && e < declLine + 40 && continuesLine(masked[e])) e++
    return [declLine + 1, e + 1]
  }
  let depth = 0
  let started = false
  for (let j = openIdx; j < masked.length; j++) {
    for (const ch of masked[j]) {
      if (ch === '{') { depth++; started = true }
      else if (ch === '}') depth--
    }
    if (started && depth <= 0) return [declLine + 1, j + 1]
  }
  return [declLine + 1, masked.length]
}

// True if a brace-less declaration line clearly continues onto the next (unbalanced
// parens/brackets or a trailing continuation operator).
function continuesLine(line: string): boolean {
  let paren = 0
  let bracket = 0
  for (const ch of line) {
    if (ch === '(') paren++
    else if (ch === ')') paren--
    else if (ch === '[') bracket++
    else if (ch === ']') bracket--
  }
  if (paren > 0 || bracket > 0) return true
  return /[=,([{|&+\-.<]\s*$/.test(line)
}

function indentSpan(masked: string[], declLine: number): [number, number] {
  const base = indentOf(masked[declLine])
  let e = declLine
  for (let j = declLine + 1; j < masked.length; j++) {
    if (masked[j].trim() === '') { e = j; continue }
    if (indentOf(masked[j]) <= base) break
    e = j
  }
  while (e > declLine && masked[e].trim() === '') e--
  return [declLine + 1, e + 1]
}
