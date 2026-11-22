import { describe, expect, it } from 'vitest'
import { PERIODS, type RangeInput } from '../agent/schema'
import { argentinaToday } from '../time'
import {
  MAX_RANGE_DAYS,
  parseOther,
  previousRange,
  type Resolved,
  rangeDays,
  resolveRange,
} from './range'

/** A range as the model sends it: unused fields at their empty values. */
const r = (period: string, o: Partial<RangeInput> = {}): RangeInput =>
  ({ period, month: 0, year: 0, from: '', to: '', ...o }) as RangeInput

const show = (x: Resolved) => `${x.from}..${x.to}${x.partial ? ' (en curso)' : ''} ${x.kind}`
const ok = (spec: RangeInput, today: string) => {
  const res = resolveRange(spec, today)
  if (!res.ok) throw new Error(`refused: ${res.reason}`)
  return show(res.range)
}
const why = (spec: RangeInput, today: string) => {
  const res = resolveRange(spec, today)
  return res.ok ? `ok ${show(res.range)}` : res.reason
}

// 2026-11-21 is a Saturday; 2026-11-16 is the Monday of its week.
const NOW = '2026-11-21'

describe('resolveRange: what people say, for a fixed Saturday 2026-11-21', () => {
  const phrases: [string, RangeInput, string][] = [
    ['hoy', r('today'), '2026-11-21..2026-11-21 day'],
    ['ayer', r('yesterday'), '2026-11-20..2026-11-20 day'],
    ['esta semana (cut at today)', r('this_week'), '2026-11-16..2026-11-21 (en curso) week'],
    ['la semana pasada', r('last_week'), '2026-11-09..2026-11-15 week'],
    ['el finde (a Saturday: so far)', r('weekend'), '2026-11-21..2026-11-21 (en curso) weekend'],
    ['el finde pasado', r('last_weekend'), '2026-11-14..2026-11-15 weekend'],
    ['este mes (cut at today)', r('this_month'), '2026-11-01..2026-11-21 (en curso) month'],
    ['el mes pasado', r('last_month'), '2026-10-01..2026-10-31 month'],
    ['en lo que va del año', r('this_year'), '2026-01-01..2026-11-21 (en curso) year'],
    ['el año pasado', r('last_year'), '2025-01-01..2025-12-31 year'],
    ['octubre (the last one)', r('month', { month: 10 }), '2026-10-01..2026-10-31 month'],
    [
      'noviembre (this one, so far)',
      r('month', { month: 11 }),
      '2026-11-01..2026-11-21 (en curso) month',
    ],
    [
      'diciembre (last year: this one has not started)',
      r('month', { month: 12 }),
      '2025-12-01..2025-12-31 month',
    ],
    ['febrero', r('month', { month: 2 }), '2026-02-01..2026-02-28 month'],
    ['octubre de 2025', r('month', { month: 10, year: 2025 }), '2025-10-01..2025-10-31 month'],
    [
      'febrero de 2024 (leap)',
      r('month', { month: 2, year: 2024 }),
      '2024-02-01..2024-02-29 month',
    ],
    ['2025', r('year', { year: 2025 }), '2025-01-01..2025-12-31 year'],
    ['2026', r('year', { year: 2026 }), '2026-01-01..2026-11-21 (en curso) year'],
    ['el 5', r('dates', { from: '5' }), '2026-11-05..2026-11-05 day'],
    ['el 25 (not yet this month)', r('dates', { from: '25' }), '2026-10-25..2026-10-25 day'],
    ['el 21 (today)', r('dates', { from: '21' }), '2026-11-21..2026-11-21 day'],
    ['el 31 (November has no 31)', r('dates', { from: '31' }), '2026-10-31..2026-10-31 day'],
    [
      'del 1 al 15 de noviembre',
      r('dates', { from: '11-01', to: '11-15' }),
      '2026-11-01..2026-11-15 custom',
    ],
    [
      'del 15 al 25 (the 25th is still to come: cut at today)',
      r('dates', { from: '15', to: '25' }),
      '2026-11-15..2026-11-21 (en curso) custom',
    ],
    [
      'del 20 al 5 (across a month end)',
      r('dates', { from: '20', to: '5' }),
      '2026-10-20..2026-11-05 custom',
    ],
    [
      'del 28 de diciembre al 3 de enero',
      r('dates', { from: '12-28', to: '01-03' }),
      '2025-12-28..2026-01-03 custom',
    ],
    ['el 5 de octubre', r('dates', { from: '10-05' }), '2026-10-05..2026-10-05 day'],
    ['el 1 de diciembre (last year)', r('dates', { from: '12-01' }), '2025-12-01..2025-12-01 day'],
    [
      'el 29 de febrero (the last leap day)',
      r('dates', { from: '02-29' }),
      '2024-02-29..2024-02-29 day',
    ],
    [
      'explicit days',
      r('dates', { from: '2026-03-01', to: '2026-03-31' }),
      '2026-03-01..2026-03-31 month',
    ],
    [
      'explicit, past today: cut',
      r('dates', { from: '2026-11-01', to: '2026-11-30' }),
      '2026-11-01..2026-11-21 (en curso) month',
    ],
    [
      'explicit, a whole year as days',
      r('dates', { from: '2025-01-01', to: '2025-12-31' }),
      '2025-01-01..2025-12-31 year',
    ],
    [
      'a stretch of days',
      r('dates', { from: '2026-10-17', to: '2026-10-31' }),
      '2026-10-17..2026-10-31 custom',
    ],
  ]
  for (const [phrase, spec, expected] of phrases) {
    it(phrase, () => expect(ok(spec, NOW)).toBe(expected))
  }
})

