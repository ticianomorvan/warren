import { describe, expect, it } from 'vitest'
import { foldMerchant, monthRange, parseAmount, parseMonth, parseRule, shiftMonth } from '../src'

// Invented identifiers with valid check digits.
const CBU = '0720099122000007654329'
const CUIT = '20111111112'

describe('foldMerchant', () => {
  it.each([
    ['Café Ñandú', 'cafe nandu'],
    ['  CAFE   NANDU\t', 'cafe nandu'],
    ['Café Nandú', 'cafe nandu'],
    ['COMERCIO DE EJEMPLO SRL', 'comercio de ejemplo srl'],
    ['Ünïcode Çà', 'unicode ca'],
  ])('folds %j to %j', (input, expected) => {
    expect(foldMerchant(input)).toBe(expected)
  })
})

describe('parseRule', () => {
  it('keeps a valid account and tax id, and folds a merchant', () => {
    expect(parseRule({ scheme: 'counterparty-account', value: CBU, class: 'fixed' })).toEqual({
      ok: true,
      rule: { scheme: 'counterparty-account', value: CBU, class: 'fixed' },
    })
    expect(
      parseRule({ scheme: 'counterparty-tax-id', value: '20-11111111-2', class: 'excluded' }),
    ).toEqual({
      ok: true,
      rule: { scheme: 'counterparty-tax-id', value: CUIT, class: 'excluded' },
    })
    expect(parseRule({ scheme: 'merchant', value: ' Café  Ñandú ', class: 'allowance' })).toEqual({
      ok: true,
      rule: { scheme: 'merchant', value: 'cafe nandu', class: 'allowance' },
    })
  })

  it.each([
    [{ scheme: 'category', value: 'x', class: 'fixed' }, 'scheme'],
    [{ scheme: 'merchant', value: 'x', class: 'savings' }, 'class'],
    [{ scheme: 'merchant', value: '   ', class: 'fixed' }, 'value'],
    [{ scheme: 'merchant', value: 'x'.repeat(121), class: 'fixed' }, 'value'],
    [{ scheme: 'merchant', class: 'fixed' }, 'value'],
    [{ scheme: 'counterparty-account', value: '0720099122000007654320', class: 'fixed' }, 'value'],
    [{ scheme: 'counterparty-tax-id', value: '20111111113', class: 'fixed' }, 'value'],
    [null, 'scheme'],
  ])('refuses %j with %s', (input, issue) => {
    expect(parseRule(input)).toEqual({ ok: false, issue })
  })
})

describe('money and months', () => {
  it('takes the profile amount shape', () => {
    expect(parseAmount('1500.50')).toBe('1500.50')
    for (const bad of ['0', '0.00', '-1', '1,5', '1.234', '01', 15, '', '1e3']) {
      expect(parseAmount(bad)).toBeNull()
    }
  })

  it('computes month ranges and shifts across years', () => {
    expect(monthRange(2028, 2)).toEqual({ month: '2028-02', from: '2028-02-01', to: '2028-02-29' })
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
    expect(parseMonth('2026-13')).toBeNull()
    expect(parseMonth('2026-11')).toEqual({ year: 2026, month: 11 })
  })
})
