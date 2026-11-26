import { describe, expect, it } from 'vitest'
import { WEEKDAYS, type Weekday } from '../../core/es'
import { argentinaTime, argentinaToday } from '../../time'
import {
  type First,
  nextOccurrence,
  normalizeSchedule,
  resolveFirst,
  ScheduleSchema,
} from './schedule'

type Input = Parameters<typeof ScheduleSchema.parse>[0]
const make = (input: Input) => ScheduleSchema.parse(input)
/** An Argentine local moment as an instant: 2026-11-24 09:00 is 12:00 UTC. */
const at = (local: string) => new Date(`${local.replace(' ', 'T')}:00-03:00`)
const local = (d: Date) => `${argentinaToday(d)} ${argentinaTime(d)}`

/** The next `n` occurrences after `from` (a local moment), as local moments. */
function series(input: Input, from: string, n: number): string[] {
  const schedule = make(input)
  const out: string[] = []
  let after = at(from)
  for (let i = 0; i < n; i++) {
    const next = nextOccurrence(schedule, after)
    if (!next) break
    out.push(local(next))
    after = next
  }
  return out
}

describe('schedule parsing', () => {
  it('defaults the time to 09:00 and the interval to 1', () => {
    expect(make({ start: '2026-11-24' })).toEqual({
      start: '2026-11-24',
      time: '09:00',
      interval: 1,
    })
  })

  it.each([
    ['a date that does not exist', { start: '2026-02-30' }],
    ['a start that is not a date at all', { start: 'nonsense' }],
    ['a bad time', { start: '2026-11-24', time: '24:00' }],
    ['an interval of 0', { start: '2026-11-24', every: 'day', interval: 0 }],
    ['an interval over 365', { start: '2026-11-24', every: 'day', interval: 366 }],
    ['weekdays on a monthly schedule', { start: '2026-11-24', every: 'month', weekdays: ['mon'] }],
    ['month_days on a weekly schedule', { start: '2026-11-24', every: 'week', month_days: [1] }],
    [
      'nth on a weekly schedule',
      { start: '2026-11-24', every: 'week', nth: { n: 1, weekday: 'mon' } },
    ],
    ['month on a monthly schedule', { start: '2026-11-24', every: 'month', month: 3 }],
    [
      'month_days and nth together',
      { start: '2026-11-24', every: 'month', month_days: [1], nth: { n: 1, weekday: 'mon' } },
    ],
    ['day 0', { start: '2026-11-24', every: 'month', month_days: [0] }],
    ['day 32', { start: '2026-11-24', every: 'month', month_days: [32] }],
    ['a weekday twice', { start: '2026-11-24', every: 'week', weekdays: ['mon', 'mon'] }],
    ['no weekday at all', { start: '2026-11-24', every: 'week', weekdays: [] }],
    ['a stray field', { start: '2026-11-24', every: 'day', cron: '* * * * *' }],
    ['until before start', { start: '2026-11-24', every: 'day', until: '2026-11-23' }],
    ['count 0', { start: '2026-11-24', every: 'day', count: 0 }],
    ['an end on a one-off', { start: '2026-11-24', count: 2 }],
    ['an interval on a one-off', { start: '2026-11-24', interval: 2 }],
  ] as [string, Input][])('refuses %s', (_name, input) => {
    expect(ScheduleSchema.safeParse(input).success).toBe(false)
  })
})

