import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TAGS } from '../scenarios/schema'
import { percentile } from '../stats'

/**
 * Compares the newest `--split all` runs of the loop and of eve: pass counts, silent changes, invented
 * numbers, per-turn latency and cost. `pnpm tsx evals/eve/compare.ts [runs]` reads the result files.
 * The held-out test split keeps only status and counts in those files, so it appears as counts.
 */
const here = dirname(fileURLToPath(import.meta.url))
const runs = Number(process.argv[2] ?? 2)

interface Turn {
  wallMs: number
  costUsd: number
  grade: { silentWrong: boolean; invented: string[] }
}
interface Result {
  id: string
  split: 'dev' | 'test'
  tags: string[]
  status: string
  turns: Turn[]
}
interface File {
  summary: {
    passed: number
    scenarios: number
    silentWrongChanges: number
    inventedNumbers: number
    turns: number
    turnMs: { p50: number; p95: number }
    costUsd: number
  }
  latencyByTag: Record<string, { p50: number; p95: number; n: number }>
  results: Result[]
}

const newest = (dir: string): File[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('-all.json'))
    .sort()
    .slice(-runs)
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as File)

const loop = newest(join(here, '..', 'scenarios', 'results'))
const eve = newest(join(here, 'results'))

const original = (r: Result) => Number(r.id.slice(1)) <= 98
const count = (f: File, pick: (r: Result) => boolean) => {
  const rs = f.results.filter(pick)
  return `${rs.filter((r) => r.status === 'pass').length}/${rs.length}`
}
const ms = (n: number) => `${Math.round(n)}`

function row(name: string, files: File[]) {
  console.log(
    `| ${name} | ${files.map((f) => count(f, () => true)).join(', ')} | ${files
      .map((f) => count(f, original))
      .join(', ')} | ${files.map((f) => count(f, (r) => !original(r))).join(', ')} | ${files
      .map((f) => f.summary.silentWrongChanges)
      .join(', ')} | ${files.map((f) => f.summary.inventedNumbers).join(', ')} | ${files
      .map((f) => `${ms(f.summary.turnMs.p50)} / ${ms(f.summary.turnMs.p95)}`)
      .join(', ')} | ${files.map((f) => `$${f.summary.costUsd.toFixed(3)}`).join(', ')} |`,
  )
}

console.log('| | All 111 | Original 98 | New 13 | Silent | Invented | p50 / p95 ms | Cost |')
console.log('|---|---|---|---|---|---|---|---|')
row('Loop', loop)
row('eve', eve)

console.log(
  '\nPer tag (a scenario counts in each of its tags): passed/total, then p50 / p95 ms per turn.\n',
)
console.log('| Tag | Loop | eve | Loop p50 / p95 | eve p50 / p95 |')
console.log('|---|---|---|---|---|')
for (const tag of TAGS) {
  const cell = (files: File[]) =>
    files
      .map((f) => {
        const rs = f.results.filter((r) => r.tags.includes(tag))
        return `${rs.filter((r) => r.status === 'pass').length}/${rs.length}`
      })
      .join(', ')
  const lat = (files: File[]) =>
    files
      .map((f) => {
        const l = f.latencyByTag[tag]
        return l ? `${ms(l.p50)} / ${ms(l.p95)}` : '-'
      })
      .join(', ')
  console.log(`| ${tag} | ${cell(loop)} | ${cell(eve)} | ${lat(loop)} | ${lat(eve)} |`)
}

// Pooled latency over both runs, the number the adoption criterion reads.
const pooled = (files: File[]) => {
  const all = files.flatMap((f) => f.results.flatMap((r) => r.turns.map((t) => t.wallMs)))
  return { p50: percentile(all, 50), p95: percentile(all, 95), n: all.length }
}
const a = pooled(loop)
const b = pooled(eve)
console.log(
  `\nPooled over the dev turns of ${runs} runs (the held-out turns are not kept): loop p50 ${ms(a.p50)} p95 ${ms(a.p95)} (n ${a.n}); eve p50 ${ms(b.p50)} p95 ${ms(b.p95)} (n ${b.n}); delta p50 ${ms(b.p50 - a.p50)} ms, p95 ${ms(b.p95 - a.p95)} ms.`,
)
