import type { Movement, Period, RecentMovement } from './agent'
import type { MovementRow, QueryTotal } from './ledger'
import type { ChangedField } from './movement'
import { addDays } from './time'
import type { ImageProblem } from './whatsapp/graph'

export const REPLY_NON_TEXT = 'Por ahora solo entiendo texto y fotos.'
export const REPLY_AUDIO = 'Todavía no entiendo audios. Escribime el gasto y lo anoto.'
/** What the person is told when a photo cannot be read, by why. */
export const REPLY_IMAGE: Record<ImageProblem, string> = {
  too_large:
    'La foto es muy pesada para leerla (máximo 5 MB). Mandala más liviana o escribime el gasto.',
  unsupported: 'Solo puedo leer fotos JPG, PNG o WebP. Mandala así o escribime el gasto.',
  unavailable: 'No pude descargar la foto. Mandala de nuevo o escribime el gasto.',
}
/** Sent when the model's own words were thrown away (a number code did not give) and nothing else was to say. */
export const REPLY_SAY_FALLBACK =
  'Eso no te lo sé decir bien. Preguntame cuánto gastaste, o mandame un gasto o un ingreso y lo anoto.'
export const REPLY_INTERIM = 'Sigo con esto, ya te respondo.'
export const REPLY_FAILED = 'No pude procesar tu mensaje. Probá de nuevo en un rato.'
export const REPLY_GONE =
  'Ese movimiento ya fue corregido o borrado. Fijate cómo quedó y mandame de nuevo qué querés cambiar.'
const REPLY_HELP =
  'Mandame un gasto o un ingreso y lo anoto. Por ejemplo: "café 3500 con la visa" o "cobré el sueldo 850.000".'

/**
 * An amount in Argentine form: `.` between thousands, `,` before decimals only when they are not
 * zero. Works on the decimal string, never on a float. Expects `\d+(\.\d{1,2})?`, which
 * `validateCommand` has already checked.
 */
export function formatMoney(amount: string, currency: Movement['currency']): string {
  const [rawWhole = '0', fraction = ''] = amount.split('.')
  const whole = rawWhole.replace(/^0+(?=\d)/, '') // "03500" is 3500
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, '.')
  const decimals = /^0*$/.test(fraction) ? '' : `,${fraction.padEnd(2, '0')}`
  return currency === 'USD' ? `US$ ${grouped}${decimals}` : `$${grouped}${decimals}`
}

/** "hoy", "ayer", else "03/11"; a different year is shown ("03/11/25"), so a wrong year cannot pass for the right day. */
function dayName(date: string, today: string): string {
  if (date === today) return 'hoy'
  if (date === addDays(today, -1)) return 'ayer'
  const [year = '', month = '', day = ''] = date.split('-')
  return year === today.slice(0, 4) ? `${day}/${month}` : `${day}/${month}/${year.slice(2)}`
}

/** The date suffix of a movement's line; nothing for today. */
const when = (date: string, today: string) => (date === today ? '' : ` · ${dayName(date, today)}`)

