import type { Input, Range } from '../core/commands'
import { addDays, type DateRange, dayParts as parts } from '../time'
import { isTimeGroup } from './totals'

/** A range as the resolution core reads it: the fields a period does not use are their empty value (`sentinel` makes it from a typed `Range`). */
export interface RangeInput {
  period: Range['period']
  month: number
  year: number
  from: string
  to: string
}

/**
 * Which kind of span a range is, which decides what "the one before" means: a month goes back to the
 * previous calendar month, a week to the previous Monday-to-Sunday, a year to the previous year, and a
 * custom range to the same number of days right before it.
 */
export type RangeKind = 'day' | 'week' | 'weekend' | 'month' | 'year' | 'custom'

export interface Resolved extends DateRange {
  kind: RangeKind
  /** The period was asked for whole but is not over: `to` is today, not the end of the week, month or year. */
  partial: boolean
}

export type Resolution = { ok: true; range: Resolved } | { ok: false; reason: string }

/** The most days a range may cover: two years. */
export const MAX_RANGE_DAYS = 731

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() // 0 is Sunday

/** The inclusive number of days from `from` to `to`. */
export function rangeDays(r: DateRange): number {
  return (
    Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 864e5) + 1
  )
}

const refuse = (reason: string): Resolution => ({ ok: false, reason })

/** What the agent is told when it asks for days that have not happened. */
const futureReason = (what: string, today: string) =>
  `${what} has not started yet: today is ${today}. Nothing is stored for it. Tell the person with reply, in Spanish and with no number (for example "Eso todavía no pasó."), and do not summarize it.`

// ---- Explicit days: yyyy-mm-dd, mm-dd or dd, the way a person says them.

type Endpoint =
  | { form: 'full'; y: number; m: number; d: number }
  | { form: 'md'; m: number; d: number }
  | { form: 'd'; d: number }

/** One end of a `dates` range as said, or why it cannot be one. */
function parseEndpoint(text: string): Endpoint | string {
  const s = text.trim()
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
    return y >= 2000 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)
      ? { form: 'full', y, m, d }
      : `"${s}" is not a real day`
  }
  match = /^(\d{1,2})-(\d{1,2})$/.exec(s)
  if (match) {
    const [m, d] = [Number(match[1]), Number(match[2])]
    // 29 February is real in some years, so it is allowed here and found by `latest`.
    return m >= 1 && m <= 12 && d >= 1 && d <= (m === 2 ? 29 : daysIn(2001, m))
      ? { form: 'md', m, d }
      : `"${s}" is not a real day`
  }
  match = /^(\d{1,2})$/.exec(s)
  if (match) {
    const d = Number(match[1])
    return d >= 1 && d <= 31 ? { form: 'd', d } : `"${s}" is not a real day`
  }
  return `"${s}" is not a date: use yyyy-mm-dd, mm-dd or dd`
}

/**
 * The latest day that is the endpoint and is not after `limit`: how a person in Argentina reads "el 5" (this
 * month's, unless that is still to come: then last month's) and "5 de octubre" (this year's, or last year's).
 */
function latest(e: Endpoint, limit: string): string | null {
  const [ly, lm] = parts(limit)
  if (e.form === 'full') return iso(e.y, e.m, e.d)
  if (e.form === 'md') {
    for (let y = ly; y > ly - 9; y--) {
      if (e.d > daysIn(y, e.m)) continue // 29 February in a year that has none
      const day = iso(y, e.m, e.d)
      if (day <= limit) return day
    }
    return null
  }
  for (let back = 0; back < 36; back++) {
    const first = new Date(Date.UTC(ly, lm - 1 - back, 1))
    const y = first.getUTCFullYear()
    const m = first.getUTCMonth() + 1
    if (e.d > daysIn(y, m)) continue // there is no 31 November
    const day = iso(y, m, e.d)
    if (day <= limit) return day
  }
  return null
}

