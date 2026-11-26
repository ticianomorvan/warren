import { describe, expect, it } from 'vitest'
import { median, medianModelTurns, type RunSummary, renderLatest, type Summary } from './report'

const summary = (o: Partial<Summary> = {}): Summary => ({
  scenarios: 10,
  passed: 9,
  failed: 1,
  errors: 0,
  skipped: 0,
  passRate: 0.9,
  byTag: {},
  silentWrongChanges: 1,
  unnecessaryQuestions: 2,
  inventedNumbers: 0,
  turns: 20,
  turnMs: { n: 20, p50: 1400, p95: 2100 },
  modelMs: { n: 20, p50: 1300, p95: 2000 },
  byAction: {},
  secondTurn: { turns: 3, withModel: 20 },
  turnCap: { capped: 0, over: 0 },
  secondTurnCauses: {},
  outputTokens: { mean: 50, byAction: {} },
  costUsd: 0.02,
  costPerTurnUsd: 0.001,
  gate: { passRate: false, noSilentWrong: false, noInvented: true, complete: true },
  passedGate: false,
  ...o,
})
const run = (o: Partial<Summary> = {}): RunSummary => ({
  startedAt: '2026-11-22T10:00:00.000Z',
  model: 'claude-haiku-5-5',
  summary: summary(o),
})

describe('report', () => {
  it('takes the median of an odd and an even list', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  it('reads p50 model turns from the second-turn share', () => {
    expect(medianModelTurns(summary())).toBe(1)
    expect(medianModelTurns(summary({ secondTurn: { turns: 10, withModel: 20 } }))).toBe(2)
  })

  it('writes the latest runs with a median column and the fixed bar', () => {
    const md = renderLatest([run({ passed: 8 }), run({ passed: 9 }), run({ passed: 10 })])
    expect(md).toContain('## Latest')
    expect(md).not.toContain('baseline')
    expect(md).toContain('Gate (`docs/design.md`): at least 95% fully right')
    expect(md).toContain('| Scenarios fully right | 8 | 9 | 10 | 9 |')
    expect(md).toContain('| Per-turn latency p95 | 2,100 ms | 2,100 ms | 2,100 ms | 2,100 ms |')
  })
})
