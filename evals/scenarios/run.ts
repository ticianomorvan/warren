import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { MODELS, type ModelKey } from '../../src/agent'
import { keepAliveFetch } from '../../src/http'
import { createTestDatabase } from '../../src/test-harness'
import { Meter, runScenario, type ScenarioResult } from './drive'
import { failureLines, renderSummary, summarize } from './report'
import { loadScenarios } from './schema'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const { values } = parseArgs({
  options: {
    split: { type: 'string', default: 'dev' },
    concurrency: { type: 'string', default: '4' },
    // The run never starts a model call that could take its estimated cost past this (US$).
    budget: { type: 'string', default: '0.30' },
    // Run only these scenarios (comma-separated ids), whatever their split.
    only: { type: 'string' },
  },
})

const split = values.split as 'dev' | 'test' | 'all'
const concurrency = Number(values.concurrency)
const budget = Number(values.budget)
const errors = [
  ['dev', 'test', 'all'].includes(split) ? '' : '--split must be dev, test or all',
  Number.isInteger(concurrency) && concurrency > 0
    ? ''
    : '--concurrency must be an integer above 0',
  Number.isFinite(budget) && budget > 0 ? '' : '--budget must be a number above 0',
].filter(Boolean)
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}

// The key lives only in .env; it is read into the environment and never printed.
try {
  process.loadEnvFile(join(root, '.env'))
} catch {}
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is missing: set it in .env')

const only = values.only ? new Set(values.only.split(',').map((id) => id.trim())) : null
const scenarios = loadScenarios().filter((s) =>
  only ? only.has(s.id) : split === 'all' || s.split === split,
)
if (scenarios.length === 0) {
  console.error('no scenarios selected')
  process.exit(1)
}

// The pipeline logs one JSON line per event on stdout: keep them out of the report.
const printLog = console.log
console.log = () => {}

// The pipeline exactly as `src/server.ts` builds it: the agent on Haiku, the keep-alive client.
const model: ModelKey = 'haiku'
const client = new Anthropic({ fetch: keepAliveFetch() })
const meter = new Meter(budget)
const db = await createTestDatabase()
const startedAt = new Date()

async function runAll(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  const [first, ...rest] = scenarios
  if (!first) return results
  const play = async (s: (typeof scenarios)[number]) =>
    results.push(await runScenario(s, { sql: db.sql, client, meter, model }))
  // The first scenario alone writes the prompt cache; the rest read it.
  await play(first)
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < rest.length) {
        const s = rest[next++]
        if (s) await play(s)
      }
    }),
  )
  return results.sort((a, b) => a.id.localeCompare(b.id))
}

const results = await runAll()
console.log = printLog
await db.close()

const out = (title: string, rs: ScenarioResult[]) => {
  console.log(`\n${title}`)
  for (const line of renderSummary(summarize(rs))) console.log(`  ${line}`)
}
console.log(
  `Warren scenario eval: ${MODELS[model].id}, split ${split}, ${results.length} scenarios`,
)
const all = summarize(results)
out('All selected', results)
if (split === 'all') {
  out(
    'Dev',
    results.filter((r) => r.split === 'dev'),
  )
  // The test split is held out: counts only, never which scenario or why.
  const test = results.filter((r) => r.split === 'test')
  console.log(
    `\nTest (held out): ${test.filter((r) => r.status === 'pass').length}/${test.length} fully right, ${summarize(test).silentWrongChanges} silent wrong changes, ${summarize(test).unnecessaryQuestions} unnecessary questions`,
  )
}

const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
mkdirSync(join(root, 'evals/scenarios/results'), { recursive: true })
writeFileSync(
  join(root, `evals/scenarios/results/${stamp}-${split}.json`),
  // Held-out scenarios leave only their status behind: no texts, replies or problems.
  JSON.stringify(
    {
      startedAt,
      model: MODELS[model].id,
      summary: all,
      results: results.map((r) => (r.split === 'dev' ? r : { ...r, turns: [] })),
    },
    null,
    2,
  ),
)
appendFileSync(
  join(root, 'evals/scenarios/results/spend.jsonl'),
  `${JSON.stringify({ at: startedAt, model, split, scenarios: results.length, costUsd: all.costUsd })}\n`,
)

console.log(
  `\nGate (>=95% fully right, 0 silent wrong changes, 0 invented numbers, every scenario run): ${all.passedGate ? 'PASS' : 'FAIL'}`,
)
if (!all.passedGate) process.exitCode = 1
if (meter.exhausted) console.log(`Budget of US$${budget} reached: some scenarios were not run.`)

const failures = failureLines(results.filter((r) => r.split === 'dev'))
if (failures.length > 0) {
  console.log(`\nDev failures (${failures.length}):`)
  for (const line of failures) console.log(line)
}
if (split !== 'dev') console.log('\nTest-split failures are not printed (held out).')
process.exit(process.exitCode ?? 0)
