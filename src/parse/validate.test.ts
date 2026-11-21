import { describe, expect, it } from 'vitest'
import type { Command, Movement } from './schema'
import { validateCommand } from './validate'

const today = '2026-11-20'
const movement: Movement = {
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: today,
  description: 'café',
  category: 'restaurantes',
  payment: null,
  confidence: 'high',
}

const check = (overrides: Partial<Movement>) =>
  validateCommand({ type: 'log', movements: [{ ...movement, ...overrides }] }, today).issues

describe('amount check', () => {
  it.each(['3500', '1500000.50', '0.99', '12.5'])('accepts %s', (amount) => {
    expect(check({ amount })).toEqual([])
  })

  it.each(['', '0', '0.00', '-5', '3.500', '3,5', '1e3', '12.345', ' 5', '$100', 'tres mil'])(
    'rejects "%s"',
    (amount) => {
      expect(check({ amount }).map((issue) => issue.path)).toEqual(['movements[0].amount'])
    },
  )
})

describe('date check', () => {
  it('accepts today and earlier days', () => {
    expect(check({ date: '2026-11-20' })).toEqual([])
    expect(check({ date: '2025-12-31' })).toEqual([])
  })

  it('rejects a day after today, a bad shape and a day that does not exist', () => {
    expect(check({ date: '2026-11-21' })[0]?.message).toBe('date is after today')
    expect(check({ date: '20/11/2026' })[0]?.message).toBe('date is not yyyy-mm-dd')
    expect(check({ date: '2026-02-30' })[0]?.message).toBe('date does not exist')
  })
})

describe('validateCommand', () => {
  it('keeps a good log untouched', () => {
    const command: Command = { type: 'log', movements: [movement] }
    expect(validateCommand(command, today)).toEqual({ command, issues: [] })
  })

  it('lowers confidence for a bad amount or date and never repairs the value', () => {
    const command: Command = {
      type: 'log',
      movements: [{ ...movement, amount: '3.500' }, { ...movement, date: '2026-11-25' }, movement],
    }
    const result = validateCommand(command, today)
    expect(
      result.command.type === 'log' && result.command.movements.map((m) => m.confidence),
    ).toEqual(['low', 'low', 'high'])
    expect(result.command.type === 'log' && result.command.movements[0]?.amount).toBe('3.500')
    expect(result.issues.map((issue) => issue.path)).toEqual([
      'movements[0].amount',
      'movements[1].date',
    ])
  })

  it('flags an empty log and a correction that changes nothing or sets a bad amount', () => {
    expect(validateCommand({ type: 'log', movements: [] }, today).issues).toHaveLength(1)
    const changes = {
      direction: null,
      amount: null,
      currency: null,
      date: null,
      description: null,
      category: null,
      payment: null,
    }
    const empty = validateCommand(
      { type: 'correct', target: 'last', changes, confidence: 'high' },
      today,
    )
    expect(empty.issues).toHaveLength(1)
    const bad = validateCommand(
      {
        type: 'correct',
        target: 'last',
        changes: { ...changes, amount: '-3' },
        confidence: 'high',
      },
      today,
    )
    expect(bad.command).toMatchObject({ confidence: 'low' })
  })
})