describe('nextOccurrence: the examples of the spec', () => {
  it('once: its day and time, then nothing', () => {
    expect(series({ start: '2026-11-24', time: '18:30' }, '2026-11-22 10:00', 3)).toEqual([
      '2026-11-24 18:30',
    ])
  })

  it('a one-off already past has no occurrence', () => {
    expect(nextOccurrence(make({ start: '2026-11-20' }), at('2026-11-22 10:00'))).toBeNull()
  })

  it('is Argentine time: 09:00 is 12:00 UTC', () => {
    expect(
      nextOccurrence(make({ start: '2026-11-24' }), at('2026-11-22 10:00'))?.toISOString(),
    ).toBe('2026-11-24T12:00:00.000Z')
  })

  it('todos los días, from the start day, not before it', () => {
    expect(series({ start: '2026-11-24', every: 'day' }, '2026-11-01 00:00', 3)).toEqual([
      '2026-11-24 09:00',
      '2026-11-25 09:00',
      '2026-11-26 09:00',
    ])
  })

  it('todos los lunes y jueves', () => {
    // 2026-11-24 is a Tuesday.
    expect(
      series(
        { start: '2026-11-24', every: 'week', weekdays: ['mon', 'thu'] },
        '2026-11-22 00:00',
        5,
      ),
    ).toEqual([
      '2026-11-26 09:00',
      '2026-11-30 09:00',
      '2026-12-03 09:00',
      '2026-12-07 09:00',
      '2026-12-10 09:00',
    ])
  })

  it('every week with no weekday is the weekday of the start', () => {
    expect(series({ start: '2026-11-24', every: 'week' }, '2026-11-22 00:00', 3)).toEqual([
      '2026-11-24 09:00',
      '2026-12-01 09:00',
      '2026-12-08 09:00',
    ])
  })

  it('every 2 weeks on monday and friday counts weeks from the start week', () => {
    expect(
      series(
        { start: '2026-11-24', every: 'week', interval: 2, weekdays: ['mon', 'fri'] },
        '2026-11-22 00:00',
        4,
      ),
    ).toEqual(['2026-11-27 09:00', '2026-12-07 09:00', '2026-12-11 09:00', '2026-12-21 09:00'])
  })

  it('cada 15 días', () => {
    expect(
      series({ start: '2026-11-24', every: 'day', interval: 15 }, '2026-11-22 00:00', 4),
    ).toEqual(['2026-11-24 09:00', '2026-12-09 09:00', '2026-12-24 09:00', '2027-01-08 09:00'])
  })

  it('días hábiles: monday to friday, holidays included', () => {
    expect(
      series(
        {
          start: '2026-11-24',
          every: 'week',
          weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
          time: '08:00',
        },
        '2026-11-26 12:00',
        5,
      ),
    ).toEqual([
      '2026-11-27 08:00',
      '2026-11-30 08:00',
      '2026-12-01 08:00',
      '2026-12-02 08:00',
      '2026-12-03 08:00',
    ])
  })

  it('el 1 y el 15', () => {
    expect(
      series({ start: '2026-11-24', every: 'month', month_days: [15, 1] }, '2026-11-22 00:00', 4),
    ).toEqual(['2026-12-01 09:00', '2026-12-15 09:00', '2027-01-01 09:00', '2027-01-15 09:00'])
  })

  it('el 10 of every month: the first one on or after the start', () => {
    expect(
      series({ start: '2026-11-12', every: 'month', month_days: [10] }, '2026-11-01 00:00', 3),
    ).toEqual(['2026-12-10 09:00', '2027-01-10 09:00', '2027-02-10 09:00'])
    expect(
      series({ start: '2026-11-08', every: 'month', month_days: [10] }, '2026-11-01 00:00', 2),
    ).toEqual(['2026-11-10 09:00', '2026-12-10 09:00'])
  })

  it('el último día de cada mes (-1), leap year included', () => {
    expect(
      series({ start: '2028-01-01', every: 'month', month_days: [-1] }, '2027-12-31 12:00', 4),
    ).toEqual(['2028-01-31 09:00', '2028-02-29 09:00', '2028-03-31 09:00', '2028-04-30 09:00'])
  })

  it('day 31 in a short month lands on its last day', () => {
    expect(
      series({ start: '2027-01-01', every: 'month', month_days: [31] }, '2026-12-31 12:00', 5),
    ).toEqual([
      '2027-01-31 09:00',
      '2027-02-28 09:00',
      '2027-03-31 09:00',
      '2027-04-30 09:00',
      '2027-05-31 09:00',
    ])
  })

  it('days 30 and 31 in February are one day, sent once', () => {
    expect(
      series(
        { start: '2027-02-01', every: 'month', month_days: [30, 31, -1] },
        '2027-01-31 12:00',
        3,
      ),
    ).toEqual(['2027-02-28 09:00', '2027-03-30 09:00', '2027-03-31 09:00'])
  })

  it('a monthly schedule with no day is the day of the start (31 clamps)', () => {
    expect(series({ start: '2026-10-31', every: 'month' }, '2026-10-01 00:00', 4)).toEqual([
      '2026-10-31 09:00',
      '2026-11-30 09:00',
      '2026-12-31 09:00',
      '2027-01-31 09:00',
    ])
  })

  it('cada 2 meses el 10', () => {
    expect(
      series(
        { start: '2026-11-01', every: 'month', interval: 2, month_days: [10] },
        '2026-10-01 00:00',
        4,
      ),
    ).toEqual(['2026-11-10 09:00', '2027-01-10 09:00', '2027-03-10 09:00', '2027-05-10 09:00'])
  })

  it('el primer lunes de cada mes', () => {
    expect(
      series(
        { start: '2026-11-01', every: 'month', nth: { n: 1, weekday: 'mon' } },
        '2026-10-01 00:00',
        3,
      ),
    ).toEqual(['2026-11-02 09:00', '2026-12-07 09:00', '2027-01-04 09:00'])
  })

  it('el último viernes de cada mes', () => {
    expect(
      series(
        { start: '2026-11-01', every: 'month', nth: { n: -1, weekday: 'fri' } },
        '2026-10-01 00:00',
        3,
      ),
    ).toEqual(['2026-11-27 09:00', '2026-12-25 09:00', '2027-01-29 09:00'])
  })

  it('el cuarto jueves, when the month starts on a thursday', () => {
    // 2026-10-01 is a Thursday: the fourth is the 22nd.
    expect(
      series(
        { start: '2026-10-01', every: 'month', nth: { n: 4, weekday: 'thu' } },
        '2026-09-01 00:00',
        2,
      ),
    ).toEqual(['2026-10-22 09:00', '2026-11-26 09:00'])
  })

  it('cada 3 de abril', () => {
    expect(
      series(
        { start: '2026-11-22', every: 'year', month: 4, month_days: [3] },
        '2026-11-22 00:00',
        3,
      ),
    ).toEqual(['2027-04-03 09:00', '2028-04-03 09:00', '2029-04-03 09:00'])
  })

  it('every year with nothing else is the day of the start; 29 February lands on 28 in a common year', () => {
    expect(series({ start: '2028-02-29', every: 'year' }, '2028-01-01 00:00', 3)).toEqual([
      '2028-02-29 09:00',
      '2029-02-28 09:00',
      '2030-02-28 09:00',
    ])
  })

  it('every 2 years', () => {
    expect(
      series({ start: '2026-11-24', every: 'year', interval: 2 }, '2026-11-22 00:00', 3),
    ).toEqual(['2026-11-24 09:00', '2028-11-24 09:00', '2030-11-24 09:00'])
  })

  it('3 veces', () => {
    expect(series({ start: '2026-11-24', every: 'day', count: 3 }, '2026-11-01 00:00', 10)).toEqual(
      ['2026-11-24 09:00', '2026-11-25 09:00', '2026-11-26 09:00'],
    )
  })

  it('a count counts from the start, so it is the same wherever the sender left off', () => {
    const s = make({ start: '2026-11-24', every: 'day', count: 3 })
    expect(nextOccurrence(s, at('2026-11-25 09:00'))).toEqual(at('2026-11-26 09:00'))
    expect(nextOccurrence(s, at('2026-11-26 09:00'))).toBeNull()
  })

  it('until is the last day, inclusive of its time', () => {
    expect(
      series({ start: '2026-11-24', every: 'day', until: '2026-11-26' }, '2026-11-01 00:00', 10),
    ).toEqual(['2026-11-24 09:00', '2026-11-25 09:00', '2026-11-26 09:00'])
  })

  it('whichever of until and count comes first ends it', () => {
    expect(
      series(
        { start: '2026-11-24', every: 'day', until: '2026-11-30', count: 2 },
        '2026-11-01 00:00',
        10,
      ),
    ).toHaveLength(2)
  })

  it('is strictly after: an occurrence at `after` is not returned', () => {
    const s = make({ start: '2026-11-24', every: 'day' })
    expect(nextOccurrence(s, at('2026-11-24 09:00'))).toEqual(at('2026-11-25 09:00'))
    expect(nextOccurrence(s, new Date(at('2026-11-24 09:00').getTime() - 1))).toEqual(
      at('2026-11-24 09:00'),
    )
  })
})

