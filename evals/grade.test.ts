import { describe, expect, it } from 'vitest'
import type { Command, Movement } from '../src/parse/schema'
import { type EvalCase, grade, similarText } from './grade'

const want: Movement = {
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: '2026-11-20',
  description: 'café',
  category: 'restaurantes',
  payment: null,
  confidence: 'high',
}
const base: EvalCase = {
  id: 'x',
  split: 'dev',
  today: '2026-11-20',
  text: 'cafe 3500',
  recent: [],
  ambiguous: false,
  expected: { type: 'log', movements: [want] },
}
const log = (...movements: Movement[]): Command => ({ type: 'log', movements })

describe('grade', () => {
  it('is fully correct when the hard fields match', () => {
    const g = grade(base, log({ ...want, category: 'otros', description: 'cafecito' }))
    expect(g.full).toBe(true)
    expect(g.soft.category).toEqual({ ok: 0, total: 1 })
    expect(g.soft.description).toEqual({ ok: 1, total: 1 })
  })

  it('counts a wrong amount with high confidence as a silent error', () => {
    const g = grade(base, log({ ...want, amount: '350' }))
    expect(g.full).toBe(false)
    expect(g.silentWrongAmount).toBe(true)
  })

  it('does not count a wrong low-confidence amount as silent', () => {
    const g = grade(base, log({ ...want, amount: '350', confidence: 'low' }))
    expect(g.full).toBe(false)
    expect(g.silentWrongAmount).toBe(false)
  })

  it('passes an ambiguous case by low confidence', () => {
    const g = grade(
      { ...base, ambiguous: true },
      log({ ...want, amount: '350', confidence: 'low' }),
    )
    expect(g.full).toBe(true)
  })

  it('fails on the wrong command type or movement count', () => {
    expect(grade(base, { type: 'help' }).full).toBe(false)
    expect(grade(base, log(want, want)).full).toBe(false)
  })

  it('grades corrections on amount, currency, date and direction', () => {
    const changes = {
      direction: null,
      amount: '3800',
      currency: null,
      date: null,
      description: null,
      category: null,
      payment: null,
    }
    const testCase: EvalCase = {
      ...base,
      expected: { type: 'correct', target: 'café', changes, confidence: 'high' },
    }
    const right: Command = { type: 'correct', target: 'el cafe', changes, confidence: 'high' }
    expect(grade(testCase, right).full).toBe(true)
    const wrong: Command = { ...right, changes: { ...changes, amount: '380' } } as Command
    expect(grade(testCase, wrong).silentWrongAmount).toBe(true)
  })
})

describe('similarText', () => {
  it('ignores case and accents and matches shared stems', () => {
    expect(similarText('Café', 'cafe')).toBe(true)
    expect(similarText('farmacia del barrio', 'farmacia')).toBe(true)
    expect(similarText('nafta', 'café')).toBe(false)
  })
})
