import { mean, percentile } from '../stats'
import type { Action, ScenarioResult, TurnResult } from './drive'
import { TAGS, type Tag } from './schema'

export interface Latency {
  n: number
  p50: number
  p95: number
}

export interface Summary {
  /** Scenarios selected for the run (skipped ones included). */
  scenarios: number
  passed: number
  failed: number
  /** The pipeline or the runner broke on them (not a wrong answer). */
  errors: number
  /** Not run to the end: the budget stopped the run. */
  skipped: number
  passRate: number
  byTag: Partial<Record<Tag, { passed: number; total: number }>>
  /** Turns with a wrong write under a reply that claims success. */
  silentWrongChanges: number
  /** Turns where something had to change, nothing did, and the reply asked. */
  unnecessaryQuestions: number
  /** Turns whose reply holds an amount no movement has. */
  inventedNumbers: number
  turns: number
  /** Post to stored reply; includes the model call. */
  turnMs: Latency
  /** Only the agent loop (model calls and reads), as the pipeline stored it. */
  modelMs: Latency
  byAction: Partial<Record<Action, Latency>>
  /** Turns that needed a second model call, over the turns that called the model at all. */
  secondTurn: { turns: number; withModel: number }
  /** Turns that said how many model calls they should need, and how many used more. */
  turnCap: { capped: number; over: number }
  /** Why the turns with a second model call needed it: `tool:status` of every call of their first model turn. */
  secondTurnCauses: Record<string, number>
  /** Mean output tokens the model wrote per turn, by action, over the turns that called it. */
  outputTokens: { mean: number; byAction: Partial<Record<Action, { n: number; mean: number }>> }
  costUsd: number
  costPerTurnUsd: number
  gate: { passRate: boolean; noSilentWrong: boolean; noInvented: boolean; complete: boolean }
  passedGate: boolean
}

const latency = (values: number[]): Latency => ({
  n: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
})

const ACTIONS = ['log', 'correct', 'delete', 'undo', 'query', 'ask', 'multi', 'other'] as const

/** Counts, over the turns with a second model call, `tool:status` of every call the first model turn made. */
function secondTurnCauses(turns: TurnResult[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of turns) {
    if ((t.modelTurns ?? 0) <= 1) continue
    for (const a of t.audit ?? []) {
      if (a.turn !== 1) continue
      const key = `${a.tool}:${a.status}`
      out[key] = (out[key] ?? 0) + 1
    }
  }
  return out
}

function outputTokens(turns: TurnResult[]): Summary['outputTokens'] {
  const called = turns.filter((t) => t.outputTokens !== null && t.outputTokens !== undefined)
  const byAction: Summary['outputTokens']['byAction'] = {}
  for (const action of ACTIONS) {
    const of = called.filter((t) => t.action === action)
    if (of.length > 0) {
      byAction[action] = { n: of.length, mean: mean(of.map((t) => t.outputTokens ?? 0)) }
    }
  }
  return { mean: mean(called.map((t) => t.outputTokens ?? 0)), byAction }
}

/** The bar (docs/design.md, "Tests and evals"): at least 95% of scenarios fully right, no silent wrong change, no invented number. */
export const GATE_PASS_RATE = 0.95