// ---- property tests: a seeded random loop against an oracle written another way ----

/** A small seeded generator (mulberry32), so a failure replays. */
function rng(seed: number) {
  let a = seed
  const next = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T
  const some = <T>(xs: readonly T[], max: number): T[] => {
    const n = int(1, Math.min(max, xs.length))
    return [...xs].sort(() => next() - 0.5).slice(0, n)
  }
  return { next, int, pick, some }
}

const DAY_MS = 86_400_000
const dayNum = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS
const parts = (day: number) => {
  const d = new Date(day * DAY_MS)
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    wd: (d.getUTCDay() + 6) % 7,
  }
}
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** Does this day match the rule? Written by counting and comparing, not by generating. */
function matchesRule(s: ReturnType<typeof make>, day: number): boolean {
  const start = dayNum(s.start)
  if (day < start) return false
  if (s.every === undefined) return day === start
  const a = parts(start)
  const b = parts(day)
  const dayOfMonthOk = (list: readonly number[]) =>
    list.some((v) => (v === -1 ? b.d === dim(b.y, b.m) : Math.min(v, dim(b.y, b.m)) === b.d))
  switch (s.every) {
    case 'day':
      return (day - start) % s.interval === 0
    case 'week': {
      const weeks = (day - b.wd - (start - a.wd)) / 7
      const wds = s.weekdays ? s.weekdays.map((w) => WEEKDAYS.indexOf(w)) : [a.wd]
      return weeks % s.interval === 0 && wds.includes(b.wd)
    }
    case 'month': {
      const months = (b.y - a.y) * 12 + (b.m - a.m)
      if (months % s.interval !== 0) return false
      if (s.nth) {
        if (b.wd !== WEEKDAYS.indexOf(s.nth.weekday)) return false
        return s.nth.n > 0 ? Math.ceil(b.d / 7) === s.nth.n : b.d + 7 > dim(b.y, b.m)
      }
      return dayOfMonthOk(s.month_days ?? [a.d])
    }
    case 'year':
      return (
        (b.y - a.y) % s.interval === 0 &&
        b.m === (s.month ?? a.m) &&
        dayOfMonthOk(s.month_days ?? [a.d])
      )
  }
}

