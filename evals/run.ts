import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { estimateCostUsd, MODELS, type ModelKey, parseMessage, type Usage } from '../src/parse'
import type { Command } from '../src/parse/schema'
import { type EvalCase, type Grade, grade, type SoftCounts } from './grade'
import { mean, percentile } from './stats'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

type CaseResult = {
  id: string
  split: string
  text: string
  expected: Command
  actual: Command | null
  issues: unknown[]
  usage: Usage | null
  latencyMs: number | null
  error: string | null
  grade: Grade
}

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'haiku' },
    split: { type: 'string', default: 'dev' },
    concurrency: { type: 'string', default: '4' },
    // Stops sending requests once the estimated cost of this run passes the cap (US$).
    budget: { type: 'string', default: '1' },
    limit: { type: 'string' },
  },
})

const modelKey = values.model as ModelKey
if (!(modelKey in MODELS)) throw new Error('--model must be haiku or sonnet')
const split = values.split as 'dev' | 'test' | 'all'
if (!['dev', 'test', 'all'].includes(split)) throw new Error('--split must be dev, test or all')
const concurrency = Number(values.concurrency)
const budget = Number(values.budget)
const flagErrors = [
  Number.isInteger(concurrency) && concurrency > 0
    ? ''
    : '--concurrency must be an integer above 0',
  Number.isFinite(budget) && budget > 0 ? '' : '--budget must be a number above 0',
  !values.limit || (Number.isInteger(Number(values.limit)) && Number(values.limit) > 0)
    ? ''
    : '--limit must be an integer above 0',
].filter(Boolean)
if (flagErrors.length > 0) {
  console.error(flagErrors.join('\n'))
  process.exit(1)
}

// The key lives only in .env; it is read into the environment and never printed.
try {
  process.loadEnvFile(join(root, '.env'))
} catch {}
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is missing: set it in .env')

let cases = readFileSync(join(root, 'evals/cases.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as EvalCase)
if (split !== 'all') cases = cases.filter((c) => c.split === split)
if (values.limit) cases = cases.slice(0, Number(values.limit))

const emptyGrade = (reason: string): Grade => ({
  full: false,
  typeOk: false,
  silentWrongAmount: false,
  silentWrongTarget: false,
  soft: {},
  reasons: [reason],
})

let spent = 0

async function runCase(testCase: EvalCase): Promise<CaseResult> {
  const base = {
    id: testCase.id,
    split: testCase.split,
    text: testCase.text,
    expected: testCase.expected,
  }
  if (spent >= budget) {
    return {
      ...base,
      actual: null,
      issues: [],
      usage: null,
      latencyMs: null,
      error: 'budget reached',
      grade: emptyGrade('budget reached'),
    }
  }
  try {
    const result = await parseMessage({
      text: testCase.text,
      today: testCase.today,
      recentMovements: testCase.recent,
      previous: testCase.previous,
      model: modelKey,
    })
    spent += estimateCostUsd(modelKey, result.usage)
    return {
      ...base,
      actual: result.command,
      issues: result.issues,
      usage: result.usage,
      latencyMs: result.latencyMs,
      error: null,
      grade: grade(testCase, result.command),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error)
    return {
      ...base,
      actual: null,
      issues: [],
      usage: null,
      latencyMs: null,
      error: message,
      grade: emptyGrade(`error: ${message}`),
    }
  }
}

async function runAll(): Promise<CaseResult[]> {
  const results: CaseResult[] = []
  const [first, ...rest] = cases
  if (!first) return results
  // The first request alone writes the prompt cache; the rest can then read it.
  results.push(await runCase(first))
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < rest.length) {
        const item = rest[next++]
        if (item) results.push(await runCase(item))
      }
    }),
  )
  return results.sort((a, b) => a.id.localeCompare(b.id))
}

const startedAt = new Date()
const results = await runAll()