describe('resolveRange: the day of the week and of the month decide', () => {
  it('"el finde" and "el finde pasado" for each day of a week', () => {
    // 2026-11-14 Sat .. 2026-11-20 Fri, then the next Sat and Sun
    const table: [string, string, string][] = [
      ['2026-11-16', 'Mon', '2026-11-14..2026-11-15'],
      ['2026-11-17', 'Tue', '2026-11-14..2026-11-15'],
      ['2026-11-20', 'Fri', '2026-11-14..2026-11-15'],
    ]
    for (const [today, , expected] of table) {
      expect(ok(r('weekend'), today)).toBe(`${expected} weekend`)
      expect(ok(r('last_weekend'), today)).toBe(`${expected} weekend`)
    }
    expect(ok(r('weekend'), '2026-11-21')).toBe('2026-11-21..2026-11-21 (en curso) weekend')
    expect(ok(r('weekend'), '2026-11-22')).toBe('2026-11-21..2026-11-22 weekend') // a Sunday: whole
    expect(ok(r('last_weekend'), '2026-11-22')).toBe('2026-11-14..2026-11-15 weekend')
  })

  it('"el 5" is this month\'s unless that is still to come', () => {
    expect(ok(r('dates', { from: '5' }), '2026-11-03')).toBe('2026-10-05..2026-10-05 day')
    expect(ok(r('dates', { from: '5' }), '2026-11-05')).toBe('2026-11-05..2026-11-05 day')
    expect(ok(r('dates', { from: '5' }), '2026-01-03')).toBe('2025-12-05..2025-12-05 day')
    expect(ok(r('dates', { from: '31' }), '2026-03-01')).toBe('2026-01-31..2026-01-31 day') // no 31 February
  })

  it('"octubre" is the last October that has started', () => {
    expect(ok(r('month', { month: 10 }), '2026-10-01')).toBe(
      '2026-10-01..2026-10-01 (en curso) month',
    )
    expect(ok(r('month', { month: 10 }), '2026-09-30')).toBe('2025-10-01..2025-10-31 month')
    expect(ok(r('month', { month: 1 }), '2027-01-01')).toBe(
      '2027-01-01..2027-01-01 (en curso) month',
    )
  })

  it('"29 de febrero" is the last leap day, across the century rule', () => {
    expect(ok(r('dates', { from: '02-29' }), '2028-03-01')).toBe('2028-02-29..2028-02-29 day')
    expect(ok(r('dates', { from: '02-29' }), '2028-02-28')).toBe('2024-02-29..2024-02-29 day')
    expect(ok(r('dates', { from: '02-29' }), '2100-03-01')).toBe('2096-02-29..2096-02-29 day')
  })

  it('weeks and months turn over at Argentine midnight, not at UTC midnight', () => {
    const lateNovember = argentinaToday(new Date('2026-12-01T02:59:59Z')) // 23:59 on Nov 30 in Buenos Aires
    const earlyDecember = argentinaToday(new Date('2026-12-01T03:00:00Z'))
    expect(ok(r('this_month'), lateNovember)).toBe('2026-11-01..2026-11-30 month')
    expect(ok(r('this_month'), earlyDecember)).toBe('2026-12-01..2026-12-01 (en curso) month')
    expect(ok(r('yesterday'), earlyDecember)).toBe('2026-11-30..2026-11-30 day')
    expect(ok(r('today'), lateNovember)).toBe('2026-11-30..2026-11-30 day')
    // 2026-11-22 23:59 is still the Sunday of the week; one minute later it is the next Monday.
    expect(ok(r('this_week'), argentinaToday(new Date('2026-11-23T02:59:00Z')))).toBe(
      '2026-11-16..2026-11-22 week',
    )
    expect(ok(r('this_week'), argentinaToday(new Date('2026-11-23T03:00:00Z')))).toBe(
      '2026-11-23..2026-11-23 (en curso) week',
    )
  })

  it('a week and a month can cross a year, and a leap February has its 29th', () => {
    expect(ok(r('last_week'), '2027-01-04')).toBe('2026-12-28..2027-01-03 week')
    expect(ok(r('this_week'), '2027-01-01')).toBe('2026-12-28..2027-01-01 (en curso) week')
    expect(ok(r('last_month'), '2027-01-15')).toBe('2026-12-01..2026-12-31 month')
    expect(ok(r('last_month'), '2028-03-10')).toBe('2028-02-01..2028-02-29 month')
    expect(ok(r('last_month'), '2026-03-10')).toBe('2026-02-01..2026-02-28 month')
  })
})

