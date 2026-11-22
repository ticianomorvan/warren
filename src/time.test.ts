import { describe, expect, it } from 'vitest'
import { addDays, argentinaTime, argentinaToday } from './time'

describe('argentinaToday', () => {
  it('turns over at 03:00 UTC, midnight in Buenos Aires', () => {
    expect(argentinaToday(new Date('2026-12-01T02:59:59Z'))).toBe('2026-11-30')
    expect(argentinaToday(new Date('2026-12-01T03:00:00Z'))).toBe('2026-12-01')
    expect(argentinaToday(new Date('2027-01-01T02:59:59Z'))).toBe('2026-12-31')
  })
})

describe('addDays', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('argentinaTime', () => {
  it('is the Buenos Aires wall clock, whatever the UTC hour', () => {
    expect(argentinaTime(new Date('2026-12-01T02:30:00Z'))).toBe('23:30')
    expect(argentinaTime(new Date('2026-12-01T03:05:00Z'))).toBe('00:05')
    expect(argentinaTime(new Date('2026-11-21T15:00:00Z'))).toBe('12:00')
  })
})
