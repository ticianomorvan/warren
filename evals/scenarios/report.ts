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

/** Gate from docs/agent-spec.md: at least 95% of scenarios fully right, no silent wrong change, no invented number. */
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
    costUsd: turns.reduce((sum, t) => sum + t.costUsd, 0),
    costPerTurnUsd: mean(turns.map((t) => t.costUsd)),
    gate,
    passedGate: gate.passRate && gate.noSilentWrong && gate.noInvented && gate.complete,
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ms = (x: number) => `${Math.round(x).toLocaleString('en-US')} ms`

/** The numbers as lines of text, for the console and for the baseline file. */
export function renderSummary(s: Summary): string[] {
  const lines = [
    `scenarios fully right: ${s.passed}/${s.scenarios} (${pct(s.passRate)})${s.skipped ? `, ${s.skipped} not run (budget)` : ''}${s.errors ? `, ${s.errors} errors` : ''}`,
    `silent wrong changes: ${s.silentWrongChanges}`,
    `unnecessary questions: ${s.unnecessaryQuestions}`,
    `invented numbers: ${s.inventedNumbers}`,
    `turns: ${s.turns}; per turn p50 ${ms(s.turnMs.p50)}, p95 ${ms(s.turnMs.p95)} (model alone p50 ${ms(s.modelMs.p50)}, p95 ${ms(s.modelMs.p95)})`,
    `second model turn: ${s.secondTurn.turns} of ${s.secondTurn.withModel} turns that called the model (${pct(s.secondTurn.withModel === 0 ? 0 : s.secondTurn.turns / s.secondTurn.withModel)})`,
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
