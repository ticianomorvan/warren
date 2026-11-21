import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NONE, script } from '../../src/command-fixtures'
import { SYSTEM_PROMPT } from '../../src/parse/prompt'
import { createTestDatabase } from '../../src/test-harness'
import { Meter, runScenario } from './drive'
import { isLive } from './grade'
import { summarize } from './report'
import { loadScenarios, parseScenarios, type Scenario, ScenarioSchema, TAGS } from './schema'

const scenarios = loadScenarios()

describe('scenarios.jsonl', () => {
  it('has at least 60 scenarios with unique ids', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(60)
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length)
  })

  it('splits about 80/20 into dev and test', () => {
    const test = scenarios.filter((s) => s.split === 'test').length / scenarios.length
    expect(test).toBeGreaterThan(0.15)
    expect(test).toBeLessThan(0.25)
  })

  it('covers every tag in dev, and every core tag in test', () => {
    for (const tag of TAGS) {
      expect(
        scenarios.some((s) => s.split === 'dev' && s.tags.includes(tag)),
        tag,
      ).toBe(true)
    }
    for (const tag of TAGS.filter((t) => t !== 'other')) {
      expect(
        scenarios.some((s) => s.split === 'test' && s.tags.includes(tag)),
        tag,
      ).toBe(true)
    }
  })

  it('keeps every test-split message out of the prompt few-shot examples', () => {
    for (const s of scenarios.filter((x) => x.split === 'test')) {
      for (const t of s.turns) expect(SYSTEM_PROMPT, s.id).not.toContain(`Message: ${t.text}\n`)
    }
  })

  it('lists seeds in the order they were logged and never logs in the future', () => {
    for (const s of scenarios) {
      const at = s.seed.map((m) => `${m.loggedOn ?? m.on}T${m.at}`)
      expect(at, s.id).toEqual([...at].sort())
      const first = s.turns[0]?.now ?? ''
      for (const when of at) expect(when <= first, `${s.id} seeds after the first turn`).toBe(true)
      const nows = s.turns.map((t) => t.now)
      expect(nows, s.id).toEqual([...nows].sort())
    }
  })

  it('only points at movements that exist and are live at that turn', () => {
    for (const s of scenarios) {
      const live = new Set(s.seed.map((m) => m.ref))
      expect(live.size, `${s.id} duplicate seed refs`).toBe(s.seed.length)
      for (const t of s.turns) {
        for (const op of t.ops) {
          if (op.op === 'log') {
            for (const m of op.movements) if (m.ref) live.add(m.ref)
          } else {
            expect(live.has(op.ref), `${s.id}: ${op.op} ${op.ref}`).toBe(true)
            if (op.op === 'delete') live.delete(op.ref)
          }
        }
      }
    }
  })

  it('asks only where nothing is expected to change', () => {
    for (const s of scenarios) {
      for (const t of s.turns) if (t.ask) expect(t.ops, s.id).toEqual([])
    }
  })

  it('rejects an unknown field', () => {
    expect(() => parseScenarios('{"id":"s001"}\n')).toThrow('line 1')
  })
})

