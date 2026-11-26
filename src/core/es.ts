import type { Category } from './commands'

/**
 * Argentine Spanish vocabulary and formats, pure: the one home of month and weekday names, lists, money, the clock, the one short
 * date and the category labels. Every line Warren renders (a record, a list) takes them from here.
 */

export const MONTHS = [
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
] as const
export const MONTHS_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** A weekday, singular and plural ("el sábado", "todos los sábados"). */
export const WEEKDAY: Record<Weekday, { one: string; many: string }> = {
  mon: { one: 'lunes', many: 'lunes' },
  tue: { one: 'martes', many: 'martes' },
  wed: { one: 'miércoles', many: 'miércoles' },
  thu: { one: 'jueves', many: 'jueves' },
  fri: { one: 'viernes', many: 'viernes' },
  sat: { one: 'sábado', many: 'sábados' },
  sun: { one: 'domingo', many: 'domingos' },
}

/** The weekday name of a yyyy-mm-dd day, Sunday first as `Date#getUTCDay` counts. */
const BY_UTC_DAY = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const
export const weekdayOf = (day: string): string =>
  BY_UTC_DAY[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? ''

/** "a, b y c". */
export const list = (items: string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`

export const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * An amount in Argentine form: `.` between thousands, `,` before decimals only when they are not zero. Works on the decimal
 * string, never on a float. Expects `\d+(\.\d{1,2})?`, which the value guards have already checked.
 */
export function money(amount: string, currency: 'ARS' | 'USD'): string {
  const [rawWhole = '0', fraction = ''] = amount.split('.')
  const whole = rawWhole.replace(/^0+(?=\d)/, '') // "03500" is 3500
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, '.')
  const decimals = /^0*$/.test(fraction) ? '' : `,${fraction.padEnd(2, '0')}`
  return currency === 'USD' ? `US$ ${grouped}${decimals}` : `$${grouped}${decimals}`
}

/** The Argentine wall clock (HH:MM) of an instant. */
export const clock = (at: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at)

/**
 * The one short date: `05/12`, and `05/12/25` when the year is not the year of `today`, so a wrong year cannot pass for the right
 * day. Both days are yyyy-mm-dd.
 */
export function shortDate(day: string, today: string): string {
  const [year = '', month = '', date = ''] = day.split('-')
  return year === today.slice(0, 4) ? `${date}/${month}` : `${date}/${month}/${year.slice(2)}`
}

export const CATEGORY_LABEL: Record<Category, string> = {
  supermercado: 'Súper',
  restaurantes: 'Restaurantes',
  transporte: 'Transporte',
  combustible: 'Combustible',
  vivienda: 'Vivienda',
  servicios: 'Servicios',
  salud: 'Salud',
  educacion: 'Educación',
  entretenimiento: 'Entretenimiento',
  ropa: 'Ropa',
  regalos: 'Regalos',
  mascotas: 'Mascotas',
  viajes: 'Viajes',
  impuestos: 'Impuestos',
  transferencias: 'Transferencias',
  sueldo: 'Sueldo',
  otros_ingresos: 'Otros ingresos',
  otros: 'Otros',
}