/** How many days from `start` to `day` (both inclusive) match: the position of `day` in the series. */
function position(s: ReturnType<typeof make>, day: number): number {
  let n = 0
  for (let d = dayNum(s.start); d <= day; d++) if (matchesRule(s, d)) n++
  return n
}

/** The instant of a day's occurrence: its local time, three hours behind UTC. */
const instantOf = (s: ReturnType<typeof make>, day: number) =>
  day * DAY_MS +
  (Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3))) * 60_000 +
  3 * 3_600_000

function randomSchedule(r: ReturnType<typeof rng>): Input {
  const start = new Date(Date.UTC(2026, 0, 1) + r.int(0, 900) * DAY_MS).toISOString().slice(0, 10)
  const time = `${String(r.int(0, 23)).padStart(2, '0')}:${r.pick(['00', '05', '30', '59'])}`
  const every = r.pick([undefined, 'day', 'week', 'month', 'year'] as const)
  const s: Record<string, unknown> = { start, time }
  if (every === undefined) return s as Input
  s.every = every
  s.interval = r.pick([1, 1, 1, 2, 3, 7, 15, 30])
  if (every === 'week' && r.next() < 0.7) s.weekdays = r.some(WEEKDAYS as readonly Weekday[], 5)
  if (every === 'month') {
    const form = r.next()
    if (form < 0.3) s.nth = { n: r.pick([1, 2, 3, 4, -1] as const), weekday: r.pick(WEEKDAYS) }
    else if (form < 0.8) s.month_days = r.some([1, 2, 10, 15, 28, 29, 30, 31, -1], 3)
  }
  if (every === 'year') {
    if (r.next() < 0.7) s.month = r.int(1, 12)
    if (r.next() < 0.7) s.month_days = r.some([1, 3, 15, 28, 29, 30, 31, -1], 2)
    s.interval = r.pick([1, 1, 2, 3])
  }
  if (r.next() < 0.3) s.count = r.int(1, 12)
  if (r.next() < 0.3) {
    s.until = new Date(dayNum(start) * DAY_MS + r.int(0, 900) * DAY_MS).toISOString().slice(0, 10)
  }
  return s as Input
}

