import type { FactRow } from '../domain/facts'
import { MAX_FACTS } from '../domain/facts'
import {
  type ChangedField,
  changedFields,
  type MovementRow,
  type ValuesOf,
} from '../domain/movements'
import { addDays } from '../time'
import type { Outcome } from './apply'
import { CATEGORY_LABEL, capitalize, money, shortDate } from './es'
import type { Declined } from './guards'
import type { Undone } from './history'

const BULLET = '• '

/**
 * The one Spanish rendering of what a write did: `describe(outcome, {today, newest})` is the line (or lines) of the record, from
 * stored values and nothing else; MCP wraps it in structured output. `today` is the Argentine day of the call; `newest` is the
 * entity id of the person's newest live movement before the turn, which a line leaves without its time (every other movement shows
 * the time it was logged, so the person can tell it from the rest).
 */

export interface View {
  today: string
  newest: number | null
}

// ---- Words code says on its own

export const REPLY = {
  gone: 'Ese movimiento ya fue corregido o borrado. Mirá cómo quedó y pedí de nuevo qué cambiar.',
  undoNothing: 'No tengo nada para deshacer.',
  undoExpired:
    'Lo último que se hizo fue hace más de 24 horas y ya no se deshace solo. Corregí o borrá el movimiento directamente.',
  factsNone: 'Todavía no tengo nada anotado de vos.',
  factGone: '🧠 Eso ya lo había olvidado.',
  factSecret: 'No guardo claves, números de tarjeta, CBU/CVU ni documentos.',
  factContact: 'No guardo datos de contacto: teléfonos ni mails.',
} as const

/** What a refusal by code is answered with, by its typed code. */
export const declineLine = (code: Declined): string =>
  ({
    secret: REPLY.factSecret,
    contact: REPLY.factContact,
  })[code]

// ---- A movement

/** "hoy", "ayer", else "03/11" (and "03/11/25" in another year). */
function dayName(date: string, today: string): string {
  if (date === today) return 'hoy'
  if (date === addDays(today, -1)) return 'ayer'
  return shortDate(date, today)
}

/** The date suffix of a movement's line; nothing for today. */
const when = (date: string, today: string) => (date === today ? '' : ` · ${dayName(date, today)}`)

/** A movement's text, money and payment, no date and no mark. */
function movementText(m: ValuesOf): string {
  const amount = `${m.direction === 'in' ? '+' : ''}${money(m.amount, m.currency)}`
  const payment = m.payment?.trim() ? ` (${m.payment.trim()})` : ''
  return `${capitalize(m.description.trim())} ${amount}${payment}`
}

/** The time the movement was logged, when the movement is not the newest one: how the person tells it from the others. */
const logged = (time: string | undefined, newest: boolean) => (!newest && time ? ` · ${time}` : '')

function movementLine(m: MovementRow, today: string): string {
  return `${movementText(m)}${when(m.date, today)}${m.confidence === 'low' ? ' (?)' : ''}`
}

/** The fields of `before` named in `changed`, as they were: "$2.900, hoy". */
function wasText(before: ValuesOf, changed: ChangedField[], today: string): string {
  const was = {
    money: `${before.direction === 'in' ? '+' : ''}${money(before.amount, before.currency)}`,
    date: dayName(before.date, today),
    description: before.description.trim(),
    category: CATEGORY_LABEL[before.category],
    payment: before.payment?.trim() || 'sin medio de pago',
  }
  return changed.map((field) => was[field]).join(', ')
}

function logLine(movements: MovementRow[], today: string): string {
  const lines = movements.map((m) => movementLine(m, today))
  if (lines.length === 1) return `✓ ${lines[0]}`
  return [`✓ Anoté ${lines.length}:`, ...lines.map((l) => `${BULLET}${l}`)].join('\n')
}

function correctionLine(
  before: MovementRow,
  after: MovementRow,
  changed: ChangedField[],
  today: string,
  newest: boolean,
): string {
  const date = changed.includes('date') && after.date === today ? ' · hoy' : when(after.date, today)
  const category = changed.includes('category') ? ` · ${CATEGORY_LABEL[after.category]}` : ''
  return `✓ Corregido: ${movementText(after)}${date}${category} (antes ${wasText(before, changed, today)})${logged(before.time, newest)}`
}

// ---- A fact

