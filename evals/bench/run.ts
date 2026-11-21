/**
 * Model benchmark on Warren's eval cases: the production prompt, schema and grader, a different
 * model. Candidates rotate chunk by chunk so a provider's bad hour hits all of them alike.
 *
 *   pnpm tsx evals/bench/run.ts --run smoke --limit 5
 *   pnpm tsx evals/bench/run.ts --run full
 *
 * Spends money. Every call's cost is appended to results/spend.jsonl as it lands, and the run
 * stops sending requests once the total ever spent there reaches --budget (US$).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { estimateCostUsd, parseMessage } from '../../src/parse'
import { renderVolatile, SYSTEM_PROMPT } from '../../src/parse/prompt'
import { type Command, CommandSchema } from '../../src/parse/schema'
import { validateCommand } from '../../src/parse/validate'
import { type EvalCase, grade } from '../grade'
import { mean, percentile } from '../stats'
import { CANDIDATES, type Candidate } from './candidates'
import { callOpenRouter, OpenRouterError } from './openrouter'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const resultsDir = join(root, 'evals/bench/results')
const spendFile = join(resultsDir, 'spend.jsonl')

const { values } = parseArgs({
  options: {
    run: { type: 'string', default: 'smoke' },
    candidates: { type: 'string' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    chunk: { type: 'string', default: '11' },
    budget: { type: 'string', default: '3' },
  },
})
const runName = values.run as string
const concurrency = Number(values.concurrency)
const chunkSize = Number(values.chunk)
const budget = Number(values.budget)
const wanted = values.candidates?.split(',')
const candidates = wanted
  ? wanted.map((key) => {
      const found = CANDIDATES.find((c) => c.key === key)
      if (!found) throw new Error(`unknown candidate ${key}`)
      return found
    })
  : CANDIDATES

// Keys live only in .env; they are read into the environment and never printed.
try {
  process.loadEnvFile(join(root, '.env'))
} catch {}
const openRouterKey = process.env.OPENROUTER_API_KEY ?? ''
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is missing')
if (!openRouterKey) throw new Error('OPENROUTER_API_KEY is missing')

let cases = readFileSync(join(root, 'evals/cases.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as EvalCase)
if (values.limit) cases = cases.slice(0, Number(values.limit))

mkdirSync(resultsDir, { recursive: true })
const spentBefore = existsSync(spendFile)
  ? readFileSync(spendFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => sum + (JSON.parse(line) as { costUsd: number }).costUsd, 0)
  : 0
let spent = spentBefore

type ErrorKind = 'http' | 'no_content' | 'json' | 'schema' | 'invalid' | 'api' | 'budget'

type CaseRun = {
  id: string
  split: 'dev' | 'test'
  latencyMs: number | null
  error: { kind: ErrorKind; message: string } | null
  full: boolean
  typeOk: boolean
  silentWrongAmount: boolean
  soft: Record<string, { ok: number; total: number }>
  reasons: string[]
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd: number
  servedBy: string | null
  attempts: number
  actual: Command | null
}

const blank = (c: EvalCase): CaseRun => ({
  id: c.id,
  split: c.split,
  latencyMs: null,
  error: null,
  full: false,
  typeOk: false,
  silentWrongAmount: false,
  soft: {},
  reasons: [],
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  servedBy: null,
  attempts: 1,
  actual: null,
})

function recordSpend(candidate: Candidate, costUsd: number) {
  spent += costUsd
  appendFileSync(
    spendFile,
    `${JSON.stringify({ at: new Date().toISOString(), run: runName, candidate: candidate.key, costUsd })}\n`,
  )
}

function finish(run: CaseRun, c: EvalCase, command: Command): CaseRun {
  const g = grade(c, command)
  return {
    ...run,
    full: g.full,
    typeOk: g.typeOk,
    silentWrongAmount: g.silentWrongAmount,
    soft: g.soft,
    reasons: g.reasons,
    actual: command,
  }
}

async function runCase(candidate: Candidate, c: EvalCase): Promise<CaseRun> {
  const run = blank(c)
  if (spent >= budget) {
    return { ...run, error: { kind: 'budget', message: 'budget reached' } }
  }
  if (candidate.via === 'anthropic') {
    try {
      const r = await parseMessage({
        text: c.text,
        today: c.today,
        recentMovements: c.recent,
        model: 'haiku',
      })
      const costUsd = estimateCostUsd('haiku', r.usage)
      recordSpend(candidate, costUsd)
      return finish(
        {
          ...run,
          latencyMs: r.latencyMs,
          promptTokens: r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens,
          completionTokens: r.usage.outputTokens,
          cachedTokens: r.usage.cacheReadTokens,
          cacheWriteTokens: r.usage.cacheWriteTokens,
          costUsd,
          servedBy: 'Anthropic',
        },
        c,
        r.command,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error)
      return { ...run, error: { kind: 'api', message } }
    }
  }

  const user = renderVolatile({ text: c.text, today: c.today, recentMovements: c.recent })
  let call: Awaited<ReturnType<typeof callOpenRouter>>
  try {
    call = await callOpenRouter(candidate, { system: SYSTEM_PROMPT, user }, openRouterKey)
  } catch (error) {
    if (error instanceof OpenRouterError) {
      return {
        ...run,
        latencyMs: error.latencyMs,
        attempts: error.attempts,
        error: { kind: 'http', message: error.message },
      }
    }
    return { ...run, error: { kind: 'http', message: String(error).slice(0, 300) } }
  }
  const costUsd = call.usage.costUsd ?? 0
  recordSpend(candidate, costUsd)
  const filled: CaseRun = {
    ...run,
    latencyMs: call.latencyMs,
    attempts: call.attempts,
    servedBy: call.servedBy,
    promptTokens: call.usage.promptTokens,
    completionTokens: call.usage.completionTokens,
    cachedTokens: call.usage.cachedTokens,
    cacheWriteTokens: call.usage.cacheWriteTokens,
    reasoningTokens: call.usage.reasoningTokens,
    costUsd,
  }
  const fail = (kind: ErrorKind, message: string): CaseRun => ({
    ...filled,
    error: { kind, message: message.slice(0, 300) },
  })
  if (call.content === null) return fail('no_content', `finish_reason ${call.finishReason}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(call.content)
  } catch {
    return fail('json', `finish_reason ${call.finishReason}: ${call.content.slice(0, 120)}`)
  }
  if (candidate.wrap) parsed = (parsed as { command?: unknown } | null)?.command
  const checked = CommandSchema.safeParse(parsed)
  if (!checked.success) return fail('schema', checked.error.issues[0]?.message ?? 'schema')
  try {
    return finish(filled, c, validateCommand(checked.data, c.today).command)
  } catch (error) {
    return fail('invalid', error instanceof Error ? error.message : String(error))
  }
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const item = items[next++]
        if (item !== undefined) await worker(item)
      }
    }),
  )
}

const runs = new Map<string, CaseRun[]>(candidates.map((c) => [c.key, []]))
const startedAt = new Date()
const chunks: EvalCase[][] = []
for (let i = 0; i < cases.length; i += chunkSize) chunks.push(cases.slice(i, i + chunkSize))

for (const [index, chunk] of chunks.entries()) {
  // Rotate who goes first, so none always gets the start of a window.
  for (let k = 0; k < candidates.length; k++) {
    const candidate = candidates[(index + k) % candidates.length]
    if (!candidate) continue
    const out = runs.get(candidate.key) ?? []
    let rest = chunk
    if (index === 0) {
      // The first request alone writes the prompt cache; the rest can then read it.
      const [first, ...others] = chunk
      if (first) out.push(await runCase(candidate, first))
      rest = others
    }
    await pool(rest, async (c) => {
      out.push(await runCase(candidate, c))
    })
  }
  console.error(
    `chunk ${index + 1}/${chunks.length} done, spent so far US$${spent.toFixed(4)} (of ${budget})`,
  )
}

// ---- summary ----

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ms = (x: number) => `${Math.round(x)}`

function summarize(candidate: Candidate, all: CaseRun[]) {
  const bySplit = (split: 'dev' | 'test') => all.filter((r) => r.split === split)
  const fully = (rs: CaseRun[]) => rs.filter((r) => r.full).length
  const answered = all.filter((r) => r.error === null || r.error.kind !== 'budget')
  const lat = answered.flatMap((r) =>
    r.latencyMs !== null && r.error === null ? [r.latencyMs] : [],
  )
  const errors = (kind: ErrorKind[]) => all.filter((r) => r.error && kind.includes(r.error.kind))
  const billed = all.filter((r) => r.costUsd > 0)
  const cacheable = all.filter((r) => r.promptTokens > 0)
  const gradedCases = all.filter((r) => r.error === null)
  return {
    candidate: candidate.key,
    label: candidate.label,
    model: candidate.model ?? 'claude-haiku-5-5',
    provider: candidate.provider ?? 'anthropic (direct)',
    servedBy: [...new Set(all.flatMap((r) => (r.servedBy ? [r.servedBy] : [])))],
    wrapped: candidate.wrap === true,
    cases: all.length,
    dev: { n: bySplit('dev').length, full: fully(bySplit('dev')) },
    test: { n: bySplit('test').length, full: fully(bySplit('test')) },
    all: { n: all.length, full: fully(all), accuracy: all.length ? fully(all) / all.length : 0 },
    typeAccuracy: all.length ? all.filter((r) => r.typeOk).length / all.length : 0,
    silentWrongAmounts: all.filter((r) => r.silentWrongAmount).length,
    errorsTotal: all.filter((r) => r.error !== null).length,
    httpErrors: errors(['http', 'api']).length,
    schemaFailures: errors(['no_content', 'json', 'schema', 'invalid']).length,
    budgetSkipped: errors(['budget']).length,
    latencyMs: {
      n: lat.length,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      p99: percentile(lat, 99),
      mean: mean(lat),
    },
    retries: all.filter((r) => r.attempts > 1).length,
    costUsd: {
      total: all.reduce((s, r) => s + r.costUsd, 0),
      perMessage: mean(billed.map((r) => r.costUsd)),
    },
    meanPromptTokens: mean(cacheable.map((r) => r.promptTokens)),
    meanCompletionTokens: mean(cacheable.map((r) => r.completionTokens)),
    reasoningTokens: {
      total: all.reduce((s, r) => s + r.reasoningTokens, 0),
      casesWithReasoning: all.filter((r) => r.reasoningTokens > 0).length,
    },
    cache: {
      casesWithHit: all.filter((r) => r.cachedTokens > 0).length,
      hitRate: cacheable.length
        ? all.filter((r) => r.cachedTokens > 0).length / cacheable.length
        : 0,
      meanCachedTokens: mean(cacheable.map((r) => r.cachedTokens)),
      casesWithWrite: all.filter((r) => r.cacheWriteTokens > 0).length,
    },
    gradedCases: gradedCases.length,
    gate: {
      accuracyAtLeast97: all.length > 0 && fully(all) / all.length >= 0.97,
      noSilentWrongAmounts: all.every((r) => !r.silentWrongAmount),
    },
  }
}

const sorted = (rs: CaseRun[]) => [...rs].sort((a, b) => a.id.localeCompare(b.id))
const caseById = new Map(cases.map((c) => [c.id, c]))
const outDir = join(resultsDir, `${startedAt.toISOString().replace(/[:.]/g, '-')}-${runName}`)
mkdirSync(outDir, { recursive: true })
const summaries = []
for (const candidate of candidates) {
  const all = sorted(runs.get(candidate.key) ?? [])
  const summary = summarize(candidate, all)
  summaries.push(summary)
  // Held-out cases leave only aggregates and timings behind: no text, expected, actual or reasons.
  const detail = all.map((r) => {
    if (r.split === 'test') {
      const { actual, reasons, soft, error, ...timing } = r
      return { ...timing, error: error ? { kind: error.kind } : null }
    }
    const c = caseById.get(r.id)
    return { ...r, text: c?.text, expected: c?.expected }
  })
  writeFileSync(
    join(outDir, `${candidate.key}.json`),
    JSON.stringify({ startedAt, summary, candidate: { ...candidate }, cases: detail }, null, 2),
  )
}

const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`
const md: string[] = [
  `# Warren model bench: ${runName}`,
  '',
  `Started ${startedAt.toISOString()}. ${cases.length} cases per candidate, concurrency ${concurrency}, candidates rotated in chunks of ${chunkSize}. Spend this run US$${(spent - spentBefore).toFixed(4)}; total ever spent on the bench US$${spent.toFixed(4)} (cap ${budget}).`,
  '',
  row([
    'Candidate',
    'Dev full',
    'Test full',
    'All full',
    'Silent wrong $',
    'HTTP err',
    'Schema fail',
    'p50 ms',
    'p95 ms',
    'p99 ms',
    'US$/msg',
    'Reasoning tokens (cases)',
    'Cache hit',
    'Gate',
  ]),
  row(Array(14).fill('---')),
  ...summaries.map((s) =>
    row([
      s.candidate,
      `${s.dev.full}/${s.dev.n}`,
      `${s.test.full}/${s.test.n}`,
      `${s.all.full}/${s.all.n} (${pct(s.all.accuracy)})`,
      s.silentWrongAmounts,
      s.httpErrors,
      s.schemaFailures,
      ms(s.latencyMs.p50),
      ms(s.latencyMs.p95),
      ms(s.latencyMs.p99),
      s.costUsd.perMessage.toFixed(6),
      `${s.reasoningTokens.total} (${s.reasoningTokens.casesWithReasoning})`,
      `${pct(s.cache.hitRate)} (mean ${Math.round(s.cache.meanCachedTokens)} of ${Math.round(s.meanPromptTokens)} tok)`,
      s.gate.accuracyAtLeast97 && s.gate.noSilentWrongAmounts ? 'PASS' : 'FAIL',
    ]),
  ),
  '',
  '## Dev failures (held-out test failures are never listed)',
]
for (const candidate of candidates) {
  const failures = (runs.get(candidate.key) ?? []).filter((r) => r.split === 'dev' && !r.full)
  md.push('', `### ${candidate.key} (${failures.length})`)
  for (const f of sorted(failures)) {
    const c = caseById.get(f.id)
    md.push(
      `- ${f.id} "${c?.text}": ${f.error ? `${f.error.kind}: ${f.error.message}` : f.reasons.join('; ')}`,
    )
  }
}
writeFileSync(join(outDir, 'summary.md'), `${md.join('\n')}\n`)
console.log(md.slice(0, 8).join('\n'))
console.log(`\nWrote ${outDir}`)