describe('resolveRange: refusals, with the reason the model sees', () => {
  it('a range that has not started', () => {
    expect(why(r('month', { month: 12, year: 2026 }), NOW)).toContain(
      'has not started yet: today is 2026-11-21',
    )
    expect(why(r('month', { month: 1, year: 2027 }), NOW)).toContain('has not started')
    expect(why(r('year', { year: 2027 }), NOW)).toContain('has not started')
    expect(why(r('dates', { from: '2026-11-22', to: '2026-11-30' }), NOW)).toContain(
      'has not started',
    )
    expect(why(r('dates', { from: '2027-02-01' }), NOW)).toContain('has not started')
    expect(why(r('dates', { from: '2026-11-22' }), NOW)).toContain('Nothing is stored for it')
  })

  it('a reversed range', () => {
    expect(why(r('dates', { from: '2026-11-15', to: '2026-11-10' }), NOW)).toContain(
      'is reversed: it starts on 2026-11-15 and ends on 2026-11-10',
    )
    expect(why(r('dates', { from: '11-20', to: '11-05' }), NOW)).toContain('is reversed')
  })

  it('a range over two years, and the most that is allowed', () => {
    expect(why(r('dates', { from: '2024-01-01', to: '2026-01-01' }), NOW)).toContain(
      'the most is 731',
    )
    expect(rangeDays({ from: '2024-11-20', to: '2026-11-20' })).toBe(MAX_RANGE_DAYS)
    expect(ok(r('dates', { from: '2024-11-20', to: '2026-11-20' }), NOW)).toBe(
      '2024-11-20..2026-11-20 custom',
    )
    expect(why(r('dates', { from: '2024-11-19', to: '2026-11-20' }), NOW)).toContain(
      'the most is 731',
    )
  })

  it('parts that make no sense', () => {
    expect(why(r('month', { month: 13 }), NOW)).toContain('1 to 12')
    expect(why(r('month', { month: 0 }), NOW)).toContain('1 to 12')
    expect(why(r('year'), NOW)).toContain('needs the year')
    expect(why(r('dates'), NOW)).toContain('needs from')
    expect(why(r('dates', { from: '2026-02-30' }), NOW)).toContain('not a real day')
    expect(why(r('dates', { from: '2027-02-29' }), NOW)).toContain('not a real day')
    expect(why(r('dates', { from: '02-30' }), NOW)).toContain('not a real day')
    expect(why(r('dates', { from: '32' }), NOW)).toContain('not a real day')
    expect(why(r('dates', { from: 'ayer' }), NOW)).toContain('not a date')
    expect(why(r('dates', { from: '5', to: 'mañana' }), NOW)).toContain('not a date')
  })

  it('a field the period does not use must be empty: a stray one is a misread question', () => {
    expect(why(r('this_month', { month: 10 }), NOW)).toContain('takes no month')
    expect(why(r('today', { year: 2025 }), NOW)).toContain('takes no year')
    expect(why(r('last_week', { from: '5' }), NOW)).toContain('takes no from')
    expect(why(r('month', { month: 10, from: '5' }), NOW)).toContain('takes no from')
    expect(why(r('dates', { from: '5', year: 2025 }), NOW)).toContain('takes no year')
    expect(why(r('dates', { from: '5', month: 3 }), NOW)).toContain('takes no month')
  })

  it('every period the schema offers resolves, from not after to, never past today', () => {
    const spec = (p: string) =>
      r(
        p,
        p === 'month'
          ? { month: 10 }
          : p === 'year'
            ? { year: 2025 }
            : p === 'dates'
              ? { from: '5' }
              : {},
      )
    for (const p of PERIODS) {
      const res = resolveRange(spec(p), NOW)
      expect(res.ok, p).toBe(true)
      if (res.ok) {
        expect(res.range.from <= res.range.to, p).toBe(true)
        expect(res.range.to <= NOW, p).toBe(true)
      }
    }
  })
})

