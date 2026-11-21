import { describe, expect, it } from 'vitest'
import type { Command, Movement } from '../src/parse/schema'
import { canonicalAmount, type EvalCase, grade, similarText } from './grade'

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
      expected: {
        type: 'correct',
        target: 'café',
        target_index: null,
        changes,
        confidence: 'high',
      },
    }
    const right: Command = {
      type: 'correct',
      target: 'el cafe',
      target_index: null,
      changes,
      confidence: 'high',
    }
    expect(grade(testCase, right).full).toBe(true)
    const wrong: Command = { ...right, changes: { ...changes, amount: '380' } } as Command
    expect(grade(testCase, wrong).silentWrongAmount).toBe(true)
  })
})

describe('hard fields of the other commands', () => {
  const rec = (target: string): EvalCase => ({
    ...base,
    expected: { type: 'delete', target, target_index: null, confidence: 'high' },
  })
  const query = (over: object): Command => ({
    type: 'query',
    period: 'this_month',
    direction: 'out',
    category: 'supermercado',
    payment: null,
    ...over,
  })
  const queryCase: EvalCase = { ...base, expected: query({}) }

  it('a delete with the wrong target is not fully correct; a fuzzy match is', () => {
    expect(
      grade(rec('súper'), {
        type: 'delete',
        target: 'nafta',
        target_index: null,
        confidence: 'high',
      }).full,
    ).toBe(false)
    expect(
      grade(rec('súper'), {
        type: 'delete',
        target: 'last',
        target_index: null,
        confidence: 'high',
      }).full,
    ).toBe(false)
    expect(
      grade(rec('súper'), {
        type: 'delete',
        target: 'el super',
        target_index: null,
        confidence: 'high',
      }).full,
    ).toBe(true)
    expect(
      grade(rec('last'), { type: 'delete', target: 'last', target_index: null, confidence: 'high' })
        .full,
    ).toBe(true)
  })

  it('a correction with the wrong target is not fully correct', () => {
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
      expected: {
        type: 'correct',
        target: 'café',
        target_index: null,
        changes,
        confidence: 'high',
      },
    }
    expect(
      grade(testCase, {
        type: 'correct',
        target: 'nafta',
        target_index: null,
        changes,
        confidence: 'high',
      }).full,
    ).toBe(false)
  })

  it('a query with the wrong direction, category or payment is not fully correct', () => {
    expect(grade(queryCase, query({})).full).toBe(true)
    expect(grade(queryCase, query({ direction: 'in' })).full).toBe(false)
    expect(grade(queryCase, query({ category: 'salud' })).full).toBe(false)
    expect(grade(queryCase, query({ payment: 'efectivo' })).full).toBe(false)
    expect(grade(queryCase, query({ period: 'last_month' })).full).toBe(false)
  })
})

describe('canonical amounts', () => {
  it('compares decimals, not strings', () => {
    expect(canonicalAmount('2800.50')).toBe('2800.5')
    expect(canonicalAmount('3500.00')).toBe('3500')
    expect(canonicalAmount('3500')).toBe('3500')
    const decimal: EvalCase = {
      ...base,
      expected: { type: 'log', movements: [{ ...want, amount: '2800.5' }] },
    }
    expect(grade(decimal, log({ ...want, amount: '2800.50' })).full).toBe(true)
    expect(grade(decimal, log({ ...want, amount: '2800.55' })).full).toBe(false)
  })
})

describe('movement count mismatch', () => {
  it('flags a sum of two purchases returned as one high-confidence movement', () => {
    const two: EvalCase = {
      ...base,
      expected: { type: 'log', movements: [want, { ...want, amount: '2000' }] },
    }
    const g = grade(two, log({ ...want, amount: '5500' }))
    expect(g.full).toBe(false)
    expect(g.silentWrongAmount).toBe(true)
    expect(grade(two, log({ ...want, amount: '5500', confidence: 'low' })).silentWrongAmount).toBe(
      false,
    )
  })
})

