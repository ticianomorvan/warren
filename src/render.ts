import type { Command, Movement } from './parse'
import { addDays } from './time'

export const REPLY_NON_TEXT = 'por ahora solo entiendo texto'
export const REPLY_INTERIM = 'Sigo con esto, ya te respondo.'
export const REPLY_FAILED = 'No pude procesar tu mensaje. Probá de nuevo en un rato.'
export const REPLY_NOT_YET =
  'Todavía no puedo corregir, borrar ni responder consultas. Llega pronto.'
export const REPLY_OFF_TOPIC = 'Solo puedo ayudarte con tus gastos e ingresos.'
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

function when(date: string, today: string): string {
  if (date === today) return ''
  if (date === addDays(today, -1)) return ' · ayer'
  const [year = '', month = '', day = ''] = date.split('-')
  // A different year is shown, so a wrong year cannot pass for the right day.
  return year === today.slice(0, 4) ? ` · ${day}/${month}` : ` · ${day}/${month}/${year.slice(2)}`
}

/** One movement as a line, without the leading mark. `today` is the Argentine day, yyyy-mm-dd. */
export function renderMovement(m: Movement, today: string): string {
  const description = m.description.trim()
  const text = description.charAt(0).toUpperCase() + description.slice(1)
  const money = `${m.direction === 'in' ? '+' : ''}${formatMoney(m.amount, m.currency)}`
  const payment = m.payment?.trim() ? ` (${m.payment.trim()})` : ''
  return `${text} ${money}${payment}${when(m.date, today)}${m.confidence === 'low' ? ' (?)' : ''}`
}

export interface RenderOptions {
  /** A human contact line added to the help reply. */
  helpContact?: string
}

/** The whole reply to a parsed command, from a template. The model never writes it. */
export function renderReply(command: Command, today: string, o: RenderOptions = {}): string {
  switch (command.type) {
    case 'log': {
      const lines = command.movements.map((m) => renderMovement(m, today))
      if (lines.length === 1) return `✓ ${lines[0]}`
      return [`✓ Anoté ${lines.length}:`, ...lines.map((l) => `• ${l}`)].join('\n')
    }
    case 'correct':
    case 'delete':
    case 'query':
      return REPLY_NOT_YET
    case 'help':
      return o.helpContact
        ? `${REPLY_HELP}\nSi necesitás hablar con una persona: ${o.helpContact}`
        : REPLY_HELP
    case 'off_topic':
      return REPLY_OFF_TOPIC
  }
}