describe('previousRange', () => {
  const prior = (spec: RangeInput, today = NOW) => {
    const res = resolveRange(spec, today)
    if (!res.ok) throw new Error(res.reason)
    return show(previousRange(res.range))
  }

  it('a month that is over goes to the previous calendar month, whole', () => {
    expect(prior(r('last_month'))).toBe('2026-09-01..2026-09-30 month')
    expect(prior(r('last_month'), '2026-10-10')).toBe('2026-08-01..2026-08-31 month') // September is shorter than August
    expect(prior(r('last_month'), '2026-03-10')).toBe('2026-01-01..2026-01-31 month')
    expect(prior(r('month', { month: 10 }))).toBe('2026-09-01..2026-09-30 month')
    expect(prior(r('month', { month: 3 }), '2026-04-10')).toBe('2026-02-01..2026-02-28 month')
    expect(prior(r('month', { month: 3 }), '2028-04-10')).toBe('2028-02-01..2028-02-29 month')
    expect(prior(r('month', { month: 1 }), '2026-02-15')).toBe('2025-12-01..2025-12-31 month')
    expect(prior(r('dates', { from: '2026-10-01', to: '2026-10-31' }))).toBe(
      '2026-09-01..2026-09-30 month',
    )
  })

  it('a month in progress is compared with the same stretch of the previous one', () => {
    expect(prior(r('this_month'))).toBe('2026-10-01..2026-10-21 month') // 1–21 Nov against 1–21 Oct
    expect(prior(r('this_month'), '2026-11-01')).toBe('2026-10-01..2026-10-01 month')
    expect(prior(r('month', { month: 1 }), '2026-01-15')).toBe('2025-12-01..2025-12-15 month')
    expect(prior(r('this_month'), '2026-12-31')).toBe('2026-11-01..2026-11-30 month') // the last day: the month is whole
  })

  it('the stretch is clamped to the last day of a shorter month, leap years included', () => {
    expect(prior(r('this_month'), '2026-03-28')).toBe('2026-02-01..2026-02-28 month')
    expect(prior(r('this_month'), '2026-03-29')).toBe('2026-02-01..2026-02-28 month')
    expect(prior(r('this_month'), '2026-03-30')).toBe('2026-02-01..2026-02-28 month')
    expect(prior(r('this_month'), '2026-03-31')).toBe('2026-02-01..2026-02-28 month')
    expect(prior(r('this_month'), '2028-03-28')).toBe('2028-02-01..2028-02-28 month')
    expect(prior(r('this_month'), '2028-03-29')).toBe('2028-02-01..2028-02-29 month')
    expect(prior(r('this_month'), '2028-03-31')).toBe('2028-02-01..2028-02-29 month')
    expect(prior(r('this_month'), '2026-05-31')).toBe('2026-04-01..2026-04-30 month')
    expect(prior(r('this_month'), '2026-07-30')).toBe('2026-06-01..2026-06-30 month')
    expect(prior(r('this_month'), '2026-08-31')).toBe('2026-07-01..2026-07-31 month')
  })

  it('a week in progress is compared with the same weekdays of the week before; a week that is over, whole', () => {
    expect(prior(r('this_week'))).toBe('2026-11-09..2026-11-14 week') // Monday to Saturday
    expect(prior(r('this_week'), '2026-11-16')).toBe('2026-11-09..2026-11-09 week') // Monday only
    expect(prior(r('this_week'), '2026-11-22')).toBe('2026-11-09..2026-11-15 week') // Sunday: the week is whole
    expect(prior(r('last_week'))).toBe('2026-11-02..2026-11-08 week')
  })

  it('a weekend in progress is a Saturday against the Saturday before; a weekend that is over, whole', () => {
    expect(prior(r('weekend'))).toBe('2026-11-14..2026-11-14 weekend')
    expect(prior(r('weekend'), '2026-11-22')).toBe('2026-11-14..2026-11-15 weekend')
    expect(prior(r('last_weekend'))).toBe('2026-11-07..2026-11-08 weekend')
  })

  it('a day goes to the day before', () => {
    expect(prior(r('today'))).toBe('2026-11-20..2026-11-20 day')
    expect(prior(r('yesterday'), '2026-12-01')).toBe('2026-11-29..2026-11-29 day')
    expect(prior(r('today'), '2028-03-01')).toBe('2028-02-29..2028-02-29 day')
  })

  it('a year in progress is compared with the same days of the year before; a year that is over, whole', () => {
    expect(prior(r('this_year'))).toBe('2025-01-01..2025-11-21 year')
    expect(prior(r('this_year'), '2026-01-01')).toBe('2025-01-01..2025-01-01 year')
    expect(prior(r('this_year'), '2028-02-29')).toBe('2027-01-01..2027-02-28 year') // 29 February: clamped
    expect(prior(r('this_year'), '2029-02-28')).toBe('2028-01-01..2028-02-28 year')
    expect(prior(r('this_year'), '2026-12-31')).toBe('2025-01-01..2025-12-31 year')
    expect(prior(r('last_year'))).toBe('2024-01-01..2024-12-31 year')
    expect(prior(r('year', { year: 2025 }))).toBe('2024-01-01..2024-12-31 year')
  })

  it('a custom range to the same number of days right before it', () => {
    expect(prior(r('dates', { from: '2026-11-01', to: '2026-11-15' }))).toBe(
      '2026-10-17..2026-10-31 custom',
    )
    expect(prior(r('dates', { from: '2026-11-05' }))).toBe('2026-11-04..2026-11-04 day')
    expect(prior(r('dates', { from: '2026-03-02', to: '2026-03-04' }))).toBe(
      '2026-02-27..2026-03-01 custom',
    )
    expect(prior(r('dates', { from: '2028-03-02', to: '2028-03-03' }), '2028-03-10')).toBe(
      '2028-02-29..2028-03-01 custom',
    )
  })
})

