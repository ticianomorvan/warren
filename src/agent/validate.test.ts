import { describe, expect, it } from 'vitest'
import type { Movement } from './schema'
import { checkChanges, checkCount, checkLog, hasChanges, issueText } from './validate'

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

const check = (overrides: Partial<Movement>) => checkLog([{ ...movement, ...overrides }], today)

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

describe('checkLog', () => {
  it('rejects an empty log and an empty description', () => {
    expect(checkLog([], today)).toHaveLength(1)
    expect(check({ description: '  ' }).map((i) => i.path)).toEqual(['movements[0].description'])
  })

  it('reports every bad movement', () => {
    const issues = checkLog(
      [{ ...movement, amount: '3.500' }, movement, { ...movement, date: '2027-01-01' }],
      today,
    )
    expect(issues.map((i) => i.path)).toEqual(['movements[0].amount', 'movements[2].date'])
  })
})

describe('checkCount', () => {
  it('allows 10 movements per message and no more', () => {
    expect(checkCount(10)).toEqual([])
    expect(checkCount(11)).toHaveLength(1)
  })
})

describe('checkChanges', () => {
  it('applies the same value rules to a correction', () => {
    expect(checkChanges({ amount: '3800', date: '2026-11-19' }, today)).toEqual([])
    expect(checkChanges({ amount: '3.800' }, today).map((i) => i.path)).toEqual(['changes.amount'])
    expect(checkChanges({ date: '2026-12-01' }, today).map((i) => i.path)).toEqual(['changes.date'])
    expect(checkChanges({ description: ' ', payment: '' }, today)).toHaveLength(2)
  })

  it('knows when a correction changes nothing', () => {
    expect(hasChanges({})).toBe(false)
    expect(hasChanges({ amount: '1' })).toBe(true)
  })

  it('words the issues for the model', () => {
    expect(issueText(checkChanges({ amount: 'x' }, today))).toContain('changes.amount')
  })
})

describe('long numbers in descriptions and payment names', () => {
  it.each([
    ['description', 'café 12000'],
    ['description', 'ticket 1234'],
    ['description', 'súper 12.000'],
    ['payment', 'visa 4509'],
    ['payment', 'tarjeta 4509 1234'],
  ] as const)('refuses %s "%s": a figure the amount does not vouch for', (field, value) => {
    const issues = check({ [field]: value })
    expect(issues.map((i) => i.path)).toEqual([`movements[0].${field}`])
    expect(issues[0]?.message).toContain('4 or more digits')
    expect(checkChanges({ [field]: value }, today).map((i) => i.path)).toEqual([`changes.${field}`])
  })

  it.each(['mc 100', 'cuota 3', 'cuota 12/12', 'club 99', 'pedidos ya', 'personal pay'])(
    'accepts "%s"',
    (value) => {
      expect(check({ description: value, payment: value })).toEqual([])
      expect(checkChanges({ description: value, payment: value }, today)).toEqual([])
    },
  )
})
