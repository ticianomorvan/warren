import { describe, expect, it } from 'vitest'
import { PERIODS } from './parse/schema'
import { addDays, argentinaToday, periodRange } from './time'

describe('argentinaToday', () => {
  it('turns over at 03:00 UTC, midnight in Buenos Aires', () => {
    expect(argentinaToday(new Date('2026-12-01T02:59:59Z'))).toBe('2026-11-30')
    expect(argentinaToday(new Date('2026-12-01T03:00:00Z'))).toBe('2026-12-01')
    expect(argentinaToday(new Date('2027-01-01T02:59:59Z'))).toBe('2026-12-31')
  })
})

describe('periodRange', () => {
  const range = (period: (typeof PERIODS)[number], today: string) => {
    const { from, to } = periodRange(period, today)
    return `${from}..${to}`
  }

  it('today and yesterday are one day, across a month and a year', () => {
    expect(range('today', '2026-11-20')).toBe('2026-11-20..2026-11-20')
    expect(range('yesterday', '2026-11-20')).toBe('2026-11-19..2026-11-19')
    expect(range('yesterday', '2026-12-01')).toBe('2026-11-30..2026-11-30')
    expect(range('yesterday', '2027-01-01')).toBe('2026-12-31..2026-12-31')
  })

  it('weeks run Monday to Sunday, whole', () => {
    // 2026-11-16 is a Monday, 2026-11-22 a Sunday.
    expect(range('this_week', '2026-11-16')).toBe('2026-11-16..2026-11-22')
    expect(range('this_week', '2026-11-20')).toBe('2026-11-16..2026-11-22')
    expect(range('this_week', '2026-11-22')).toBe('2026-11-16..2026-11-22')
    expect(range('last_week', '2026-11-16')).toBe('2026-11-09..2026-11-15')
    expect(range('last_week', '2026-11-22')).toBe('2026-11-09..2026-11-15')
    expect(range('last_week', '2026-11-23')).toBe('2026-11-16..2026-11-22')
  })

  it('a week can cross a month and a year', () => {
    expect(range('this_week', '2027-01-01')).toBe('2026-12-28..2027-01-03')
    expect(range('last_week', '2027-01-04')).toBe('2026-12-28..2027-01-03')
    expect(range('this_week', '2026-12-02')).toBe('2026-11-30..2026-12-06')
  })

  it('months end on their own last day, leap years included', () => {
    expect(range('this_month', '2026-11-30')).toBe('2026-11-01..2026-11-30')
    expect(range('this_month', '2026-12-01')).toBe('2026-12-01..2026-12-31')
    expect(range('last_month', '2026-12-01')).toBe('2026-11-01..2026-11-30')
    expect(range('last_month', '2027-01-01')).toBe('2026-12-01..2026-12-31')
    expect(range('last_month', '2026-03-01')).toBe('2026-02-01..2026-02-28')
    expect(range('last_month', '2028-03-01')).toBe('2028-02-01..2028-02-29')
  })

  it('a year is the calendar year', () => {
    expect(range('this_year', '2026-12-31')).toBe('2026-01-01..2026-12-31')
    expect(range('this_year', '2027-01-01')).toBe('2027-01-01..2027-12-31')
  })

  it('follows the Argentine day, not the UTC day, at the month boundary', () => {
    const lateNovember = argentinaToday(new Date('2026-12-01T02:30:00Z')) // 23:30 on Nov 30 in Buenos Aires
    expect(range('this_month', lateNovember)).toBe('2026-11-01..2026-11-30')
    const earlyDecember = argentinaToday(new Date('2026-12-01T03:30:00Z'))
    expect(range('this_month', earlyDecember)).toBe('2026-12-01..2026-12-31')
  })

  it('has a range for every period, from not after to, and today inside the current ones', () => {
    for (const period of PERIODS) {
      const { from, to } = periodRange(period, '2026-11-20')
      expect(from <= to).toBe(true)
    }
    for (const period of ['today', 'this_week', 'this_month', 'this_year'] as const) {
      const { from, to } = periodRange(period, '2026-11-20')
      expect(from <= '2026-11-20' && '2026-11-20' <= to).toBe(true)
    }
  })
})

describe('addDays', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})
