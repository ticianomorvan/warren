import type { Period } from './parse/schema'

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

/** The Argentine calendar day (yyyy-mm-dd) of an instant. */
export function argentinaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function weekdayName(isoDate: string): string {
  return WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()] ?? ''
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export type DateRange = { from: string; to: string }

const lastDayOfMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate() // `month` is 1-based, so day 0 of the next one

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The inclusive range of Argentine days (yyyy-mm-dd) a query period covers, counted from `today`
 * (an Argentine day). Weeks run Monday to Sunday and are whole, so the range may end after `today`.
 */
export function periodRange(period: Period, today: string): DateRange {
  const [year = 0, month = 1] = today.split('-').map(Number)
  switch (period) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const day = addDays(today, -1)
      return { from: day, to: day }
    }
    case 'this_week':
    case 'last_week': {
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() // 0 is Sunday
      const monday = addDays(today, -((weekday + 6) % 7) - (period === 'last_week' ? 7 : 0))
      return { from: monday, to: addDays(monday, 6) }
    }
    case 'this_month':
    case 'last_month': {
      const back = period === 'last_month' ? 1 : 0
      const first = new Date(Date.UTC(year, month - 1 - back, 1))
      const y = first.getUTCFullYear()
      const m = first.getUTCMonth() + 1
      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` }
    }
    case 'this_year':
      return { from: `${year}-01-01`, to: `${year}-12-31` }
  }
}
