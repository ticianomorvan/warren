import type { FactRow } from '../domain/facts'
import { MAX_FACTS } from '../domain/facts'
import {
  type ChangedField,
  changedFields,
  type MovementRow,
  type ValuesOf,
} from '../domain/movements'
import type { ReminderRow } from '../domain/reminders/db'
import { describeReminder, describeSchedule } from '../domain/reminders/describe'
import { addDays } from '../time'
import type { Outcome } from './apply'
import type { SkipReason, Then } from './commands'
import { CATEGORY_LABEL, capitalize, money, shortDate } from './es'
import type { Declined } from './guards'
import type { Affected, Undone } from './history'

/**
 * The one Spanish rendering of what a write did, for both channels: `describe(outcome, {today, newest})` is the line (or lines) of
 * the record, from stored values and nothing else. WhatsApp sends it as the reply; MCP wraps it in structured output. `today` is the
 * Argentine day of the message; `newest` is the entity id of the person's newest live movement before the turn, which a line
 * leaves without its time (every other movement shows the time it was logged, so the person can tell it from the rest).
 */

export interface View {
  today: string
  newest: number | null
}

const BULLET = '• '

// ---- Words code says on its own

export const REPLY = {
  gone: 'Ese movimiento ya fue corregido o borrado. Fijate cómo quedó y mandame de nuevo qué querés cambiar.',
  undoNothing: 'No tengo nada para deshacer.',
  undoExpired:
    'Lo último que hice fue hace más de 24 horas y ya no lo deshago solo. Decime qué querés corregir o borrar.',
  factsNone: 'Todavía no tengo nada anotado de vos.',
  factGone: '🧠 Eso ya lo había olvidado.',
  factSecret: 'No guardo claves, números de tarjeta, CBU/CVU ni documentos.',
  factContact: 'No guardo datos de contacto: teléfonos ni mails.',
  reminderPast: 'Esa fecha y hora ya pasaron: decime para cuándo querés que te avise.',
  reminderFar:
    'Solo puedo avisarte de cosas que pasan en el próximo año: decime una fecha más cercana.',
  reminderGone: '⏰ Ese recordatorio ya no existe.',
  noWhatsappAddress:
    'Esta cuenta no tiene un WhatsApp donde mandarte el aviso: escribile a Warren por WhatsApp primero.',
  remindersNone: 'No tenés recordatorios.',
} as const

/** What a refusal by code is answered with, by its typed code. Redaction keys on the code, never on this text. */
export const declineLine = (code: Declined): string =>
  ({
    secret: REPLY.factSecret,
    contact: REPLY.factContact,
    reminder_past: REPLY.reminderPast,
    reminder_far: REPLY.reminderFar,
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

// ---- A reminder

/** The line a text is ended with: no second full stop after the person's own punctuation. */
const stop = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)

/** "tomar la pastilla (todos los lunes y jueves a las 09:00)": a reminder in a list, a cancel or an undo. */
const reminderBrief = (r: ReminderRow, today: string) =>
  `${r.what} (${r.nextDueAt ? describeSchedule(r.schedule, r.nextDueAt, today, { since: false }) : 'ya pasó'})`

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
    case 'reminder_removed':
      return `Quité ⏰ ${u.reminder.what}`
    case 'reminder_restored':
      return `Volvió ⏰ ${reminderBrief(u.reminder, today)}`
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

/** What an undo could not touch, as the turn left it: movements, facts, reminders. */
function whatMoved(c: Affected, today: string): string[] {
  return [
    ...c.movements.map((m) => `${movementText(m)}${when(m.date, today)}`),
    ...c.facts.map((f) => `🧠 ${factText(f)}`),
    ...c.reminders.map((r) => `⏰ ${r.what}`),
  ]
}

function staleLine(moved: Affected, today: string): string {
  const what = whatMoved(moved, today)
  return `No deshice nada: ${what.join(' · ')} ${what.length === 1 ? 'cambió' : 'cambiaron'} después. Decime qué querés cambiar.`
}

/**
 * The strict stack's answer: a change that can never be undone blocks the older ones. It names the change, says why, and points to
 * fixing the older thing directly.
 */
function blockedLine(blocking: Affected, why: string[], today: string): string {
  const what = whatMoved(blocking, today)
  const reason = why.includes('sent')
    ? 'ya se mandó'
    : why.includes('past')
      ? 'ya pasó su fecha'
      : 'no entra: ya tenés el máximo'
  return `No deshice nada: ${what.join(' · ')} ${reason} y no se puede deshacer, así que tampoco lo anterior. Si querés cambiar algo más viejo, decime qué, por ejemplo "corregí el café".`
}

function undoText(o: Extract<Outcome, { tool: 'undo_last' }>, today: string): string {
  switch (o.status) {
    case 'applied':
      return undoneLine(o.items, today)
    case 'nothing':
    case 'restricted':
      return REPLY.undoNothing
    case 'expired':
      return REPLY.undoExpired
    case 'stale':
      return staleLine(o.moved, today)
    case 'blocked':
      return blockedLine(o.blocking, o.why, today)
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
        return `Ya tengo ${MAX_FACTS} cosas anotadas de vos y no me entran más. Decime de cuál me olvido y lo guardo.`
      }
      if (o.status === 'unchanged') return `🧠 Ya lo tenía anotado: ${factText(o.fact)}`
      return `🧠 Me acuerdo: ${factText(o.fact)}${o.before === undefined ? '' : ` (antes ${factValue({ kind: o.fact.kind, value: o.before })})`}`
    case 'forget_fact':
      if (o.status === 'gone') {
        return 'id' in o.target ? REPLY.factGone : `🧠 No tengo nada anotado de "${o.target.key}".`
      }
      return o.facts.map((f) => `🧠 Me olvidé: ${factText(f)}`).join('\n')
    case 'forget_all_confirmed':
      return o.status === 'nothing'
        ? REPLY.factsNone
        : `🧠 Me olvidé de todo lo que sabía de vos (${o.facts.length}).`
    case 'set_reminder':
      if (o.status === 'full') {
        return `Ya tenés ${o.max} recordatorios y no me entran más. Cancelá uno y pedime este de nuevo.`
      }
      if (o.status === 'past') return REPLY.reminderPast
      return `⏰ Te aviso ${o.reminder.nextDueAt ? describeSchedule(o.reminder.schedule, o.reminder.nextDueAt, today) : ''}: ${stop(o.reminder.what)}`
    case 'cancel_reminder':
      return o.status === 'gone'
        ? REPLY.reminderGone
        : `⏰ Cancelé el recordatorio: ${reminderBrief(o.reminder, today)}`
  }
}