describe('similarText', () => {
  it('does not match on stopwords or short words', () => {
    expect(similarText('service del auto', 'pago del gas')).toBe(false)
    expect(similarText('regalo para mamá', 'compra para el auto')).toBe(false)
  })

  it('matches equal or contained targets', () => {
    expect(similarText('el café', 'café')).toBe(true)
    expect(similarText('last', 'last')).toBe(true)
  })

  it('ignores case and accents and matches shared stems', () => {
    expect(similarText('Café', 'cafe')).toBe(true)
    expect(similarText('farmacia del barrio', 'farmacia')).toBe(true)
    expect(similarText('nafta', 'café')).toBe(false)
  })
})

describe('which movement a correction or delete points at', () => {
  const rec = (target_index: number | null, ambiguous = false): EvalCase => ({
    ...base,
    ambiguous,
    expected: { type: 'delete', target: 'súper', target_index, confidence: 'high' },
  })
  const del = (target_index: number | null, confidence: 'high' | 'low' = 'high'): Command => ({
    type: 'delete',
    target: 'súper',
    target_index,
    confidence,
  })

  it('needs the right number, even when the text is right', () => {
    expect(grade(rec(2), del(2)).full).toBe(true)
    const wrong = grade(rec(2), del(3))
    expect(wrong.full).toBe(false)
    expect(wrong.reasons[0]).toContain('target_index 3, expected 2')
    expect(grade(rec(2), del(null)).full).toBe(false)
  })

  it('passes an ambiguous case by asking (null number) or by low confidence, not by guessing', () => {
    expect(grade(rec(null, true), del(null)).full).toBe(true)
    expect(grade(rec(null, true), del(1, 'low')).full).toBe(true)
    expect(grade(rec(null, true), del(1)).full).toBe(false)
  })
})

describe('silent wrong targets', () => {
  const recent = [
    {
      direction: 'out',
      amount: '2800',
      currency: 'ARS',
      date: '2026-11-20',
      description: 'café',
      category: 'restaurantes',
      payment: null,
    },
    {
      direction: 'out',
      amount: '12000',
      currency: 'ARS',
      date: '2026-11-19',
      description: 'súper',
      category: 'supermercado',
      payment: null,
    },
    {
      direction: 'out',
      amount: '3100',
      currency: 'ARS',
      date: '2026-11-18',
      description: 'café',
      category: 'restaurantes',
      payment: null,
    },
  ] as EvalCase['recent']
  const deleting = (text: string, expectedIndex: number | null, ambiguous = false): EvalCase => ({
    ...base,
    text,
    recent,
    ambiguous,
    expected: { type: 'delete', target: 'café', target_index: expectedIndex, confidence: 'high' },
  })
  const del = (
    target: string,
    target_index: number | null,
    confidence: 'high' | 'low' = 'high',
  ): Command => ({
    type: 'delete',
    target,
    target_index,
    confidence,
  })

  it('counts a confident wrong number that code would still apply', () => {
    const g = grade(deleting('borrá lo del súper', 1), del('súper', 2))
    expect(g.full).toBe(false)
    expect(g.silentWrongTarget).toBe(true)
  })

  it('does not count a wrong number that code turns into a question (the model misses, nothing breaks)', () => {
    const g = grade(deleting('borrá el café', null, true), del('café', 1))
    expect(g.full).toBe(false) // the model was wrong
    expect(g.silentWrongTarget).toBe(false) // two cafés and no position in the message: code asks
  })

  it('does not count a right number, or a low-confidence answer', () => {
    expect(grade(deleting('borrá el 3', 3), del('café', 3)).silentWrongTarget).toBe(false)
    expect(grade(deleting('borrá lo del súper', 1), del('súper', 2, 'low')).silentWrongTarget).toBe(
      false,
    )
  })
})