export function summarize(results: ScenarioResult[]): Summary {
  const turns: TurnResult[] = results.flatMap((r) => r.turns)
  const passed = results.filter((r) => r.status === 'pass').length
  const byTag: Summary['byTag'] = {}
  for (const tag of TAGS) {
    const inTag = results.filter((r) => r.tags.includes(tag))
    if (inTag.length > 0) {
      byTag[tag] = { passed: inTag.filter((r) => r.status === 'pass').length, total: inTag.length }
    }
  }
  const byAction: Summary['byAction'] = {}
  for (const action of [
    'log',
    'correct',
    'delete',
    'undo',
    'query',
    'ask',
    'multi',
    'other',
  ] as const) {
    const of = turns.filter((t) => t.action === action)
    if (of.length > 0) byAction[action] = latency(of.map((t) => t.wallMs))
  }
  const silentWrongChanges = turns.filter((t) => t.grade.silentWrong).length
  const inventedNumbers = turns.filter((t) => t.grade.invented.length > 0).length
  const skipped = results.filter((r) => r.status === 'budget').length
  const errors = results.filter((r) => r.status === 'error').length
  const passRate = results.length === 0 ? 0 : passed / results.length
  const gate = {
    passRate: passRate >= GATE_PASS_RATE,
    noSilentWrong: silentWrongChanges === 0,
    noInvented: inventedNumbers === 0,
    // A gate over scenarios that did not all run proves nothing.
    complete: results.length > 0 && skipped === 0 && errors === 0,
  }
  return {
    scenarios: results.length,
    passed,
    failed: results.filter((r) => r.status === 'fail').length,
    errors,
    skipped,
    passRate,
    byTag,
    silentWrongChanges,
    unnecessaryQuestions: turns.filter((t) => t.grade.unnecessaryQuestion).length,
    inventedNumbers,
    turns: turns.length,
    turnMs: latency(turns.map((t) => t.wallMs)),
    modelMs: latency(turns.flatMap((t) => (t.modelMs === null ? [] : [t.modelMs]))),
    byAction,
    secondTurn: {
      turns: turns.filter((t) => (t.modelTurns ?? 0) > 1).length,
      withModel: turns.filter((t) => (t.modelTurns ?? 0) > 0).length,
    },
    turnCap: {
      capped: turns.filter((t) => t.capped).length,
      over: turns.filter((t) => t.overTurnCap).length,
    },
    secondTurnCauses: secondTurnCauses(turns),
    outputTokens: outputTokens(turns),
    costUsd: turns.reduce((sum, t) => sum + t.costUsd, 0),
    costPerTurnUsd: mean(turns.map((t) => t.costUsd)),
    gate,
    passedGate: gate.passRate && gate.noSilentWrong && gate.noInvented && gate.complete,
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ms = (x: number) => `${Math.round(x).toLocaleString('en-US')} ms`

/** The numbers as lines of text, for the console. */
export function renderSummary(s: Summary): string[] {
  const lines = [
    `scenarios fully right: ${s.passed}/${s.scenarios} (${pct(s.passRate)})${s.skipped ? `, ${s.skipped} not run (budget)` : ''}${s.errors ? `, ${s.errors} errors` : ''}`,
    `silent wrong changes: ${s.silentWrongChanges}`,
    `unnecessary questions: ${s.unnecessaryQuestions}`,
    `invented numbers: ${s.inventedNumbers}`,
    `turns: ${s.turns}; per turn p50 ${ms(s.turnMs.p50)}, p95 ${ms(s.turnMs.p95)} (model alone p50 ${ms(s.modelMs.p50)}, p95 ${ms(s.modelMs.p95)})`,
    `second model turn: ${s.secondTurn.turns} of ${s.secondTurn.withModel} turns that called the model (${pct(s.secondTurn.withModel === 0 ? 0 : s.secondTurn.turns / s.secondTurn.withModel)})`,
    `turns over their model-turn cap: ${s.turnCap.over} of ${s.turnCap.capped} capped`,
    `second-turn causes (calls of their first model turn): ${
      Object.entries(s.secondTurnCauses)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || 'none'
    }`,
    `output tokens per turn: mean ${s.outputTokens.mean.toFixed(0)}; by action ${Object.entries(
      s.outputTokens.byAction,
    )
      .map(([a, o]) => `${a} ${o.mean.toFixed(0)} (n ${o.n})`)
      .join(', ')}`,
    `cost: US$${s.costUsd.toFixed(4)} (US$${s.costPerTurnUsd.toFixed(5)} per turn)`,
  ]
  for (const [action, l] of Object.entries(s.byAction)) {
    lines.push(`  ${action}: n ${l.n}, p50 ${ms(l.p50)}, p95 ${ms(l.p95)}`)
  }
  for (const [tag, c] of Object.entries(s.byTag)) {
    lines.push(`  tag ${tag}: ${c.passed}/${c.total} (${pct(c.passed / c.total)})`)
  }
  return lines
}

/** One line per failed scenario: the first failing turn and why. Only for scenarios you may look at (dev). */
export function failureLines(results: ScenarioResult[]): string[] {
  return results.flatMap((r) => {
    if (r.status === 'error') return [`- ${r.id} [${r.tags.join(', ')}] error: ${r.error}`]
    if (r.status !== 'fail' || r.failedTurn === null) return []
    const t = r.turns[r.failedTurn]
    if (!t) return []
    const silent = t.grade.silentWrong ? ' SILENT WRONG CHANGE;' : ''
    const reply = t.reply.replace(/\s+/g, ' ').slice(0, 90)
    return [
      `- ${r.id} [${r.tags.join(', ')}] turn ${r.failedTurn + 1} "${t.text}":${silent} ${t.grade.problems.join('; ')} → reply "${reply}" ← ${JSON.stringify(t.parsed ?? null).slice(0, 320)}${t.error ? ` ERROR ${t.error.slice(0, 200)}` : ''}`,
    ]
  })
}

/** Per-turn wall time by tag (a scenario counts in each of its tags), over every turn that ran. */
export function latencyByTag(results: ScenarioResult[]): Partial<Record<Tag, Latency>> {
  const out: Partial<Record<Tag, Latency>> = {}
  for (const tag of TAGS) {
    const turns = results.filter((r) => r.tags.includes(tag)).flatMap((r) => r.turns)
    if (turns.length > 0) out[tag] = latency(turns.map((t) => t.wallMs))
  }
  return out
}

/** The per-tag latency as lines of text. */
export function renderLatencyByTag(byTag: Partial<Record<Tag, Latency>>): string[] {
  return Object.entries(byTag).map(
    ([tag, l]) => `  tag ${tag}: n ${l.n}, p50 ${ms(l.p50)}, p95 ${ms(l.p95)}`,
  )
}

/** What a run leaves in its result file that the report needs (the file holds more). */
export interface RunSummary {
  startedAt: string
  model: string
  summary: Summary
}

/** The middle value of a list (the mean of the two middle ones when the count is even). */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * The model turns of the middle message. Every message that calls the model needs at least one, so the
 * median is 1 while fewer than half of them needed a second (the held-out turns are not in the file,
 * only these counts are).
 */
export const medianModelTurns = (s: Summary): number =>
  s.secondTurn.withModel > 0 && s.secondTurn.turns / s.secondTurn.withModel >= 0.5 ? 2 : 1

/** One row of the comparison table: a label, how to read it from a run, how to show it. */
const ROWS: { label: string; get: (s: Summary) => number; show: (n: number) => string }[] = [
  { label: 'Scenarios fully right', get: (s) => s.passed, show: (n) => String(n) },
  { label: 'Fully right, share', get: (s) => s.passRate, show: pct },
  { label: 'Silent wrong changes', get: (s) => s.silentWrongChanges, show: (n) => String(n) },
  { label: 'Unnecessary questions', get: (s) => s.unnecessaryQuestions, show: (n) => String(n) },
  { label: 'Invented numbers', get: (s) => s.inventedNumbers, show: (n) => String(n) },
  { label: 'Per-turn latency p50', get: (s) => s.turnMs.p50, show: ms },
  { label: 'Per-turn latency p95', get: (s) => s.turnMs.p95, show: ms },
  { label: 'Model turns per message, p50', get: medianModelTurns, show: (n) => String(n) },
  {
    label: 'Messages needing a second model turn',
    get: (s) => (s.secondTurn.withModel === 0 ? 0 : s.secondTurn.turns / s.secondTurn.withModel),
    show: pct,
  },
  { label: 'Cost (US$)', get: (s) => s.costUsd, show: (n) => n.toFixed(4) },
]

/** A table of runs side by side with their median, from run summaries. */
function runsTable(runs: RunSummary[]): string[] {
  const head = ['', ...runs.map((_, i) => `Run ${i + 1}`), 'Median']
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`]
  for (const row of ROWS) {
    const values = runs.map((r) => row.get(r.summary))
    lines.push(`| ${[row.label, ...values.map(row.show), row.show(median(values))].join(' | ')} |`)
  }
  return lines
}

function section(title: string, runs: RunSummary[]): string[] {
  const first = runs[0]
  if (!first) return [`## ${title}`, '', 'No runs.', '']
  const s = first.summary
  return [
    `## ${title}`,
    '',
    `Model ${first.model}; ${runs.length} run${runs.length === 1 ? '' : 's'} (${runs.map((r) => r.startedAt.slice(0, 10)).join(', ')}); ${s.scenarios} scenarios and ${s.turns} turns per run.`,
    '',
    ...runsTable(runs),
    '',
  ]
}

/**
 * `results/latest.md`: the latest runs, written from result files so no number in it is typed by hand. Regenerate it with `pnpm eval:report`.
 */
export function renderLatest(latest: RunSummary[]): string {
  return [
    '# Scenario eval results',
    '',
    'Generated by `pnpm eval:report` from the runs of `pnpm eval:scenarios --split all`. Do not edit by hand.',
    '',
    'What each row counts, per run over all scenarios (dev and the held-out test split):',
    '',
    '- Scenarios fully right: scenarios whose every turn passed. Share is over the scenarios run.',
    '- Silent wrong changes: turns with a wrong write under a reply that claims success.',
    '- Unnecessary questions: turns where something had to change, nothing did, and the reply asked.',
    '- Invented numbers: turns whose reply holds an amount no movement has.',
    '- Per-turn latency: from the webhook post to the stored reply, the model call included, from the machine that ran it.',
    '- Model turns per message, p50: the median count of model calls over the messages that called the model.',
    '- Cost: the model spend of the run (not the voice transcriptions).',
    '',
    'Gate (`docs/design.md`): at least 95% fully right, 0 silent wrong changes, 0 invented numbers.',
    '',
    ...section('Latest', latest),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}