/** Where an endpoint falls in a year or month, to tell a range that runs on from one that wraps ("28 dic al 3 ene"). */
const order = (e: Endpoint) => (e.form === 'md' ? e.m * 100 + e.d : e.form === 'd' ? e.d : 0)

/** The first day that is the endpoint on or after `from`: where "al 15" ends a range that started on the 1st. */
function firstFrom(e: Endpoint, from: string): string | null {
  if (e.form === 'full') return iso(e.y, e.m, e.d)
  const [fy, fm] = parts(from)
  if (e.form === 'md') {
    for (let y = fy; y < fy + 9; y++) {
      if (e.d > daysIn(y, e.m)) continue
      const day = iso(y, e.m, e.d)
      if (day >= from) return day
    }
    return null
  }
  for (let ahead = 0; ahead < 36; ahead++) {
    const first = new Date(Date.UTC(fy, fm - 1 + ahead, 1))
    const y = first.getUTCFullYear()
    const m = first.getUTCMonth() + 1
    if (e.d > daysIn(y, m)) continue
    const day = iso(y, m, e.d)
    if (day >= from) return day
  }
  return null
}

const reversed = (from: string, to: string) =>
  `The range is reversed: it starts on ${from} and ends on ${to}. If the person only said the days in the wrong order, send it again in order; if you cannot tell what they mean, ask them with reply.`

function resolveDates(spec: RangeInput, today: string): Resolution {
  if (spec.from.trim() === '') return refuse('period "dates" needs from (yyyy-mm-dd, mm-dd or dd)')
  const start = parseEndpoint(spec.from)
  if (typeof start === 'string') return refuse(`from: ${start}`)
  const end = spec.to.trim() === '' ? start : parseEndpoint(spec.to)
  if (typeof end === 'string') return refuse(`to: ${end}`)

  const missing = (which: 'from' | 'to') =>
    refuse(
      `${which}: "${which === 'from' ? spec.from : spec.to || spec.from}" is not a day that exists in the last years`,
    )
  let from: string | null
  let to: string | null
  const wraps = start.form === end.form && start.form !== 'full' && order(end) < order(start)
  if (start.form === 'md' && end.form === 'md' && start.m === end.m && start.d > end.d) {
    return refuse(
      `The range is reversed: it starts on day ${start.d} and ends on day ${end.d} of the same month ("${spec.from}" to "${spec.to}"). If the person only said the days in the wrong order, send it again in order; if you cannot tell what they mean, ask them with reply.`,
    )
  }
  if (wraps) {
    // "del 28 de diciembre al 3 de enero", "del 20 al 5": the end is the latest such day up to today, the start the latest before it.
    to = latest(end, today)
    from = to === null ? null : latest(start, to)
  } else {
    // The start is the latest such day up to today and the end the first such day from it, cut at today when it has
    // not come: "del 1 al 15 de noviembre" asked on the 12th is the 1st to the 12th.
    from = latest(start, today)
    to = from === null ? null : firstFrom(end, from)
  }
  if (from === null) return missing('from')
  if (to === null) return missing('to')
  if (from > to) return refuse(reversed(from, to))
  return bounded({ from, to, kind: 'custom' }, today, `The days ${from} to ${to}`)
}

// ---- The range

interface Whole extends DateRange {
  kind: RangeKind
}

/** A calendar month, whole. */
const monthOf = (y: number, m: number): Whole => ({
  from: iso(y, m, 1),
  to: iso(y, m, daysIn(y, m)),
  kind: 'month',
})
const yearOf = (y: number): Whole => ({ from: iso(y, 1, 1), to: iso(y, 12, 31), kind: 'year' })

/**
 * Checks a whole range against today and the cap, cuts it at today when it is not over, and tells which kind
 * it is (a custom range that is exactly a calendar month, or a year, is one: its "before" is the month before).
 */
