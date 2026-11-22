import { z } from 'zod'
import { argentinaToday } from '../time'

/**
 * The schedule of a reminder: the useful subset of iCalendar's RRULE as typed fields (docs/reminders-spec.md,
 * Design 2), pure. Argentina is UTC-3 all year with no daylight saving, so a wall-clock time is an instant
 * three hours later in UTC and no time-zone library is needed. `nextOccurrence` is the only logic.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

const DAY_MS = 86_400_000
const ARGENTINA_OFFSET_MS = 3 * 3_600_000
/** Periods looked at before giving up: 50 years of a daily schedule. A real schedule never gets near it. */
const MAX_PERIODS = 20_000

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => Number.isFinite(toDay(s)) && fromDay(toDay(s)).iso === s, 'not a real date')

const weekday = z.enum(WEEKDAYS)

const fields = z.strictObject({
  /** The first day an occurrence can fall on (yyyy-mm-dd, Argentine). For a one-off, its day. */
  start: isoDay,
  /** The local clock time. */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('09:00'),
  /** Absent means once. */
  every: z.enum(['day', 'week', 'month', 'year']).optional(),
  /** Every n days, weeks, months or years. */
  interval: z.number().int().min(1).max(365).default(1),
  /** For week; absent means the weekday of `start`. */
  weekdays: z.array(weekday).min(1).max(7).optional(),
  /** For month and year: 1 to 31, or -1 for the last day. A 31 in a short month is that month's last day. */
  month_days: z
    .array(z.union([z.number().int().min(1).max(31), z.literal(-1)]))
    .min(1)
    .max(31)
    .optional(),
  /** For month: the nth weekday ("el primer lunes"), n in 1 to 4 or -1 for the last. */
  nth: z
    .strictObject({
      n: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]),
      weekday,
    })
    .optional(),
  /** For year: the month (1 to 12); absent means the month of `start`. */
  month: z.number().int().min(1).max(12).optional(),
  /** The end: the last day an occurrence can fall on. */
  until: isoDay.optional(),
  /** The end: how many occurrences in all (the first on or after `start` is the first). */
  count: z.number().int().min(1).max(1000).optional(),
})

export const ScheduleSchema = fields.superRefine((s, ctx) => {
  const refuse = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message })
  if (s.every === undefined) {
    for (const f of ['weekdays', 'month_days', 'nth', 'month', 'until', 'count'] as const) {
      if (s[f] !== undefined) refuse(f, 'a one-off has no repetition')
    }
    if (s.interval !== 1) refuse('interval', 'a one-off has no interval')
    return
  }
  if (s.weekdays && s.every !== 'week') refuse('weekdays', 'only for every week')
  if (s.nth && s.every !== 'month') refuse('nth', 'only for every month')
  if (s.month_days && s.every !== 'month' && s.every !== 'year') {
    refuse('month_days', 'only for every month or year')
  }
  if (s.month !== undefined && s.every !== 'year') refuse('month', 'only for every year')
  if (s.nth && s.month_days) refuse('nth', 'month_days and nth are two ways to say the same thing')
  if (s.weekdays && new Set(s.weekdays).size !== s.weekdays.length) {
    refuse('weekdays', 'a weekday twice')
  }
  if (s.month_days && new Set(s.month_days).size !== s.month_days.length) {
    refuse('month_days', 'a day twice')
  }
  if (s.until !== undefined && s.until < s.start) refuse('until', 'before the start')
})

/** A parsed schedule: `time` and `interval` are always there. Build one with `ScheduleSchema.parse`. */
export type Schedule = z.infer<typeof ScheduleSchema>

// Days are whole numbers of days since 1970-01-01 (a UTC midnight), so calendar arithmetic is integer arithmetic.

function toDay(iso: string): number {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / DAY_MS
}