describe('nextOccurrence: properties', () => {
  it('is strictly after, matches the rule, skips nothing and never passes until or count', () => {
    const r = rng(20261122)
    for (let i = 0; i < 400; i++) {
      const input = randomSchedule(r)
      const s = make(input)
      const startMs = dayNum(s.start) * DAY_MS
      const after = new Date(startMs + r.int(-30, 1200) * DAY_MS + r.int(0, DAY_MS - 1))
      const found = nextOccurrence(s, after)
      const label = `${JSON.stringify(input)} after ${after.toISOString()}`

      if (found) {
        expect(found.getTime(), label).toBeGreaterThan(after.getTime())
        const day = dayNum(argentinaToday(found))
        expect(argentinaTime(found), label).toBe(s.time)
        expect(matchesRule(s, day), label).toBe(true)
        if (s.until) expect(day, label).toBeLessThanOrEqual(dayNum(s.until))
        if (s.count) expect(position(s, day), label).toBeLessThanOrEqual(s.count)
        // Nothing the rule names lies between `after` and the result.
        for (let d = dayNum(argentinaToday(after)); d < day; d++) {
          if (matchesRule(s, d))
            expect(instantOf(s, d) <= after.getTime(), `${label}: skipped ${d}`).toBe(true)
        }
      } else if (s.every !== undefined) {
        // Ended: every day the rule still names after `after` is past `until` or past `count`.
        const from = dayNum(argentinaToday(after))
        for (let d = from; d <= from + 3 * 366; d++) {
          if (!matchesRule(s, d) || instantOf(s, d) <= after.getTime()) continue
          const over = (s.until && d > dayNum(s.until)) || (s.count && position(s, d) > s.count)
          expect(Boolean(over), `${label}: ended early at ${d}`).toBe(true)
        }
      }
    }
  }, 60_000)

  it('always ends where count says: a series of count occurrences, then null', () => {
    const r = rng(7)
    for (let i = 0; i < 200; i++) {
      const input = randomSchedule(r) as Record<string, unknown>
      if (!('every' in input)) continue
      const s = make({ ...input, count: r.int(1, 8) })
      const days: number[] = []
      let after = new Date(0)
      for (;;) {
        const next = nextOccurrence(s, after)
        if (!next) break
        days.push(dayNum(argentinaToday(next)))
        after = next
        if (days.length > 8) break
      }
      expect(days.length, JSON.stringify(s)).toBeLessThanOrEqual(s.count ?? 0)
      expect(days, JSON.stringify(s)).toEqual([...days].sort((a, b) => a - b))
      expect(new Set(days).size, JSON.stringify(s)).toBe(days.length)
    }
  }, 60_000)
})