function bounded(whole: Whole, today: string, what: string): Resolution {
  if (whole.from > today) return refuse(futureReason(what, today))
  let { kind } = whole
  if (kind === 'custom') {
    const [fy, fm, fd] = parts(whole.from)
    const [ty, tm, td] = parts(whole.to)
    if (fy === ty && fm === tm && fd === 1 && td === daysIn(ty, tm)) kind = 'month'
    else if (fy === ty && fm === 1 && fd === 1 && tm === 12 && td === 31) kind = 'year'
    else if (whole.from === whole.to) kind = 'day'
  }
  const range: Resolved = {
    from: whole.from,
    to: whole.to > today ? today : whole.to,
    kind,
    partial: whole.to > today,
  }
  const days = rangeDays(range)
  if (days > MAX_RANGE_DAYS) {
    return refuse(
      `The range covers ${days} days; the most is ${MAX_RANGE_DAYS} (two years). Ask the person for a shorter one with reply, or summarize by year.`,
    )
  }
  return { ok: true, range }
}

/**
 * The inclusive Argentine days a range covers, counted from `today` (an Argentine day). Pure. A period that is not
 * over ends today ("en lo que va del año", "esta semana"), so the days shown are the days that count. A range that
 * has not started, is reversed or is longer than two years is refused with the reason the agent is told.
 */
export function resolveRange(spec: RangeInput, today: string): Resolution {
  const [year = 0, month = 1] = parts(today)
  switch (spec.period) {
    case 'today':
      return bounded({ from: today, to: today, kind: 'day' }, today, 'Today')
    case 'yesterday': {
      const day = addDays(today, -1)
      return bounded({ from: day, to: day, kind: 'day' }, today, 'Yesterday')
    }
    case 'this_week':
    case 'last_week': {
      const monday = addDays(
        today,
        -((weekday(today) + 6) % 7) - (spec.period === 'last_week' ? 7 : 0),
      )
      return bounded({ from: monday, to: addDays(monday, 6), kind: 'week' }, today, 'The week')
    }
    case 'weekend':
    case 'last_weekend': {
      // The latest Saturday up to today. "El finde" is that weekend (Saturday: so far); "el finde pasado" is the
      // latest one that is over, which on a Saturday or a Sunday is the one before.
      const saturday = addDays(today, -((weekday(today) + 1) % 7))
      const back = spec.period === 'last_weekend' && [6, 0].includes(weekday(today)) ? 7 : 0
      const from = addDays(saturday, -back)
      return bounded({ from, to: addDays(from, 1), kind: 'weekend' }, today, 'The weekend')
    }
    case 'this_month':
    case 'last_month': {
      const first = new Date(Date.UTC(year, month - 1 - (spec.period === 'last_month' ? 1 : 0), 1))
      return bounded(monthOf(first.getUTCFullYear(), first.getUTCMonth() + 1), today, 'The month')
    }
    case 'this_year':
      return bounded(yearOf(year), today, 'The year')
    case 'last_year':
      return bounded(yearOf(year - 1), today, 'The year')
    case 'month': {
      if (!Number.isInteger(spec.month) || spec.month < 1 || spec.month > 12) {
        return refuse('period "month" needs month 1 to 12 ("octubre" is 10)')
      }
      if (spec.year !== 0 && (spec.year < 2000 || spec.year > 2200)) {
        return refuse('year is not a year of the calendar (2025, 2026...)')
      }
      // No year said: the latest such month that has started, so "octubre" in November is this year's and in March last year's.
      const y = spec.year !== 0 ? spec.year : spec.month > month ? year - 1 : year
      return bounded(monthOf(y, spec.month), today, `The month ${y}-${pad(spec.month)}`)
    }
    case 'year':
      if (!Number.isInteger(spec.year) || spec.year < 2000 || spec.year > 2200) {
        return refuse('period "year" needs the year (2025, 2026...)')
      }
      return bounded(yearOf(spec.year), today, `The year ${spec.year}`)
    case 'dates':
      return resolveDates(spec, today)
  }
}