describe('the driver, with a scripted model', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>
  beforeAll(async () => {
    db = await createTestDatabase()
  })
  afterAll(async () => {
    await db.close()
  })

  const make = (o: { id: string; text: string; ops: Scenario['turns'][number]['ops'] }): Scenario =>
    ScenarioSchema.parse({
      id: o.id,
      split: 'dev',
      tags: ['correction'],
      source: 'synthetic',
      note: 'driver test',
      seed: [
        {
          ref: 'b',
          description: 'café',
          amount: '3500',
          on: '2026-11-21',
          at: '10:10',
          category: 'restaurantes',
        },
        {
          ref: 'd',
          description: 'café',
          amount: '2900',
          on: '2026-11-21',
          at: '11:54',
          category: 'restaurantes',
        },
      ],
      turns: [{ now: '2026-11-21T12:00', text: o.text, ops: o.ops }],
    })
  const pick = (index: number, amount: string) => ({
    type: 'correct' as const,
    target: 'café',
    target_index: index,
    changes: { ...NONE, amount },
    confidence: 'high' as const,
  })

  it('passes a right correction and counts its cost and time', async () => {
    const s = make({
      id: 's901',
      text: 'el 2 fue 2500',
      ops: [{ op: 'correct', ref: 'b', set: { amount: '2500' } }],
    })
    const model = script(pick(2, '2500'))
    const r = await runScenario(s, {
      sql: db.sql,
      client: model.client,
      meter: new Meter(1),
      model: 'haiku',
    })
    expect(r.turns[0]?.grade.problems).toEqual([])
    expect(r.status).toBe('pass')
    expect(r.turns[0]?.reply).toContain('Corregido')
    expect(r.turns[0]?.costUsd).toBeGreaterThan(0)
    const sum = summarize([r])
    expect(sum.passRate).toBe(1)
    expect(sum.silentWrongChanges).toBe(0)
  })

  it('reports a wrong row under a success reply as a silent wrong change', async () => {
    const s = make({
      id: 's902',
      text: 'el 1 fue 2500',
      ops: [{ op: 'correct', ref: 'b', set: { amount: '2500' } }],
    })
    const model = script(pick(1, '2500'))
    const r = await runScenario(s, {
      sql: db.sql,
      client: model.client,
      meter: new Meter(1),
      model: 'haiku',
    })
    expect(r.status).toBe('fail')
    expect(r.turns[0]?.grade.silentWrong).toBe(true)
    expect(summarize([r]).silentWrongChanges).toBe(1)
    expect(summarize([r]).passedGate).toBe(false)
  })

  it('stops before a call that could pass the budget', async () => {
    const s = make({
      id: 's903',
      text: 'el 2 fue 2500',
      ops: [{ op: 'correct', ref: 'b', set: { amount: '2500' } }],
    })
    const model = script(pick(2, '2500'))
    const r = await runScenario(s, {
      sql: db.sql,
      client: model.client,
      meter: new Meter(0.0001),
      model: 'haiku',
    })
    expect(r.status).toBe('budget')
    expect(model.calls.n).toBe(0)
    const rows =
      await db.sql`SELECT superseded_by FROM movement m JOIN account a ON a.id = m.account_id WHERE a.wa_id LIKE '%903'`
    expect(rows.every((x) => x.superseded_by === null)).toBe(true)
    expect(summarize([r]).passedGate).toBe(false)
  })

  it('stamps new movements with the turn clock and ages the exchange between turns', async () => {
    const s = ScenarioSchema.parse({
      id: 's904',
      split: 'dev',
      tags: ['logging'],
      source: 'synthetic',
      note: 'driver test',
      turns: [
        {
          now: '2026-11-21T10:10',
          text: 'café 3500',
          ops: [{ op: 'log', movements: [{ amount: '3500', description: 'café' }] }],
        },
        {
          now: '2026-11-21T10:40',
          text: 'café 3500',
          ops: [{ op: 'log', movements: [{ amount: '3500', description: 'café' }] }],
        },
      ],
    })
    const cafe = {
      type: 'log' as const,
      movements: [
        {
          direction: 'out' as const,
          amount: '3500',
          currency: 'ARS' as const,
          date: '2026-11-21',
          description: 'café',
          category: 'restaurantes' as const,
          payment: null,
          confidence: 'high' as const,
        },
      ],
    }
    const model = script(cafe, cafe)
    const r = await runScenario(s, {
      sql: db.sql,
      client: model.client,
      meter: new Meter(1),
      model: 'haiku',
    })
    expect(r.status).toBe('pass')
    const rows = await db.sql<{ time: string }[]>`
      SELECT to_char(m.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI') AS time
      FROM movement m JOIN account a ON a.id = m.account_id WHERE a.wa_id LIKE '%904' ORDER BY m.id`
    expect(rows.map((x) => x.time)).toEqual(['10:10', '10:40'])
    expect(
      isLive({
        id: 1,
        amount: '1',
        date: '',
        description: '',
        category: '',
        payment: null,
        direction: 'out',
        currency: 'ARS',
        supersededBy: null,
        deleted: false,
      }),
    ).toBe(true)
  })
})
