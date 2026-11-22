import { type Schedule, WEEKDAYS, type Weekday } from '../domain/reminders/schedule'
import { addDays, argentinaToday, dayParts, weekdayName } from '../time'
import type { ReminderRow } from './db'

/**
 * A schedule in Argentine Spanish, rendered by code from the typed fields, so the person sees what code understood and
 * not what the model said (docs/reminders-spec.md, Design 3). Pure; `today` is the Argentine day of the message.
 */

const WEEKDAY_PLURAL: Record<Weekday, string> = {
  mon: 'lunes',
  tue: 'martes',
  wed: 'miércoles',
  thu: 'jueves',
  fri: 'viernes',
  sat: 'sábados',
  sun: 'domingos',
}
const WEEKDAY_ONE: Record<Weekday, string> = {
  ...WEEKDAY_PLURAL,
  sat: 'sábado',
  sun: 'domingo',
}
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
]
const ORDINAL: Record<number, string> = {
  1: 'primer',
  2: 'segundo',
  3: 'tercer',
  4: 'cuarto',
  [-1]: 'último',
}

/** "a, b y c". */
const list = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`

/** dd/mm, with the year when it is not the year of `today`. */
function shortDate(day: string, today: string): string {
  const [y, m, d] = dayParts(day)
  return `${d}/${m}${y === dayParts(today)[0] ? '' : `/${y}`}`
}

/** An Argentine day in words: "hoy", "mañana", or "el miércoles 10/12". */
export function dayInWords(day: string, today: string): string {
  if (day === today) return 'hoy'
  if (day === addDays(today, 1)) return 'mañana'
  return `el ${weekdayName(day)} ${shortDate(day, today)}`
}

/** "el miércoles 10/12 a las 09:00", "hoy a las 15:00": an instant, Argentine time. */
export function instantInWords(at: Date, today: string): string {
  const day = argentinaToday(at)
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at)
  return `${dayInWords(day, today)} a las ${time}`
}

/** One occurrence only: not repeated, or repeated once. */
export const isOnce = (s: Schedule) => s.every === undefined || s.count === 1

/** The days of the month a monthly or yearly schedule names, as "el 10", "el 1 y el 15", "el último día". */
function monthDaysText(s: Schedule): string {
  const [, , startDay] = dayParts(s.start)
  const days = s.month_days ?? [startDay]
  const sorted = [...days].sort((a, b) => (a === -1 ? 1 : b === -1 ? -1 : a - b))
  return list(sorted.map((d) => (d === -1 ? 'el último día' : `el ${d}`)))
}

/** How often, without the time and the ends: "todos los lunes y jueves", "el 1 y el 15 de cada mes". */
function cadence(s: Schedule): string {
  const n = s.interval
  switch (s.every) {
    case 'day':
      return n === 1 ? 'todos los días' : `cada ${n} días`
    case 'week': {
      const [y, m, d] = dayParts(s.start)
      const startWeekday = WEEKDAYS[
        (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
      ] as Weekday
      const days = WEEKDAYS.filter((w) => (s.weekdays ?? [startWeekday]).includes(w))
      const weekdaysOnly =
        days.length === 5 && days.every((w) => !['sat', 'sun'].includes(w))
          ? 'de lunes a viernes'
          : null
      if (n === 1) {
        if (days.length === 7) return 'todos los días'
        return weekdaysOnly ?? `todos los ${list(days.map((w) => WEEKDAY_PLURAL[w]))}`
      }
      return `cada ${n} semanas, ${weekdaysOnly ?? `los ${list(days.map((w) => WEEKDAY_PLURAL[w]))}`}`
    }
    case 'month': {
      const which = s.nth
        ? `el ${ORDINAL[s.nth.n]} ${WEEKDAY_ONE[s.nth.weekday]}`
        : monthDaysText(s)
      return n === 1 ? `${which} de cada mes` : `cada ${n} meses, ${which}`
    }
    case 'year': {
      const month = MONTHS[(s.month ?? dayParts(s.start)[1]) - 1]
      const which = `${monthDaysText(s)} de ${month}`
      return n === 1 ? `${which} de cada año` : `cada ${n} años, ${which}`
    }
    default:
      return ''
  }
}

/**
 * The schedule in words. A one-off is "el miércoles 10/12 a las 09:00" (the first occurrence, `first`); a repeated one is
 * "todos los lunes y jueves a las 09:00, desde el 26/11", plus how it ends ("hasta el 31/12", "3 veces"). `since: false`
 * leaves out the "desde" (a list shows the next occurrence instead).
 */
export function describeSchedule(
  s: Schedule,
  first: Date,
  today: string,
  o: { since?: boolean } = {},
): string {
  if (isOnce(s)) return instantInWords(first, today)
  const firstDay = argentinaToday(first)
  const parts = [`${cadence(s)} a las ${s.time}`]
  if (o.since !== false) parts.push(`desde ${dayInWords(firstDay, today)}`)
  if (s.until) parts.push(`hasta el ${shortDate(s.until, today)}`)
  if (s.count) parts.push(`${s.count} veces`)
  return parts.join(', ')
}

/**
 * A live reminder as one phrase, for the list and for the model's context: what it is, in words, and when it comes next
 * ("el miércoles 10/12 a las 09:00"; "todos los lunes y jueves a las 08:00 (próximo: hoy a las 08:00)").
 */
export function describeReminder(r: ReminderRow, today: string): string {
  if (!r.nextDueAt) return 'ya pasó'
  if (isOnce(r.schedule)) return instantInWords(r.nextDueAt, today)
  return `${describeSchedule(r.schedule, r.nextDueAt, today, { since: false })} (próximo: ${instantInWords(r.nextDueAt, today)})`
}