const CATEGORY_LABEL: Record<RecentMovement['category'], string> = {
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

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A movement's text, money and payment, no date and no mark. */
function movementText(m: RecentMovement): string {
  const money = `${m.direction === 'in' ? '+' : ''}${formatMoney(m.amount, m.currency)}`
  const payment = m.payment?.trim() ? ` (${m.payment.trim()})` : ''
  return `${capitalize(m.description.trim())} ${money}${payment}`
}

/** One movement as a line, without the leading mark. `today` is the Argentine day, yyyy-mm-dd. */
export function renderMovement(m: Movement, today: string): string {
  return `${movementText(m)}${when(m.date, today)}${m.confidence === 'low' ? ' (?)' : ''}`
}

/** The time the movement was logged, when the movement is not the newest one: how the person tells it from the others. */
const logged = (time: string | undefined, newest: boolean) => (!newest && time ? ` · ${time}` : '')

/**
 * The reply to a correction: the new movement, then the fields in `changed` as they were. A new
 * date that is today, or a new category, is spelled out because the movement's line would not
 * show it. `changed` comes from `changedFields`; it is never empty. A movement that is not the
 * newest also shows the time it was logged, so the person can see which one was meant.
 */
export function renderCorrection(
  before: RecentMovement,
  after: RecentMovement,
  changed: ChangedField[],
  today: string,
  newest = true,
): string {
  const was = {
    money: `${before.direction === 'in' ? '+' : ''}${formatMoney(before.amount, before.currency)}`,
    date: dayName(before.date, today),
    description: before.description.trim(),
    category: CATEGORY_LABEL[before.category],
    payment: before.payment?.trim() || 'sin medio de pago',
  }
  const date = changed.includes('date') && after.date === today ? ' · hoy' : when(after.date, today)
  const category = changed.includes('category') ? ` · ${CATEGORY_LABEL[after.category]}` : ''
  return `✓ Corregido: ${movementText(after)}${date}${category} (antes ${changed.map((field) => was[field]).join(', ')})${logged(before.time, newest)}`
}

export const renderUnchanged = (m: RecentMovement, today: string) =>
  `Ya figura así: ${movementText(m)}${when(m.date, today)}`

export const renderDeletion = (m: RecentMovement, today: string, newest = true) =>
  `✓ Borré: ${movementText(m)}${when(m.date, today)}${logged(m.time, newest)}`

/** A movement of a question's options, with its number. */
export interface Numbered {
  number: number
  movement: MovementRow
}

/**
 * A question from `ask_user`: `¿Cuál? 1. Café $3.500 de ayer · 2. Súper $12.000 (Visa)` and how to
 * answer. Several options are numbered 1, 2… in the order shown (newest first); `answers` says what
 * a bare number will do, so the instruction tells the truth. One option is shown as it is.
 */
export function renderAsk(
  question: string,
  options: MovementRow[],
  answers: 'delete' | 'correct' | 'none',
  today: string,
): string {
  if (options.length === 0) return `¿${question}?`
  if (options.length === 1) {
    const [only] = options
    const m = only as MovementRow
    return `¿${question}? ${movementText(m)}${when(m.date, today)}${m.time ? ` · ${m.time}` : ''}`
  }
  const numbered = options.map((movement, k) => ({ number: k + 1, movement }))
  const how =
    answers === 'none'
      ? 'Respondé con el número y el cambio, por ejemplo "el 1 fue 4100".'
      : 'Respondé con el número, por ejemplo "el 1".'
  return `¿${question}? ${listOptions(numbered, today)}\n${how}`
}

/** The options of a question, with the time logged on those that would otherwise look alike. */
function listOptions(candidates: Numbered[], today: string): string {
  const lines = candidates.map(({ number, movement: m }) => {
    const day = dayName(m.date, today)
    const suffix = m.date === today ? '' : day === 'ayer' ? ' de ayer' : ` del ${day}`
    return { number, text: `${movementText(m)}${suffix}`, time: m.time }
  })
  return lines
    .map((l) => {
      const alike = lines.filter((o) => o.text === l.text).length > 1
      return `${l.number}. ${l.text}${alike && l.time ? ` · ${l.time}` : ''}`
    })
    .join(' · ')
}

const PERIOD_TEXT: Record<Period, string> = {
  today: 'hoy',
  yesterday: 'ayer',
  this_week: 'esta semana',
  last_week: 'la semana pasada',
  this_month: 'este mes',
  last_month: 'el mes pasado',
  this_year: 'este año',
}

export interface QueryScope {
  period: Period
  direction: Movement['direction'] | null
  category: Movement['category'] | null
  payment: string | null
  /** Words of the description the totals are about ("café"). */
  description?: string | null
}

const movements = (n: number) => `${n} ${n === 1 ? 'movimiento' : 'movimientos'}`

/**
 * The answer to a query from its SQL totals: one block per direction, ARS first and USD on its
 * own line. The two currencies are never added together.
 */
export function renderQuery(q: QueryScope, totals: QueryTotal[]): string {
  const period = PERIOD_TEXT[q.period]
  const payment = q.payment?.trim()
  const about = [
    q.category ? CATEGORY_LABEL[q.category] : '',
    q.description?.trim().toLowerCase() ?? '',
  ].filter(Boolean)
  const scope = `${about.length > 0 ? ` en ${about.join(', ')}` : ''}${payment ? ` con ${payment}` : ''}`
  if (totals.length === 0) {
    const what =
      q.direction === 'out' ? 'gastos' : q.direction === 'in' ? 'ingresos' : 'movimientos'
    return `No encontré ${what} ${period}${scope}.`
  }
  const blocks = (['out', 'in'] as const).flatMap((direction) => {
    const rows = totals.filter((t) => t.direction === direction)
    return rows.map((t, i) => {
      const money = formatMoney(t.total, t.currency)
      const verb = direction === 'out' ? 'gastaste' : 'cobraste'
      return i === 0
        ? `${capitalize(period)} ${verb} ${money}${scope} (${movements(t.count)}).`
        : `Y ${money} (${movements(t.count)}).`
    })
  })
  return blocks.join('\n')
}

export interface RenderOptions {
  /** A human contact line added to the help reply. */
  helpContact?: string
}

/** The reply to a `log_movements` call: one line, or a bulleted list. */
export function renderLog(movements: Movement[], today: string): string {
  const lines = movements.map((m) => renderMovement(m, today))
  if (lines.length === 1) return `✓ ${lines[0]}`
  return [`✓ Anoté ${lines.length}:`, ...lines.map((l) => `• ${l}`)].join('\n')
}

/** The canned help text: the only reply the model does not write, for "ayuda" and greetings. */
export function renderHelp(o: RenderOptions = {}): string {
  return o.helpContact
    ? `${REPLY_HELP}\nSi necesitás hablar con una persona: ${o.helpContact}`
    : REPLY_HELP
}