/**
 * The range to compare with: a day goes to the day before, a week to the previous Monday-to-Sunday, a weekend to the
 * one before, a month to the previous calendar month, a year to the previous year, and a custom range to the same
 * number of days ending the day before it starts. While the period asked about is still running (`partial`), the one
 * before is cut to the same stretch, so like is compared with like: 1–21 November against 1–21 October (clamped to the
 * last day of a shorter month: 30 March against 1–28 February), this year so far against the same days of last
 * year, a week so far against the same weekdays of the week before. A period that is over is compared whole (a
 * week, a weekend or a year ends where the one before ends, so they need no case of their own; a month does,
 * because the one before may be longer).
 */
export function previousRange(r: Resolved): Resolved {
  const [y, m] = parts(r.from)
  const [, tm, td] = parts(r.to)
  const whole = (w: Whole): Resolved => ({ ...w, partial: false })
  switch (r.kind) {
    case 'day': {
      const day = addDays(r.from, -1)
      return whole({ from: day, to: day, kind: 'day' })
    }
    case 'week':
      return whole({ from: addDays(r.from, -7), to: addDays(r.to, -7), kind: 'week' })
    case 'weekend':
      return whole({ from: addDays(r.from, -7), to: addDays(r.to, -7), kind: 'weekend' })
    case 'month': {
      const before = new Date(Date.UTC(y, m - 2, 1))
      const [py, pm] = [before.getUTCFullYear(), before.getUTCMonth() + 1]
      const last = daysIn(py, pm)
      return whole({ ...monthOf(py, pm), to: iso(py, pm, r.partial ? Math.min(td, last) : last) })
    }
    case 'year':
      return whole({ ...yearOf(y - 1), to: iso(y - 1, tm, Math.min(td, daysIn(y - 1, tm))) })
    case 'custom': {
      const days = rangeDays(r)
      return whole({ from: addDays(r.from, -days), to: addDays(r.from, -1), kind: 'custom' })
    }
  }
}

/** What a summary covers: the range asked about and, when it is compared, the range it is compared with. */
export interface SummaryPlan {
  asked: Resolved
  before: Resolved | null
}

// ---- The typed range of the registry's `summarize` (docs/design.md, "Agent"): a discriminated union, no sentinels, no
// ---- string mini-language for the second range. The resolution core above is shared.

/** A typed range as the sentinel shape `resolveRange` reads: the fields a period does not use are empty. */
export function sentinel(r: Range): RangeInput {
  const base = { month: 0, year: 0, from: '', to: '' }
  switch (r.period) {
    case 'month':
      return { ...base, period: 'month', month: r.month, year: r.year ?? 0 }
    case 'year':
      return { ...base, period: 'year', year: r.year }
    case 'dates':
      return { ...base, period: 'dates', from: r.from, to: r.to ?? '' }
    default:
      return { ...base, period: r.period }
  }
}

/**
 * Every rule of a typed summary's days in one place: the range, "previous" or a second range, and what cannot be compared. A
 * string is the reason it cannot run (for the agent or the MCP client).
 */
export function planRange(
  q: Pick<Input<'summarize'>, 'range' | 'group_by' | 'compare'>,
  today: string,
): SummaryPlan | string {
  const asked = resolveRange(sentinel(q.range), today)
  if (!asked.ok) return `range: ${asked.reason}`
  if (q.compare === undefined) return { asked: asked.range, before: null }
  if (q.group_by !== undefined && isTimeGroup(q.group_by)) {
    return `a comparison cannot be grouped by ${q.group_by}: use group_by none, category or payment, or drop the comparison`
  }
  if (q.compare === 'previous') return { asked: asked.range, before: previousRange(asked.range) }
  const second = resolveRange(sentinel(q.compare), today)
  return second.ok ? { asked: asked.range, before: second.range } : `compare: ${second.reason}`
}
