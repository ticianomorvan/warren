import { describe, expect, it } from 'vitest'
import type { Command, Movement } from './schema'
import { InvalidCommandError, validateCommand } from './validate'

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
  it('marks only unstorable log values as fatal, never a delete with an empty target', () => {
    const bad: Command = { type: 'log', movements: [{ ...movement, amount: '3.500' }] }
    expect(validateCommand(bad, today).fatal).toHaveLength(1)
    const empty: Command = { type: 'delete', target: ' ', confidence: 'high' }
    const result = validateCommand(empty, today)
    expect(result.issues).toHaveLength(1)
    expect(result.fatal).toEqual([])
  })

  it('keeps a good log untouched', () => {
    const command: Command = { type: 'log', movements: [movement] }
    expect(validateCommand(command, today)).toEqual({ command, issues: [], fatal: [] })
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

  it('flags a correction that changes nothing or sets a bad amount', () => {
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

  it('throws on a log with no movements', () => {
    expect(() => validateCommand({ type: 'log', movements: [] }, today)).toThrow(
      InvalidCommandError,
    )
  })

  it('lowers every movement to low confidence when there are more than 10', () => {
    const movements = Array.from({ length: 11 }, () => movement)
    const result = validateCommand({ type: 'log', movements }, today)
    expect(result.issues).toHaveLength(1)
    expect(
      result.command.type === 'log' &&
        result.command.movements.every((m) => m.confidence === 'low'),
    ).toBe(true)
  })

  it('lowers confidence for an empty target on correct and delete', () => {
    const del = validateCommand({ type: 'delete', target: '  ', confidence: 'high' }, today)
    expect(del.command).toMatchObject({ confidence: 'low' })
    expect(del.issues[0]?.path).toBe('target')
    const changes = {
      direction: null,
      amount: '10',
      currency: null,
      date: null,
      description: null,
      category: null,
      payment: null,
    }
    const fix = validateCommand({ type: 'correct', target: '', changes, confidence: 'high' }, today)
    expect(fix.command).toMatchObject({ confidence: 'low' })
    expect(
      validateCommand({ type: 'delete', target: 'last', confidence: 'high' }, today).issues,
    ).toEqual([])
  })
})
