// Heuristic structural outline: returns the declaration lines (functions, classes, types,
// methods, exports) with their line numbers, eliding bodies, so the model can navigate a
// large file cheaply before reading specific parts. Language-agnostic regex (v1); precise
// tree-sitter symbol extraction is planned for v1.1.

const DECL =
  /^\s*(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|static\s+|async\s+)*(function|class|interface|type|enum|struct|trait|impl|module|namespace|def|fn|func|val|var|let|const)\b/

// Arrow-function / method assignment: `const handler = (...) =>`, `foo(...) {`
const ARROW = /^\s*(export\s+)?(public\s+|private\s+|protected\s+|static\s+)*[A-Za-z_$][\w$]*\s*[:=]\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
const METHOD = /^\s*(public\s+|private\s+|protected\s+|static\s+|async\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(:\s*[\w<>\[\].,\s|&]+)?\s*\{/

export interface OutlineLine {
  line: number
  text: string
}

export function outlineOf(content: string): { totalLines: number; decls: OutlineLine[] } {
  const lines = content.split('\n')
  const decls: OutlineLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim().length === 0) continue
    if (DECL.test(t) || ARROW.test(t) || METHOD.test(t)) {
      decls.push({ line: i + 1, text: t.replace(/\s+$/, '').slice(0, 200) })
    }
  }
  return { totalLines: lines.length, decls }
}

export function renderOutline(path: string, o: { totalLines: number; decls: OutlineLine[] }): string {
  const head = `[lossless-context] outline of ${path} (${o.totalLines} lines, ${o.decls.length} declarations; bodies elided — call read_file for full content):`
  const body = o.decls.map((d) => `${String(d.line).padStart(5)}: ${d.text}`).join('\n')
  return o.decls.length ? `${head}\n${body}` : `${head}\n(no top-level declarations detected)`
}
