import { describe, expect, it } from 'vitest'
import { timeLeft } from '../src/time/time-left'

// Noon in Buenos Aires (UTC-3), so the Argentine day is the one named.
const at = (day: string) => new Date(`${day}T12:00:00-03:00`)
const left = (today: string, date: string) => timeLeft(at(today), date)

describe('timeLeft', () => {
  it('counts calendar months, then days', () => {
    expect(left('2026-11-19', '2027-06-01')).toEqual({
      days_left: 194,
      time_left: '6 months, 13 days',
    })
    expect(left('2026-11-19', '2027-11-19')).toEqual({ days_left: 365, time_left: '12 months' })
    expect(left('2026-11-19', '2026-11-20')).toEqual({ days_left: 1, time_left: '1 day' })
    expect(left('2026-11-19', '2026-12-19')).toEqual({ days_left: 30, time_left: '1 month' })
  })

  it('says today for the same day, including near midnight in Argentina', () => {
    expect(left('2026-11-19', '2026-11-19')).toEqual({ days_left: 0, time_left: 'today' })
    // 01:00 UTC on the 20th is still the 19th in Buenos Aires.
    expect(timeLeft(new Date('2026-11-20T01:00:00Z'), '2026-11-19').time_left).toBe('today')
    expect(timeLeft(new Date('2026-11-20T03:00:00Z'), '2026-11-19').time_left).toBe(
      'overdue by 1 day',
    )
  })

  it('clamps at month end: Jan 31 to Feb 28 is one month', () => {
    expect(left('2027-01-31', '2027-02-28')).toEqual({ days_left: 28, time_left: '1 month' })
    expect(left('2027-01-31', '2027-02-27')).toEqual({ days_left: 27, time_left: '27 days' })
    expect(left('2027-01-31', '2027-03-01')).toEqual({ days_left: 29, time_left: '1 month, 1 day' })
    expect(left('2027-01-30', '2027-03-30')).toEqual({ days_left: 59, time_left: '2 months' })
  })

  it('handles leap years', () => {
    expect(left('2028-01-31', '2028-02-29')).toEqual({ days_left: 29, time_left: '1 month' })
    expect(left('2028-02-28', '2028-02-29')).toEqual({ days_left: 1, time_left: '1 day' })
    expect(left('2028-02-29', '2029-02-28')).toEqual({ days_left: 365, time_left: '12 months' })
    expect(left('2027-02-28', '2028-02-29')).toEqual({
      days_left: 366,
      time_left: '12 months, 1 day',
    })
  })

  it('reports a past date as overdue, with negative days', () => {
    expect(left('2026-11-19', '2026-08-17')).toEqual({
      days_left: -94,
      time_left: 'overdue by 3 months, 2 days',
    })
    expect(left('2026-11-19', '2026-10-19')).toEqual({
      days_left: -31,
      time_left: 'overdue by 1 month',
    })
    expect(left('2027-03-01', '2027-01-31')).toEqual({
      days_left: -29,
      time_left: 'overdue by 1 month, 1 day',
    })
  })

  it('refuses what is not a date', () => {
    expect(() => timeLeft(at('2026-11-19'), '19/11/2027')).toThrow()
  })
})
