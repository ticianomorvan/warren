import { describe, expect, it } from 'vitest'
import type { Changes, RecentMovement } from './agent'
import { applyChanges, canonicalAmount, changedFields, normalizeText } from './movement'

const row: RecentMovement = {
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: '2026-11-20',
  description: 'café',
  category: 'restaurantes',
  payment: 'visa',
}
const none: Changes = {}

describe('applyChanges', () => {
  it('sets only what changes', () => {
    expect(applyChanges(row, { ...none, amount: '3800', payment: ' efectivo ' })).toEqual({
      ...row,
      amount: '3800',
      payment: 'efectivo',
    })
    expect(applyChanges(row, none)).toEqual(row)
  })
})

describe('changedFields', () => {
  it('lists what differs, counting amount, currency and direction as the money', () => {
    expect(changedFields(row, applyChanges(row, none))).toEqual([])
    expect(changedFields(row, { ...row, amount: '3500.00' })).toEqual([])
    expect(
      changedFields({ ...row, amount: '1500000.50' }, { ...row, amount: '1500000.5' }),
    ).toEqual([])
    expect(changedFields(row, { ...row, currency: 'USD' })).toEqual(['money'])
    expect(
      changedFields(row, {
        ...row,
        amount: '1',
        date: '2026-11-19',
        category: 'otros',
        payment: null,
      }),
    ).toEqual(['money', 'date', 'category', 'payment'])
    expect(changedFields(row, { ...row, description: 'cafecito' })).toEqual(['description'])
  })
})

describe('text helpers', () => {
  it('normalizes accents and case; canonicalizes amounts', () => {
    expect(normalizeText('  Crédito ÑU ')).toBe('credito nu')
    expect(canonicalAmount('3500.50')).toBe('3500.5')
    expect(canonicalAmount('3500.00')).toBe('3500')
  })
})
