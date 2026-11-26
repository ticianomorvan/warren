import { describe, expect, it } from 'vitest'
import { capitalize, clock, list, money, shortDate, weekdayOf } from './es'

describe('es', () => {
  it('money: Argentine form, never a float', () => {
    expect(money('3500', 'ARS')).toBe('$3.500')
    expect(money('1234.5', 'ARS')).toBe('$1.234,50')
    expect(money('1234.00', 'ARS')).toBe('$1.234')
    expect(money('03500', 'ARS')).toBe('$3.500')
    expect(money('1500000', 'ARS')).toBe('$1.500.000')
    expect(money('0.50', 'ARS')).toBe('$0,50')
    expect(money('20', 'USD')).toBe('US$ 20')
  })

  it('the one short date: 05/12, and /25 outside the current year', () => {
    expect(shortDate('2026-12-05', '2026-11-20')).toBe('05/12')
    expect(shortDate('2026-01-31', '2026-11-20')).toBe('31/01')
    expect(shortDate('2027-01-04', '2026-11-20')).toBe('04/01/27')
    expect(shortDate('2025-12-28', '2026-11-20')).toBe('28/12/25')
  })

  it('lists, weekdays, the clock and capitals', () => {
    expect(list([])).toBe('')
    expect(list(['a'])).toBe('a')
    expect(list(['a', 'b'])).toBe('a y b')
    expect(list(['a', 'b', 'c'])).toBe('a, b y c')
    expect(weekdayOf('2026-11-22')).toBe('domingo')
    expect(weekdayOf('2026-11-25')).toBe('miércoles')
    expect(clock(new Date('2026-11-20T15:05:00Z'))).toBe('12:05')
    expect(capitalize('café')).toBe('Café')
  })
})
