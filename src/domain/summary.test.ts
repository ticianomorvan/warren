import { describe, expect, it } from 'vitest'
import { change, formatPercent, fromCents, toCents } from './summary'

describe('cents', () => {
  it('turn decimal strings into integers and back, exactly', () => {
    expect(toCents('12000')).toBe(1200000n)
    expect(toCents('4500.5')).toBe(450050n)
    expect(toCents('0.07')).toBe(7n)
    expect(toCents('9007199254740993.01')).toBe(900719925474099301n) // past a float's reach
    expect(fromCents(1200000n)).toBe('12000')
    expect(fromCents(450050n)).toBe('4500.50')
    expect(fromCents(7n)).toBe('0.07')
    expect(fromCents(900719925474099301n)).toBe('9007199254740993.01')
  })

  it('refuse what is not an amount of at most two decimals', () => {
    for (const bad of ['', '1.234', '-5', '1e3', 'abc', '1,5']) {
      expect(() => toCents(bad), bad).toThrow()
    }
  })
})

describe('change', () => {
  const pct = (now: string, before: string) => {
    const c = change(now, before)
    return c.tenths === null ? null : formatPercent(c.tenths)
  }

  it('is the difference and its share of what was before, in tenths of a percent', () => {
    expect(change('40800', '12000')).toEqual({ way: 'more', amount: '28800', tenths: 2400n })
    expect(change('50', '100')).toEqual({ way: 'less', amount: '50', tenths: -500n })
    expect(change('100', '100')).toEqual({ way: 'same', amount: '0', tenths: 0n })
    expect(change('0', '100')).toEqual({ way: 'less', amount: '100', tenths: -1000n })
    expect(change('1500.50', '1000')).toEqual({ way: 'more', amount: '500.50', tenths: 501n })
  })

  it('rounds to a tenth of a percent, half away from zero, the same in both directions', () => {
    expect(pct('4', '3')).toBe('+33,3%') // 33,33
    expect(pct('5', '3')).toBe('+66,7%') // 66,67
    expect(pct('2', '3')).toBe('-33,3%')
    // 0.01 of 0.16 is exactly 6,25%: a tie, which goes away from zero
    expect(pct('0.17', '0.16')).toBe('+6,3%')
    expect(pct('0.15', '0.16')).toBe('-6,3%')
    // 1 of 8 is exactly 12,5%: no rounding needed
    expect(pct('9', '8')).toBe('+12,5%')
    expect(pct('7', '8')).toBe('-12,5%')
    // a tie one tenth up: 1 of 400 is 0,25%
    expect(pct('401', '400')).toBe('+0,3%')
    expect(pct('399', '400')).toBe('-0,3%')
  })

  it('shows a whole percent without a comma, and a change too small to see as 0%', () => {
    expect(pct('120', '100')).toBe('+20%')
    expect(pct('80', '100')).toBe('-20%')
    expect(pct('100.00', '100')).toBe('0%')
    expect(pct('10000.01', '10000')).toBe('0%') // a cent: it rounds to 0%, the amount still says it moved
    expect(change('10000.01', '10000').way).toBe('more')
  })

  it('never divides by zero: with nothing before there is no percentage', () => {
    expect(change('500', '0')).toEqual({ way: 'more', amount: '500', tenths: null })
    expect(change('0', '0')).toEqual({ way: 'same', amount: '0', tenths: null })
    expect(change('0.00', '0.00').tenths).toBeNull()
  })

  it('is exact on amounts a float cannot hold', () => {
    expect(change('9007199254740993', '9007199254740992')).toMatchObject({
      way: 'more',
      amount: '1',
    })
    expect(change('0.30', '0.10')).toEqual({ way: 'more', amount: '0.20', tenths: 2000n }) // 0.3 - 0.1 is not 0.2 in floats
  })
})

describe('formatPercent', () => {
  it('writes the sign, and the Argentine decimal comma only when there is a decimal', () => {
    expect(formatPercent(0n)).toBe('0%')
    expect(formatPercent(1000n)).toBe('+100%')
    expect(formatPercent(-1000n)).toBe('-100%')
    expect(formatPercent(5n)).toBe('+0,5%')
    expect(formatPercent(-55n)).toBe('-5,5%')
    expect(formatPercent(12345n)).toBe('+1234,5%')
  })
})
