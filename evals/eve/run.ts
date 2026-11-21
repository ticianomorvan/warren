import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { connect, migrate } from '../../src/db'
import { Meter } from '../scenarios/drive'
import { failureLines, latencyByTag, renderSummary, summarize } from '../scenarios/report'
import { loadScenarios } from '../scenarios/schema'
import { percentile } from '../stats'
import { runScenarioEve } from './drive'
import { startFakeGraph } from './fake-graph'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const { values } = parseArgs({
  options: {
    split: { type: 'string', default: 'dev' },
    concurrency: { type: 'string', default: '4' },
    budget: { type: 'string', default: '0.30' },
    only: { type: 'string' },
    // The eve server (`eve start`), the throwaway ledger database and the fake Graph's port.
    base: { type: 'string', default: 'http://localhost:3100' },
    ledger: { type: 'string', default: 'postgres://postgres:test@localhost:55432/warren_ledger' },
    'graph-port': { type: 'string', default: '3199' },
    // Keep the ledger of an earlier run (default: empty the throwaway database first).
    keep: { type: 'boolean', default: false },
  },
})

const split = values.split as 'dev' | 'test' | 'all'
const concurrency = Number(values.concurrency)
const budget = Number(values.budget)
if (!['dev', 'test', 'all'].includes(split) || !(concurrency > 0) || !(budget > 0)) {
  console.error('bad --split, --concurrency or --budget')
  process.exit(1)
}
// Only the throwaway local database is ever emptied.
if (!/@(localhost|127\.0\.0\.1):55432\//.test(values.ledger as string)) {
  console.error('--ledger must be the throwaway local Postgres (localhost:55432)')
  process.exit(1)
}

const only = values.only ? new Set(values.only.split(',').map((id) => id.trim())) : null
const scenarios = loadScenarios().filter((s) =>
  only ? only.has(s.id) : split === 'all' || s.split === split,
)
if (scenarios.length === 0) {
  console.error('no scenarios selected')
  process.exit(1)
}

const health = await fetch(`${values.base}/eve/v1/health`).catch(() => null)
if (!health?.ok) {
  console.error(
    `the eve server is not up at ${values.base}: build and start it first (evals/eve/README.md)`,
  )
  process.exit(1)
}

const printLog = console.log
console.log = () => {}
const sql = connect(values.ledger as string, { max: 4 })
await migrate(sql)
console.log = printLog
await sql`CREATE TABLE IF NOT EXISTS spike_clock (wa_id text PRIMARY KEY, now text NOT NULL)`
await sql`CREATE TABLE IF NOT EXISTS spike_usage (
  id bigserial PRIMARY KEY, wa_id text NOT NULL, turn_id text NOT NULL,
  input_tokens integer NOT NULL, output_tokens integer NOT NULL,
  cache_read_tokens integer NOT NULL, cache_write_tokens integer NOT NULL, at timestamptz NOT NULL DEFAULT now())`
await sql`CREATE TABLE IF NOT EXISTS spike_guard (
  id bigserial PRIMARY KEY, wa_id text NOT NULL, turn_id text NOT NULL, kind text NOT NULL,
  detail jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now())`
if (!values.keep) {
  await sql`TRUNCATE movement, reply, inbound_message, account, spike_clock, spike_usage, spike_guard RESTART IDENTITY CASCADE`
}

const graph = await startFakeGraph(Number(values['graph-port']))
const meter = new Meter(budget)
const startedAt = new Date()
const run = String(startedAt.getTime() % 1000)

type Result = Awaited<ReturnType<typeof runScenarioEve>>
const results: Result[] = []
const env = { sql, graph, base: values.base as string, meter, run }

const [first, ...rest] = scenarios
if (first) {
  // The first scenario alone writes the prompt cache; the rest read it (as the loop's runner does).
  results.push(await runScenarioEve(first, env))
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < rest.length) {
        const s = rest[next++]
        if (s) results.push(await runScenarioEve(s, env))
      }
    }),
  )
}
results.sort((a, b) => a.id.localeCompare(b.id))

const all = summarize(results)
const signals = results
  .flatMap((r) => r.extras.map((e) => e.firstSignalMs))
  .filter((x): x is number => x !== null)
const replaced = results.flatMap((r) => r.extras).filter((e) => e.guard).length
const out = (title: string, rs: Result[]) => {
  console.log(`\n${title}`)
  for (const line of renderSummary(summarize(rs))) console.log(`  ${line}`)
}
console.log(
  `Warren scenario eval on eve: claude-haiku-5-5, split ${split}, ${results.length} scenarios`,
)
out('All selected', results)
if (split === 'all') {
  out(
    'Dev',
    results.filter((r) => r.split === 'dev'),
  )
  const test = results.filter((r) => r.split === 'test')
  console.log(
    `\nTest (held out): ${test.filter((r) => r.status === 'pass').length}/${test.length} fully right, ${summarize(test).silentWrongChanges} silent wrong changes, ${summarize(test).unnecessaryQuestions} unnecessary questions`,
  )
}
console.log(
  `\nFirst signal (typing indicator after the webhook): n ${signals.length}, p50 ${Math.round(percentile(signals, 50))} ms, p95 ${Math.round(percentile(signals, 95))} ms, max ${Math.round(Math.max(0, ...signals))} ms`,
)
console.log(`Numbers guard replaced the model's text on ${replaced} turn(s).`)
console.log(
  `Spend: US$${all.costUsd.toFixed(4)} of US$${budget}${meter.exhausted ? ' (budget reached: some scenarios not run)' : ''}`,
)

const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
mkdirSync(join(root, 'evals/eve/results'), { recursive: true })
writeFileSync(
  join(root, `evals/eve/results/${stamp}-${split}.json`),
  JSON.stringify(
    {
      startedAt,
      model: 'claude-haiku-5-5',
      summary: all,
      latencyByTag: latencyByTag(results),
      firstSignal: {
        n: signals.length,
        p50: percentile(signals, 50),
        p95: percentile(signals, 95),
      },
      guardReplaced: replaced,
      // Held-out scenarios leave only their status behind, as in the loop's runner.
      results: results.map((r) => (r.split === 'dev' ? r : { ...r, turns: [], extras: [] })),
    },
    null,
    2,
  ),
)
appendFileSync(
  join(root, 'evals/eve/results/spend.jsonl'),
  `${JSON.stringify({ at: startedAt, split, scenarios: results.length, costUsd: all.costUsd })}\n`,
)
console.log(
  `\nGate (>=95% fully right, 0 silent wrong changes, 0 invented numbers, every scenario run): ${all.passedGate ? 'PASS' : 'FAIL'}`,
)
const failures = failureLines(results.filter((r) => r.split === 'dev'))
if (failures.length > 0) {
  console.log(`\nDev failures (${failures.length}):`)
  for (const line of failures) console.log(line)
}
if (split !== 'dev') console.log('\nTest-split failures are not printed (held out).')
await graph.close()
await sql.end({ timeout: 1 })
process.exit(all.passedGate ? 0 : 1)
