import { argentinaDay } from './argentina'

export type TimeLeft = {
  /** Whole calendar days from today (Argentina) to the date; zero or negative means today or past. */
  days_left: number
  /** "6 months, 13 days", "today" or "overdue by 3 months, 2 days". */
  time_left: string
}

type Ymd = { year: number; month: number; day: number }

const parse = (date: string): Ymd => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error('not a yyyy-mm-dd date')
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
const utc = (d: Ymd) => Date.UTC(d.year, d.month - 1, d.day)

/** `from` plus `months` calendar months; a day the month lacks lands on its last day (Jan 31 + 1 = Feb 28). */
const addMonths = (from: Ymd, months: number): Ymd => {
  const index = from.year * 12 + (from.month - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  return { year, month, day: Math.min(from.day, daysIn(year, month)) }
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** Whole calendar months from `from` to `to` (`from` <= `to`), then the days left over. */
function span(from: Ymd, to: Ymd) {
  let months = (to.year - from.year) * 12 + (to.month - from.month)
  while (months > 0 && utc(addMonths(from, months)) > utc(to)) months--
  const days = Math.round((utc(to) - utc(addMonths(from, months))) / 86_400_000)
  return { months, days }
}

/**
 * The time from today in Argentina, by `now`, to a yyyy-mm-dd date, computed here so no model
 * does date arithmetic (rule 1). Calendar months first, then the days left over.
 */
export function timeLeft(now: Date, date: string): TimeLeft {
  const today = parse(argentinaDay(now))
  const target = parse(date)
  const days_left = Math.round((utc(target) - utc(today)) / 86_400_000)
  if (days_left === 0) return { days_left, time_left: 'today' }
  const { months, days } = days_left > 0 ? span(today, target) : span(target, today)
  const text = [months > 0 ? plural(months, 'month') : '', days > 0 ? plural(days, 'day') : '']
    .filter(Boolean)
    .join(', ')
  return { days_left, time_left: days_left > 0 ? text : `overdue by ${text}` }
}