/** A fact's value as a person reads it: a category by its label. */
const factValue = (f: Pick<FactRow, 'kind' | 'value'>): string =>
  f.kind === 'category'
    ? (CATEGORY_LABEL[f.value as keyof typeof CATEGORY_LABEL] ?? f.value)
    : f.value

/** `la visa = Galicia` (an alias), `café → Entretenimiento` (a category), `cobro: el 5` (a note). */
export function factText(f: Pick<FactRow, 'kind' | 'key' | 'value'>): string {
  if (f.kind === 'alias') return `${f.key} = ${f.value}`
  return f.kind === 'category' ? `${f.key} → ${factValue(f)}` : `${f.key}: ${f.value}`
}

// ---- An undo

function undoLine(u: Undone, today: string): string {
  const dated = (m: MovementRow) => `${movementText(m)}${when(m.date, today)}`
  switch (u.kind) {
    case 'fact_removed':
      return `Olvidé 🧠 ${factText(u.fact)}`
    case 'fact_restored':
      return `Volvió 🧠 ${factText(u.fact)}`
    case 'fact_reverted':
      return `🧠 ${factText(u.fact)} (estaba ${factValue({ kind: u.fact.kind, value: u.was })})`
    case 'logged':
      return `Quité ${dated(u.movement)}`
    case 'deleted':
      return `Volvió ${dated(u.movement)}`
    case 'corrected':
      return `${dated(u.to)} (estaba ${wasText(u.from, changedFields(u.from, u.to), today)})`
  }
}

/**
 * The record of an undo. Only logs undone: `↩︎ Deshice: Súper $5.000 · Panadería $3.000`. Anything else (a correction or a
 * delete undone, alone or mixed) is a bulleted list that says what happened to each.
 */
function undoneLine(items: Undone[], today: string): string {
  const logs = items.filter((u): u is Extract<Undone, { kind: 'logged' }> => u.kind === 'logged')
  if (logs.length === items.length) {
    return `↩︎ Deshice: ${logs.map((l) => `${movementText(l.movement)}${when(l.movement.date, today)}`).join(' · ')}`
  }
  return ['↩︎ Deshice:', ...items.map((u) => `${BULLET}${undoLine(u, today)}`)].join('\n')
}

function undoText(o: Extract<Outcome, { tool: 'undo_last' }>, today: string): string {
  switch (o.status) {
    case 'applied':
      return undoneLine(o.items, today)
    case 'nothing':
      return REPLY.undoNothing
    case 'expired':
      return REPLY.undoExpired
  }
}

// ---- The outcomes

/**
 * The Spanish line of an outcome. Exhaustive over the tools of the registry that write: a new write that is not handled here does
 * not compile. A line that changed nothing (`gone`, `full`...) is rendered too: the person is told what did not happen.
 */
export function describe(o: Outcome, v: View): string {
  const { today, newest } = v
  switch (o.tool) {
    case 'log_movements':
      return logLine(o.movements, today)
    case 'correct_movement':
      if (o.status === 'gone') return REPLY.gone
      if (o.status === 'unchanged')
        return `Ya figura así: ${movementText(o.old)}${when(o.old.date, today)}`
      return correctionLine(o.old, o.next, o.changed, today, o.old.id === newest)
    case 'delete_movement':
      if (o.status === 'gone') return REPLY.gone
      return `✓ Borré: ${movementText(o.old)}${when(o.old.date, today)}${logged(o.old.time, o.old.id === newest)}`
    case 'undo_last':
      return undoText(o, today)
    case 'remember_fact':
      if (o.status === 'full') {
        return `Ya hay ${MAX_FACTS} cosas anotadas y no entran más. Olvidá una y probá de nuevo.`
      }
      if (o.status === 'unchanged') return `🧠 Ya lo tenía anotado: ${factText(o.fact)}`
      return `🧠 Anotado: ${factText(o.fact)}${o.before === undefined ? '' : ` (antes ${factValue({ kind: o.fact.kind, value: o.before })})`}`
    case 'forget_fact':
      if (o.status === 'gone') {
        return 'id' in o.target ? REPLY.factGone : `🧠 No tengo nada anotado de "${o.target.key}".`
      }
      return o.facts.map((f) => `🧠 Olvidado: ${factText(f)}`).join('\n')
  }
}