describe('normalizeSchedule: from now on, never drained by a start that has passed', () => {
  const norm = (input: Input, now: string) => normalizeSchedule(make(input), at(now))
  /** The next `n` occurrences of what normalizeSchedule gives, from `now`. */
  const upcoming = (input: Input, now: string, n: number) => {
    const s = norm(input, now)
    if (!s) return null
    const out: string[] = []
    let after = at(now)
    for (let i = 0; i < n; i++) {
      const next = nextOccurrence(s, after)
      if (!next) break
      out.push(local(next))
      after = next
    }
    return out
  }

  it('counts from the first occurrence after now, not from a time that already passed today', () => {
    // 14:00; "3 veces a las 8, desde hoy": today's 08:00 is gone, and it is not one of the three.
    const input = { start: '2026-11-21', time: '08:00', every: 'day', count: 3 } as const
    expect(upcoming(input, '2026-11-21 14:00', 10)).toEqual([
      '2026-11-22 08:00',
      '2026-11-23 08:00',
      '2026-11-24 08:00',
    ])
    // Before 08:00 the same input keeps today's.
    expect(upcoming(input, '2026-11-21 07:00', 10)).toEqual([
      '2026-11-21 08:00',
      '2026-11-22 08:00',
      '2026-11-23 08:00',
    ])
  })

  it('a one-time monthly "el 10" on the 10th after its time is next month\'s', () => {
    const input = { start: '2026-11-10', every: 'month', month_days: [10], count: 1 } as const
    expect(upcoming(input, '2026-11-10 15:00', 5)).toEqual(['2026-12-10 09:00'])
    expect(upcoming(input, '2026-11-10 08:00', 5)).toEqual(['2026-11-10 09:00'])
  })

  it('a one-time weekly "el viernes" on a Friday afternoon is next Friday', () => {
    const input = {
      start: '2026-11-20',
      time: '10:00',
      every: 'week',
      weekdays: ['fri'],
      count: 1,
    } as const
    expect(upcoming(input, '2026-11-20 15:00', 5)).toEqual(['2026-11-27 10:00'])
  })

  it('makes what defaults to start explicit first: a monthly with no day keeps the day of start, a weekly its weekday, a yearly its month and day', () => {
    // start 31 Oct (a Saturday), asked on 5 Nov: the day of the month is 31 (clamped in short months), not the day it moved to.
    expect(
      upcoming({ start: '2026-10-31', every: 'month', count: 3 }, '2026-11-05 10:00', 5),
    ).toEqual(['2026-11-30 09:00', '2026-12-31 09:00', '2027-01-31 09:00'])
    expect(
      upcoming({ start: '2026-11-14', every: 'week', count: 2 }, '2026-11-21 12:00', 5),
    ).toEqual(['2026-11-28 09:00', '2026-12-05 09:00'])
    expect(
      upcoming({ start: '2026-04-03', every: 'year', count: 2 }, '2026-11-21 12:00', 5),
    ).toEqual(['2027-04-03 09:00', '2028-04-03 09:00'])
  })

  it('keeps the series: an interval still counts from the same place', () => {
    // Every 15 days from the 1st at 08:00; asked on the 17th at 14:00: the series is 1, 16, 31 (Dec)... the next is 1 Dec.
    const input = {
      start: '2026-11-01',
      time: '08:00',
      every: 'day',
      interval: 15,
      count: 2,
    } as const
    expect(upcoming(input, '2026-11-17 14:00', 5)).toEqual(['2026-12-01 08:00', '2026-12-16 08:00'])
    // Every 2 weeks on Monday from 2 Nov; asked on Wed 11 Nov: the series is 2, 16, 30 Nov.
    const weekly = {
      start: '2026-11-02',
      every: 'week',
      interval: 2,
      weekdays: ['mon'],
      count: 2,
    } as const
    expect(upcoming(weekly, '2026-11-11 12:00', 5)).toEqual([
      '2026-11-16 09:00',
      '2026-11-30 09:00',
    ])
  })

  it('moves start to the first occurrence and leaves everything else as it was', () => {
    const s = norm(
      { start: '2026-11-21', time: '08:00', every: 'day', count: 3, until: '2026-12-31' },
      '2026-11-21 14:00',
    )
    expect(s).toMatchObject({
      start: '2026-11-22',
      time: '08:00',
      every: 'day',
      count: 3,
      until: '2026-12-31',
    })
  })

  it('is null when nothing is left: a one-off that passed, an end before now', () => {
    expect(norm({ start: '2026-11-21', time: '08:00' }, '2026-11-21 14:00')).toBeNull()
    expect(
      norm({ start: '2026-11-01', every: 'day', until: '2026-11-20' }, '2026-11-21 14:00'),
    ).toBeNull()
  })

  it('leaves a one-off alone', () => {
    const one = make({ start: '2026-11-25', time: '10:00' })
    expect(normalizeSchedule(one, at('2026-11-21 14:00'))).toEqual(one)
  })

  it('gives the same occurrences as the schedule did for every rule, from the first one on (a seeded loop)', () => {
    const r = rng(99)
    for (let i = 0; i < 150; i++) {
      const input = randomSchedule(r)
      const s = make(input)
      const now = new Date(dayNum(s.start) * DAY_MS + r.int(0, 400) * DAY_MS + r.int(0, DAY_MS - 1))
      const n = normalizeSchedule(s, now)
      const open = { ...s, count: undefined }
      const first = nextOccurrence(open, now)
      if (!n) {
        expect(first, JSON.stringify(input)).toBeNull()
        continue
      }
      // The first occurrence is the same, and with count the series from there has count occurrences.
      expect(nextOccurrence(n, now), JSON.stringify(input)).toEqual(first)
      if (s.count !== undefined) {
        let at = new Date(now)
        let k = 0
        for (;;) {
          const next = nextOccurrence(n, at)
          if (!next) break
          k++
          at = next
        }
        expect(k, JSON.stringify(input)).toBeLessThanOrEqual(s.count)
        expect(k, JSON.stringify(input)).toBeGreaterThan(0)
      }
    }
  }, 60_000)
})

