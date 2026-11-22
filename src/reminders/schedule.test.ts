import { describe, expect, it } from 'vitest'
import { argentinaTime, argentinaToday } from '../time'
import { nextOccurrence, ScheduleSchema, WEEKDAYS, type Weekday } from './schedule'

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
  })

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
  })
})