// ---- What code says that is not a write

/** Every fact of the account, by kind and key: a bulleted list, which `fitReply` collapses when it is long. */
export const describeFacts = (facts: FactRow[]): string =>
  facts.length === 0
    ? REPLY.factsNone
    : ['🧠 Esto es lo que sé de vos:', ...facts.map((f) => `${BULLET}${factText(f)}`)].join('\n')

/** Every live reminder, the next to come first. */
export const describeReminders = (rows: ReminderRow[], today: string): string =>
  rows.length === 0
    ? REPLY.remindersNone
    : [
        '⏰ Tus recordatorios:',
        ...rows.map((r) => `${BULLET}${r.what} — ${describeReminder(r, today)}`),
      ].join('\n')

/** The question before forgetting everything: code asks it, and only a bare "sí" answers it. */
export const forgetAllQuestion = (count: number): string =>
  `¿Seguro que querés que me olvide de todo lo que sé de vos (${count})? Respondé sí.`

/** The line for a part of the message that was not done, by why. */
export function skipLine(part: string, reason: SkipReason): string {
  switch (reason) {
    case 'not_found':
      return `No encontré ${part}.`
    case 'what_to_change':
      return `¿Qué querés cambiar ${/^el /i.test(part) ? `del ${part.slice(3)}` : `de ${part}`}?`
    case 'cannot':
      return `${capitalize(part)}: eso no lo puedo hacer.`
    case 'separately':
      return `Mandame ${part} aparte.`
  }
}

/**
 * The question of `ask_user`, from the movements it offers (the person's live ones, newest first) and what the answer will do.
 * Several options are numbered in the order shown, and the instruction says what a bare number will do; one option is shown as it is.
 */
export function askLine(options: MovementRow[], then: Then, today: string): string {
  // As v1 asked it: "¿Cuál?" whenever the answer is a choice or a yes to delete or correct what is shown, and "¿Qué querés
  // cambiar?" only for one option when the person gave no change (a "sí" asks what).
  const question = options.length > 1 || then.do !== 'ask_change' ? 'Cuál' : 'Qué querés cambiar'
  if (options.length === 0) return `¿${question}?`
  if (options.length === 1) {
    const [m] = options as [MovementRow]
    return `¿${question}? ${movementText(m)}${when(m.date, today)}${m.time ? ` · ${m.time}` : ''}`
  }
  const lines = options.map((m, k) => {
    const day = dayName(m.date, today)
    const suffix = m.date === today ? '' : day === 'ayer' ? ' de ayer' : ` del ${day}`
    return { number: k + 1, text: `${movementText(m)}${suffix}`, time: m.time }
  })
  const listed = lines
    .map((l) => {
      const alike = lines.filter((o) => o.text === l.text).length > 1
      return `${l.number}. ${l.text}${alike && l.time ? ` · ${l.time}` : ''}`
    })
    .join(' · ')
  const how =
    then.do === 'ask_change'
      ? 'Respondé con el número y el cambio, por ejemplo "el 1 fue 4100".'
      : 'Respondé con el número, por ejemplo "el 1".'
  return `¿${question}? ${listed}\n${how}`
}
