// Sweep performance bench: run the transcript sweep against a REAL transcript and report
// wall time, lines, and capture counts. Writes to an isolated temp archive, never the
// real one. Usage: node bench/sweep-bench.mjs <transcript.jsonl>
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archive } from '../dist/archive.js'
import { sweepTranscript } from '../dist/sweep.js'

const transcript = process.argv[2]
if (!transcript) {
  console.error('usage: node bench/sweep-bench.mjs <transcript.jsonl>')
  process.exit(1)
}
const bytes = statSync(transcript).size
const tmp = mkdtempSync(join(tmpdir(), 'lcm-sweep-bench-'))
try {
  const archive = new Archive(join(tmp, 'archive'), 'bench')
  const t0 = performance.now()
  const { stats, workingSet } = await sweepTranscript(transcript, archive, { session: 'bench' })
  const ms = performance.now() - t0
  console.log(`transcript: ${(bytes / 1e6).toFixed(1)} MB, ${stats.lines} lines`)
  console.log(`sweep wall time: ${ms.toFixed(0)} ms`)
  console.log(
    `captured: ${workingSet.length} working-set file(s), ${stats.exactVersions} exact + ` +
      `${stats.diskVersions} disk version(s), ${stats.skipped} skipped`,
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
