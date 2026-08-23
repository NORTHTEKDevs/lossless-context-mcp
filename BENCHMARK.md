# The context-efficiency benchmark

A reproducible methodology for measuring what any "send less context" tool actually saves — and
whether it stays truthful while doing it. Published so results in this space can be compared
instead of asserted, **including this project's own unflattering number**.

## Two metrics, both mandatory

1. **Savings** — `1 − (sent tokens / baseline tokens)`, where *baseline* is the full resolved
   content on every read and *sent* is what the tool actually emitted. Tokens are counted with a
   real tokenizer (`gpt-tokenizer`, o200k). Ratios are tokenizer-agnostic in practice; absolute
   counts vary slightly by vendor.
2. **Losslessness** — after every single operation, reconstruct the view the model would hold
   (apply diffs to priors, reuse on markers) and compare byte-for-byte against the true file.
   **One divergence = fail.** A savings number without a reconstruction proof is a marketing
   number.

## Workloads

| Workload | What it models | Command | Result (v1.1) |
|---|---|---|---|
| **edit-loop** (synthetic ceiling) | pathological re-read/edit cycling: the same files re-read dozens of times in one context | `npm run bench` | **72.1%** saved, lossless (46 reads: 12 full / 18 diff / 16 unchanged) |
| **read-once** (synthetic floor) | every file touched exactly once | `npm run bench` | **0.0%** saved, lossless — correct: first-contact reads must never be reduced |
| **real-session replay** (the honest one) | your actual agent history: every native `Read` result from Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) replayed through the engine in order, one epoch per transcript (an upper bound — intra-session compaction is not modeled) | `npx tsx bench/real-session.ts` (add `--real` for the real tokenizer) | **−1.4%** over 1,839 transcripts / 16,823 reads / 64 MB: only 7–8% of reads are re-reads, the median session re-reads 0% of its files, and a unified diff can exceed the file it patches |

The three numbers together are the honest claim: a 72% ceiling exists, the floor is zero, and
typical Claude Code sessions sit at the floor because the harness's native file-state cache
already eliminated redundant re-reads. Any context tool that quotes only its ceiling is quoting
the wrong number.

**Re-measured 2026-08-06** on the same machine's grown corpus (3,363 transcripts / 26,041
reads / 116 MB, real tokenizer): **−2.6%**, losslessness clean. The re-read rate had risen to
17.4%, but most re-reads arrive *changed*, and a unified diff regularly exceeds the content it
patches. A marker-only dedup tool graded through this same harness on the same corpus (no diff
path, marker on unchanged, full content on change) measured **−0.2%** — and the theoretical
maximum for *any* naive intra-session read-dedup tool on this corpus, computed with a
zero-cost marker, is about **0.2%**: the average unchanged re-read is roughly 29 tokens of
content, because the harness's native cache already suppresses the big ones. The niche is not
badly-served; it is already served.

**v1.2 (the never-lose engine), same corpus, same day: +0.4%** (105,386 tokens saved),
losslessness clean. The engine now emits whichever is smaller — marker vs content, diff vs
content — so it is structurally unable to cost more than native reads. The filter is brutal
and honest: of 2,142 unchanged re-reads only 11 were big enough for a marker to pay, and of
2,388 changed re-reads only 133 produced a diff smaller than the file. Nearly all the savings
come from those 133: large files re-read after a small edit, where a short diff replaces tens
of thousands of tokens. That is the one real dedup win left in modern Claude Code sessions,
and the engine now takes exactly it, and nothing else.

## Why replay-based evaluation

Real-session replay grades a tool against *what agents actually do*, not what a demo script does.
It is also vendor-neutral: the transcript format is just an ordered sequence of
`(path, content-at-read-time)` pairs. As harnesses improve natively (caching, file-state
reminders), replaying fresh transcripts shows exactly how much opportunity remains — this
project's own reality check is that measurement, published rather than buried.

## Evaluating another tool with the same harness

The contract is small. Given an ordered sequence of reads `(path, view, content)`:

1. The tool emits what it would send the model for each read (full text, marker, diff, slice,
   summary — anything).
2. The harness reconstructs the model's view from only what was emitted and prior emissions in
   the same epoch, and compares to truth after every read. Divergence = fail; for lossy tools
   (summaries), report the divergence rate honestly instead of failing silently.
3. Report `baseline`, `sent`, savings %, and the losslessness verdict, per workload.

`bench/run.ts` (scripted workloads) and `bench/real-session.ts` (transcript replay) are both
< 120 lines and MIT — fork the adapter, swap the engine call for your tool, publish the table.

## Cross-agent numbers (packs) — measured externally, not yet reproducible from this repo

The fan-out numbers quoted in the README come from a separate research program run against
one user's real Claude Code corpus, **not** from a harness shipped in `bench/`. Stated
precisely so they can be believed at the right strength:

- **19.6% cross-agent read overlap** — 5,183,174 of 26,444,119 subagent `Read` tokens across
  195 real multi-agent runs (3,148 subagent transcripts) were reads of *identical content*
  (grouped by `path + content-hash`) already read by a sibling agent in the same run.
  Same-agent re-reads were excluded. Token counting: chars/4, applied uniformly.
- **46.55% cheaper** — one real review fan-out, run twice (baseline vs. a context pack
  embedded in the reviewer agent-type's system prompt): 131,762.8 vs 246,498.1
  billed-equivalent tokens under Anthropic's prompt-cache pricing. The SAME pack injected
  per-task (user turn, not system prompt) measured 19.6% *worse* than baseline, because
  every sibling cache-writes it instead of cache-reading it.
- These are honest single-corpus / single-workload measurements: one user's fan-out habits,
  one provider's cache pricing. Your overlap depends on how your orchestration re-reads
  reference files; measure before betting on the number. A replayable public harness for
  the overlap metric is the natural next addition here — until it ships, treat these as
  externally measured, directionally strong, not independently reproducible.

`bench/sweep-bench.mjs` (in this repo) measures sweep/manifest performance against any real
transcript you point it at: `node bench/sweep-bench.mjs <transcript.jsonl>`.

## The invariant behind the numbers

`npm test` includes a 400-operation randomized sequence (read / edit / re-read / compact) that
asserts reconstruction equals truth after **every** op, plus receipt tamper-rejection tests for
the evidence layer. CI runs build + tests + benchmark + over-the-wire smoke on every commit.