const fullyCorrect = results.filter((r) => r.grade.full).length
const ok = results.filter((r) => r.error === null)
const latencies = ok.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]))
const usages = ok.flatMap((r) => (r.usage ? [r.usage] : []))
const soft: SoftCounts = {}
for (const r of results) {
  for (const [name, c] of Object.entries(r.grade.soft)) {
    const entry = soft[name] ?? { ok: 0, total: 0 }
    entry.ok += c.ok
    entry.total += c.total
    soft[name] = entry
  }
}
const cost = usages.reduce((sum, u) => sum + estimateCostUsd(modelKey, u), 0)
const summary = {
  model: MODELS[modelKey].id,
  split,
  cases: results.length,
  errors: results.length - ok.length,
  fullyCorrect,
  accuracy: results.length === 0 ? 0 : fullyCorrect / results.length,
  typeAccuracy:
    results.length === 0 ? 0 : results.filter((r) => r.grade.typeOk).length / results.length,
  silentWrongAmounts: results.filter((r) => r.grade.silentWrongAmount).length,
  silentWrongTargets: results.filter((r) => r.grade.silentWrongTarget).length,
  soft: Object.fromEntries(
    Object.entries(soft).map(([name, c]) => [
      name,
      { ...c, rate: c.total === 0 ? 0 : c.ok / c.total },
    ]),
  ),
  latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  meanInputTokens: mean(usages.map((u) => u.inputTokens)),
  meanOutputTokens: mean(usages.map((u) => u.outputTokens)),
  meanCacheReadTokens: mean(usages.map((u) => u.cacheReadTokens)),
  meanCacheWriteTokens: mean(usages.map((u) => u.cacheWriteTokens)),
  estimatedCostUsd: cost,
  gate: {
    accuracyAtLeast97:
      results.length > 0 && results.filter((r) => r.grade.full).length / results.length >= 0.97,
    noSilentWrongAmounts: results.every((r) => !r.grade.silentWrongAmount),
    noSilentWrongTargets: results.every((r) => !r.grade.silentWrongTarget),
  },
}

const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
mkdirSync(join(root, 'evals/results'), { recursive: true })
writeFileSync(
  join(root, `evals/results/${stamp}-${modelKey}-${split}.json`),
  // Held-out cases leave no inputs, expected or actual commands behind: aggregates only.
  JSON.stringify(
    { startedAt, summary, results: results.filter((r) => r.split === 'dev') },
    null,
    2,
  ),
)
appendFileSync(
  join(root, 'evals/results/spend.jsonl'),
  `${JSON.stringify({ at: startedAt, model: modelKey, split, cases: results.length, costUsd: cost })}\n`,
)

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ms = (x: number) => `${Math.round(x)} ms`
console.log(`\nWarren parser eval: ${summary.model}, split ${split}, ${results.length} cases`)
console.table({
  'fully correct': `${summary.fullyCorrect}/${results.length} (${pct(summary.accuracy)})`,
  'command type': pct(summary.typeAccuracy),
  'silently wrong amounts': summary.silentWrongAmounts,
  'silently wrong targets': summary.silentWrongTargets,
  errors: summary.errors,
  'latency p50': ms(summary.latencyMs.p50),
  'latency p95': ms(summary.latencyMs.p95),
  'mean input tokens (uncached)': Math.round(summary.meanInputTokens),
  'mean output tokens': Math.round(summary.meanOutputTokens),
  'mean cache read tokens': Math.round(summary.meanCacheReadTokens),
  'mean cache write tokens': Math.round(summary.meanCacheWriteTokens),
  'estimated cost (US$)': cost.toFixed(4),
})
console.table(
  Object.fromEntries(
    Object.entries(summary.soft).map(([name, c]) => [name, `${c.ok}/${c.total} (${pct(c.rate)})`]),
  ),
)
const gatePassed =
  summary.gate.accuracyAtLeast97 &&
  summary.gate.noSilentWrongAmounts &&
  summary.gate.noSilentWrongTargets
console.log(
  `Gate (>=97% fully correct, 0 silent wrong amounts, 0 silent wrong targets): ${gatePassed ? 'PASS' : 'FAIL'}`,
)
if (!gatePassed) process.exitCode = 1

// Held-out cases are never listed while tuning; their details stay in the results file only.
const failures = results.filter((r) => !r.grade.full && r.split === 'dev')
if (failures.length > 0) {
  console.log(`\nDev failures (${failures.length}):`)
  for (const f of failures) {
    console.log(`- ${f.id} "${f.text}"\n    ${f.grade.reasons.join('; ')}`)
  }
}
if (split !== 'dev') {
  console.log('\nTest-split failures are not printed (held out).')
}