describe('parseOther: the second range of a comparison, written as a short text', () => {
  const parsed = (text: string) => {
    const spec = parseOther(text)
    return typeof spec === 'string' ? spec : ok(spec, NOW)
  }

  it('a named period, a month with or without its year, a year, and days', () => {
    expect(parsed('last_month')).toBe('2026-10-01..2026-10-31 month')
    expect(parsed(' This_Week ')).toBe('2026-11-16..2026-11-21 (en curso) week')
    expect(parsed('month:10')).toBe('2026-10-01..2026-10-31 month')
    expect(parsed('month:2:2024')).toBe('2024-02-01..2024-02-29 month')
    expect(parsed('year:2025')).toBe('2025-01-01..2025-12-31 year')
    expect(parsed('dates:11-01..11-15')).toBe('2026-11-01..2026-11-15 custom')
    expect(parsed('dates:5')).toBe('2026-11-05..2026-11-05 day')
    expect(parsed('dates:2026-10-17..2026-10-31')).toBe('2026-10-17..2026-10-31 custom')
  })

  it('anything else comes back as the reason, with the forms that are allowed', () => {
    for (const bad of [
      '',
      'octubre',
      'month:',
      'month:ten',
      'month:10:2025:1',
      'year:',
      'year:2025:1',
      'dates:',
      'dates:1..2..3',
      'forever',
      'month10',
    ]) {
      expect(parseOther(bad), bad).toEqual(expect.stringContaining('is not understood'))
    }
  })

  it('a form that parses but is not a real range is refused when it is resolved', () => {
    expect(why(parseOther('month:13') as RangeInput, NOW)).toContain('1 to 12')
    expect(why(parseOther('month:12:2026') as RangeInput, NOW)).toContain('has not started')
    expect(why(parseOther('dates:2026-11-10..2026-11-02') as RangeInput, NOW)).toContain(
      'is reversed',
    )
  })
})