// ---- resolveFirst: what the person said about when, as a day and a clock time ----

describe('resolveFirst', () => {
  const first = (f: First, now: string) => resolveFirst(f, at(now))

  it('"en 20 minutos" and "en 2 horas" are that long from now, to the minute', () => {
    expect(first({ in: { n: 20, unit: 'minutes' } }, '2026-11-24 10:05')).toEqual({
      start: '2026-11-24',
      time: '10:25',
    })
    expect(first({ in: { n: 2, unit: 'hours' } }, '2026-11-24 23:30')).toEqual({
      start: '2026-11-25',
      time: '01:30',
    })
  })

  it('"en 3 días", "en 2 semanas" and "en 1 mes" keep the clock of now', () => {
    expect(first({ in: { n: 3, unit: 'days' } }, '2026-11-24 10:05')).toEqual({
      start: '2026-11-27',
      time: '10:05',
    })
    expect(first({ in: { n: 2, unit: 'weeks' } }, '2026-11-24 10:05')).toEqual({
      start: '2026-12-08',
      time: '10:05',
    })
    expect(first({ in: { n: 3, unit: 'months' } }, '2026-11-30 10:05')).toEqual({
      start: '2027-02-28',
      time: '10:05',
    })
  })

  it('a named day is today, tomorrow or the day after, at the time said or 09:00', () => {
    expect(first({ day: 'today' }, '2026-11-24 08:00')).toEqual({
      start: '2026-11-24',
      time: '09:00',
    })
    expect(first({ day: 'tomorrow', time: '18:30' }, '2026-11-24 08:00')).toEqual({
      start: '2026-11-25',
      time: '18:30',
    })
    expect(first({ day: 'day_after' }, '2026-12-31 08:00')).toEqual({
      start: '2027-01-02',
      time: '09:00',
    })
  })

  it('a time of today that has gone by stays today: the guard says it is past, code never moves it', () => {
    const r = first({ day: 'today', time: '09:00' }, '2026-11-24 14:00')
    expect(r).toEqual({ start: '2026-11-24', time: '09:00' })
    expect(nextOccurrence(make(r), at('2026-11-24 14:00'))).toBeNull()
  })

  it('a weekday is the first such day still ahead: a Monday morning says today, a Monday afternoon says next week', () => {
    // 2026-11-23 is a Monday.
    expect(first({ weekday: 'mon', time: '15:00' }, '2026-11-23 10:00')).toEqual({
      start: '2026-11-23',
      time: '15:00',
    })
    expect(first({ weekday: 'mon' }, '2026-11-23 10:00')).toEqual({
      start: '2026-11-30',
      time: '09:00',
    })
    expect(first({ weekday: 'fri' }, '2026-11-23 10:00')).toEqual({
      start: '2026-11-27',
      time: '09:00',
    })
  })

  it('a day of the month is the next one whose time is ahead, skipping months without it', () => {
    expect(first({ month_day: 10 }, '2026-11-24 10:00')).toEqual({
      start: '2026-12-10',
      time: '09:00',
    })
    expect(first({ month_day: 10 }, '2026-11-10 08:00')).toEqual({
      start: '2026-11-10',
      time: '09:00',
    })
    expect(first({ month_day: 10 }, '2026-11-10 10:00')).toEqual({
      start: '2026-12-10',
      time: '09:00',
    })
    expect(first({ month_day: 31 }, '2026-11-24 10:00')).toEqual({
      start: '2026-12-31',
      time: '09:00',
    })
    expect(first({ month_day: 30 }, '2027-01-31 10:00')).toEqual({
      start: '2027-03-30',
      time: '09:00',
    })
    expect(first({ month_day: 29, month: 2 }, '2026-11-24 10:00')).toEqual({
      start: '2028-02-29',
      time: '09:00',
    })
  })

  it('a date is that date', () => {
    expect(first({ date: '2027-03-05', time: '07:15' }, '2026-11-24 10:00')).toEqual({
      start: '2027-03-05',
      time: '07:15',
    })
  })

  it('always lands ahead of now (relative forms), on the day it names (a seeded loop, failures collected)', () => {
    const r = rng(7)
    const failures: string[] = []
    const days = ['today', 'tomorrow', 'day_after'] as const
    const units = ['minutes', 'hours', 'days', 'weeks', 'months'] as const
    for (let i = 0; i < 3000; i++) {
      const now = new Date(
        Date.UTC(2026, 0, 1) + r.int(0, 3 * 365 * 24 * 60) * 60_000 + r.int(0, 59_999),
      )
      const time = `${String(r.int(0, 23)).padStart(2, '0')}:${String(r.int(0, 59)).padStart(2, '0')}`
      const kind = r.int(0, 3)
      const f: First =
        kind === 0
          ? { in: { n: r.int(1, 90), unit: r.pick(units) } }
          : kind === 1
            ? { weekday: r.pick(WEEKDAYS), time }
            : kind === 2
              ? { month_day: r.int(1, 31), time }
              : { day: r.pick(days), time }
      const { start, time: t } = resolveFirst(f, now)
      const label = `${now.toISOString()} ${JSON.stringify(f)} -> ${start} ${t}`
      const instant = new Date(`${start}T${t}:00-03:00`)
      if (Number.isNaN(instant.getTime())) failures.push(`not a moment: ${label}`)
      if (!('day' in f) && !(instant > now)) failures.push(`not ahead: ${label}`)
      if (
        'in' in f &&
        f.in.unit === 'minutes' &&
        instant.getTime() - now.getTime() > f.in.n * 60_000 + 60_000
      )
        failures.push(`too far: ${label}`)
      if ('weekday' in f) {
        const wd = WEEKDAYS[(new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7]
        if (wd !== f.weekday) failures.push(`wrong weekday: ${label}`)
        if (instant.getTime() - now.getTime() > 8 * DAY_MS)
          failures.push(`more than a week: ${label}`)
      }
      if ('month_day' in f) {
        if (Number(start.slice(8, 10)) !== f.month_day) failures.push(`wrong day: ${label}`)
        if (instant.getTime() - now.getTime() > 63 * DAY_MS)
          failures.push(`more than two months: ${label}`)
      }
      if (
        'day' in f &&
        start !== argentinaToday(new Date(now.getTime() + days.indexOf(f.day) * DAY_MS))
      )
        failures.push(`wrong day: ${label}`)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })
})