function fromDay(day: number) {
  const date = new Date(day * DAY_MS)
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth() + 1
  const d = date.getUTCDate()
  return {
    y,
    m,
    d,
    /** Monday is 0. */
    wd: (date.getUTCDay() + 6) % 7,
    iso: date.toISOString().slice(0, 10),
  }
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const dayOf = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY_MS

/** The days of a month that `month_days` names: 31 in a short month, and -1, are its last day. Sorted, once each. */
function monthDays(y: number, m: number, days: readonly number[]): number[] {
  const last = daysInMonth(y, m)
  return [...new Set(days.map((d) => (d === -1 ? last : Math.min(d, last))))].sort((a, b) => a - b)
}

/** The day of the month of the nth `wd` (Monday is 0) of a month; n of -1 is the last. */
function nthWeekday(y: number, m: number, n: number, wd: number): number {
  if (n > 0) {
    const first = fromDay(dayOf(y, m, 1)).wd
    return 1 + ((wd - first + 7) % 7) + 7 * (n - 1)
  }
  const last = daysInMonth(y, m)
  return last - ((fromDay(dayOf(y, m, last)).wd - wd + 7) % 7)
}

/** Every day the rule names from `start` on, ascending, with no end: `until` and `count` cut it in `nextOccurrence`. */
function* ruleDays(s: Schedule): Generator<number> {
  const start = toDay(s.start)
  if (s.every === undefined) {
    yield start
    return
  }
  const first = fromDay(start)
  const from = (days: number[]) => days.filter((d) => d >= start)
  for (let k = 0; k < MAX_PERIODS; k++) {
    const step = k * s.interval
    switch (s.every) {
      case 'day':
        yield start + step
        break
      case 'week': {
        const monday = start - first.wd + 7 * step
        const picked = s.weekdays ? s.weekdays.map((w) => WEEKDAYS.indexOf(w)) : [first.wd]
        yield* from([...new Set(picked)].sort((a, b) => a - b).map((wd) => monday + wd))
        break
      }
      case 'month': {
        const at = first.y * 12 + (first.m - 1) + step
        const y = Math.floor(at / 12)
        const m = (at % 12) + 1
        const days = s.nth
          ? [nthWeekday(y, m, s.nth.n, WEEKDAYS.indexOf(s.nth.weekday))]
          : monthDays(y, m, s.month_days ?? [first.d])
        yield* from(days.map((d) => dayOf(y, m, d)))
        break
      }
      case 'year': {
        const y = first.y + step
        const m = s.month ?? first.m
        yield* from(monthDays(y, m, s.month_days ?? [first.d]).map((d) => dayOf(y, m, d)))
        break
      }
    }
  }
}

/** The instant of a local day and `HH:MM`. */
function instant(day: number, time: string): Date {
  const [h = 0, min = 0] = time.split(':').map(Number)
  return new Date(day * DAY_MS + (h * 60 + min) * 60_000 + ARGENTINA_OFFSET_MS)
}

/**
 * The first occurrence strictly after `after`, or null when the schedule has ended (`until`, `count`, or a
 * one-off already past). It counts from `start`, so it is the same answer wherever the sender left off.
 */
export function nextOccurrence(schedule: Schedule, after: Date): Date | null {
  const until = schedule.until === undefined ? Number.POSITIVE_INFINITY : toDay(schedule.until)
  let n = 0
  for (const day of ruleDays(schedule)) {
    n++
    if (day > until || (schedule.count !== undefined && n > schedule.count)) return null
    const at = instant(day, schedule.time)
    if (at > after) return at
  }
  return null
}

/**
 * The schedule as it stands from `now` on, or null when it has no occurrence left. `start` is where a schedule says it begins, which
 * may already be past (a model sends "today" for a time that has gone by): counting `count` from there would spend occurrences the
 * person never saw, and "el 10" on the 10th after the time would be refused. So the fields that default to `start` (the weekday, the
 * day of the month, the month) are made explicit first, the first occurrence after `now` is found with `count` left out, `start` moves
 * to that day (it is an occurrence of the same series, so the weeks, months and years still count from the same place), and `count`
 * then counts from there. `until` stays: a schedule that ends before `now` has nothing left.
 */
export function normalizeSchedule(schedule: Schedule, now: Date): Schedule | null {
  if (schedule.every === undefined) return nextOccurrence(schedule, now) ? schedule : null
  const [y = 0, m = 1, d = 1] = schedule.start.split('-').map(Number)
  const explicit: Schedule = { ...schedule }
  if (schedule.every === 'week' && !schedule.weekdays) {
    explicit.weekdays = [WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7] as Weekday]
  }
  if ((schedule.every === 'month' && !schedule.nth) || schedule.every === 'year') {
    explicit.month_days ??= [d]
  }
  if (schedule.every === 'year') explicit.month ??= m
  const { count, ...open } = explicit
  const first = nextOccurrence(open, now)
  if (!first) return null
  return { ...open, start: argentinaToday(first), ...(count === undefined ? {} : { count }) }
}