describe('resolveRange: days whose end has not come yet are cut at today (review of slice D)', () => {
  it('"del 1 al 15 de noviembre" asked before the 15th is this month so far, not last year', () => {
    expect(ok(r('dates', { from: '11-01', to: '11-15' }), '2026-11-12')).toBe(
      '2026-11-01..2026-11-12 (en curso) custom',
    )
    expect(ok(r('dates', { from: '11-01', to: '11-15' }), '2026-11-15')).toBe(
      '2026-11-01..2026-11-15 custom',
    )
    expect(ok(r('dates', { from: '11-21', to: '11-25' }), NOW)).toBe(
      '2026-11-21..2026-11-21 (en curso) custom',
    )
    expect(ok(r('dates', { from: '11-01', to: '11-30' }), NOW)).toBe(
      '2026-11-01..2026-11-21 (en curso) month',
    )
    expect(ok(r('dates', { from: '01-01', to: '12-31' }), NOW)).toBe(
      '2026-01-01..2026-11-21 (en curso) year',
    )
  })

  it('a start that has not come is refused whatever the end', () => {
    // the latest 25 November that is not in the future is last year's: the whole range is last year's
    expect(ok(r('dates', { from: '11-25', to: '11-30' }), NOW)).toBe(
      '2025-11-25..2025-11-30 custom',
    )
    expect(why(r('dates', { from: '2026-11-25', to: '2026-11-30' }), NOW)).toContain(
      'has not started',
    )
  })

  it('a range across the end of a month or a year still wraps, and the same month backwards is refused', () => {
    expect(ok(r('dates', { from: '20', to: '5' }), NOW)).toBe('2026-10-20..2026-11-05 custom')
    expect(ok(r('dates', { from: '12-28', to: '01-03' }), NOW)).toBe(
      '2025-12-28..2026-01-03 custom',
    )
    expect(why(r('dates', { from: '11-20', to: '11-05' }), NOW)).toContain('is reversed')
  })

  it('a full start with a partial end goes forward to the first such day', () => {
    expect(ok(r('dates', { from: '2026-10-20', to: '5' }), NOW)).toBe(
      '2026-10-20..2026-11-05 custom',
    )
    expect(ok(r('dates', { from: '2026-11-20', to: '5' }), NOW)).toBe(
      '2026-11-20..2026-11-21 (en curso) custom',
    )
  })
})

describe('resolveRange: years that are not years', () => {
  it('a year below 2000 or past 2200 is not a day, so nothing reaches the database or addDays', () => {
    for (const from of ['0001-01-01', '1999-12-31', '0025-03-01', '2201-01-01']) {
      expect(why(r('dates', { from, to: from }), NOW), from).toContain('not a real day')
    }
  })

  it('a year is always four digits in the days it returns', () => {
    const res = resolveRange(r('dates', { from: '2000-01-01', to: '2000-01-03' }), NOW)
    expect(res.ok && res.range.from).toBe('2000-01-01')
  })
})
