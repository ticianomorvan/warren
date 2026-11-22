import type { Movement, RecentMovement } from './agent'
import type { ReminderOutcome } from './apply'
import type { FactRow } from './facts'
import type { MovementRow } from './ledger'
import { type ChangedField, changedFields } from './movement'
import type { ReminderRow } from './reminders/db'
import { describeReminder, describeSchedule } from './reminders/describe'
import { addDays } from './time'
import type { Undone } from './undo'
import type { MediaProblem } from './whatsapp/graph'

export const REPLY_NON_TEXT = 'Por ahora solo entiendo texto y fotos.'
/** A voice note when no transcription service is configured. */
export const REPLY_AUDIO = 'Todavía no entiendo audios. Escribime el gasto y lo anoto.'
/** What the person is told when a voice note cannot be used, by why. Not a failure of the message: code answers, no model. */
export const REPLY_VOICE = {
  too_large: 'El audio es muy largo para escucharlo. Mandalo más corto o escribime el gasto.',
  unsupported: 'No puedo leer ese tipo de audio. Mandame una nota de voz o escribime el gasto.',
  /** A download that failed, the transcription service down or too slow. */
  failed: 'No pude procesar el audio, ¿me lo escribís?',
  /** The confidence gate refused it: noise, silence, or too unsure to act on. */
  unclear: 'No te entendí el audio, ¿me lo escribís?',
} as const
/**
 * WhatsApp refuses a text body over 4,096 characters with a permanent error, and a reply that cannot be sent
 * after its changes were committed is a silent write. Replies stay under this, with room to spare.
 */
export const MAX_REPLY_CHARS = 4000

const BULLET = '• '
/** `text` in at most `max` UTF-16 units (what WhatsApp's limit and `.length` count), ending in "…" when cut, never inside an emoji. */
const cut = (text: string, max: number) => {
  if (text.length <= max) return text
  let out = ''
  for (const char of text) {
    if (out.length + char.length > max - 1) break
    out += char
  }
  return `${out}…`
}

/**
 * The reply to send: what was heard (voice only, and only when `heard` is given), the record lines code rendered,
 * then the model's own words, one per line, held under `max` characters. When they do not fit, in this order: the
 * model's words go (they add nothing the record lacks), and long bulleted lists in the record are collapsed to
 * their first items and "• … y N más". A record is never dropped without saying so: lines that still do not fit
 * end as "… y N más", and a single line is cut with "…" as a last resort.
 */
export function fitReply(
  parts: { heard?: string; lines: string[]; notes: string[] },
  max = MAX_REPLY_CHARS,
): string {
  const join = (heard: string | undefined, lines: string[], notes: string[]) =>
    [...(heard === undefined ? [] : [renderHeard(heard)]), ...lines, ...notes].join('\n')
  const { heard } = parts
  let { notes } = parts
  const whole = () => join(heard, parts.lines, notes)
  if (whole().length <= max) return whole()

  notes = []
  if (whole().length <= max) return whole()

  // Collapse the longest bulleted list, one item at a time.
  const blocks = parts.lines.map((line) => line.split('\n'))
  const hidden = blocks.map(() => 0)
  const lines = () =>
    blocks.map((rows, k) =>
      [...rows, ...(hidden[k] ? [`${BULLET}… y ${hidden[k]} más`] : [])].join('\n'),
    )
  const items = (rows: string[]) => rows.filter((r) => r.startsWith(BULLET)).length
  for (;;) {
    if (join(heard, lines(), notes).length <= max) return join(heard, lines(), notes)
    let longest = -1
    for (const [k, rows] of blocks.entries()) {
      if (items(rows) > 1 && (longest < 0 || items(rows) > items(blocks[longest] ?? [])))
        longest = k
    }
    if (longest < 0) break
    const rows = blocks[longest] ?? []
    const last = rows.map((r) => r.startsWith(BULLET)).lastIndexOf(true)
    rows.splice(last, 1)
    hidden[longest] = (hidden[longest] ?? 0) + 1
  }
  // Still too long with nothing left to collapse: keep the first lines that fit and say how many more there are.
  const all = lines()
  for (let keep = all.length - 1; keep >= 1; keep--) {
    const text = join(heard, [...all.slice(0, keep), `… y ${all.length - keep} más`], notes)
    if (text.length <= max) return text
  }
  return cut(join(heard, all, notes), max)
}

/** The most of what was heard that the 🎙️ line shows. */
export const MAX_HEARD_CHARS = 80

/**
 * The first line of the reply to a voice note that changed nothing: what was heard, so that a mishearing shows
 * before the person answers it. When something was logged, corrected or deleted, the record shows what was
 * understood and this line is left out (`execute`).
 */
export const renderHeard = (transcript: string) => `🎙️ "${cut(transcript, MAX_HEARD_CHARS)}"`
/** What the person is told when a photo cannot be read, by why. */
export const REPLY_IMAGE: Record<MediaProblem, string> = {
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
/** The help's line about cutting an agent's access: only where connecting an agent is on. */
const REPLY_HELP_DISCONNECT =
  'Si conectaste a Claude u otro agente y querés cortarle el acceso, escribime "desconectar".'
const REPLY_HELP =
  'Mandame un gasto o un ingreso y lo anoto. Por ejemplo: "café 3500 con la visa" o "cobré el sueldo 850.000".\nTambién te aviso de lo que me pidas: "recordame pagar la Visa el 10" o "todos los lunes recordame la pastilla". "¿Qué recordatorios tengo?" los lista, y pedime que cancele el que quieras o todos.'

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

export const CATEGORY_LABEL: Record<RecentMovement['category'], string> = {
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

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

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
  const date = changed.includes('date') && after.date === today ? ' · hoy' : when(after.date, today)
  const category = changed.includes('category') ? ` · ${CATEGORY_LABEL[after.category]}` : ''
  return `✓ Corregido: ${movementText(after)}${date}${category} (antes ${wasText(before, changed, today)})${logged(before.time, newest)}`
}

/** The fields of `before` named in `changed`, as they were: "$2.900, hoy". */
function wasText(before: RecentMovement, changed: ChangedField[], today: string): string {
  const was = {
    money: `${before.direction === 'in' ? '+' : ''}${formatMoney(before.amount, before.currency)}`,
    date: dayName(before.date, today),
    description: before.description.trim(),
    category: CATEGORY_LABEL[before.category],
    payment: before.payment?.trim() || 'sin medio de pago',
  }
  return changed.map((field) => was[field]).join(', ')
}

export const renderUnchanged = (m: RecentMovement, today: string) =>
  `Ya figura así: ${movementText(m)}${when(m.date, today)}`

export const renderDeletion = (m: RecentMovement, today: string, newest = true) =>
  `✓ Borré: ${movementText(m)}${when(m.date, today)}${logged(m.time, newest)}`

/** Connecting an agent (claude.ai, Claude Code) to the person's account, over WhatsApp (docs/mcp-spec.md, Design 3). */
export const REPLY_LINK = {
  /** The one answer to a code that does not work: unknown, expired or already used. It says nothing about which. */
  refused: 'Ese código no sirve: venció o ya se usó. Pedí uno nuevo desde la pantalla de conexión.',
  ask: (client: string) =>
    `¿Conectar ${client} a tu cuenta de Warren? Va a poder ver y anotar tus movimientos. Respondé sí o no.`,
  done: (client: string) => `Listo, ${client} ya está conectado. Volvé a la pantalla de conexión.`,
  declined: 'Está bien, no conecté nada.',
}

/** "desconectar": what was cut. */
export const REPLY_DISCONNECT = {
  none: 'No tenés ninguna conexión activa con Claude u otro agente.',
  done: (n: number) =>
    `Listo, desconecté ${n === 1 ? '1 conexión' : `${n} conexiones`}: ya no pueden ver ni anotar nada. Para volver a conectar, empezá de nuevo desde Claude.`,
}

export const REPLY_UNDO_NOTHING = 'No tengo nada para deshacer.'
export const REPLY_UNDO_EXPIRED =
  'Lo último que hice fue hace más de 24 horas y ya no lo deshago solo. Decime qué querés corregir o borrar.'

/** What undoing the last batch did to one movement, or one fact. Code writes the record from it, never the model. */
export type UndoLine =
  | {
      kind: 'logged' | 'corrected' | 'deleted'
      /** The movement as it is after the undo (a logged one: as it was when removed). */
      movement: RecentMovement
      /** `corrected` only: the movement as the correction had left it. */
      from?: RecentMovement
      /** `corrected` only: the fields the undo changed back. */
      changed?: ChangedField[]
    }
  /** A fact the batch stored is forgotten now; one the batch forgot is back; one the batch updated has its old value back (`was` is the value undone). */
  | { kind: 'fact_removed'; fact: FactRow }
  | { kind: 'fact_restored'; fact: FactRow }
  | { kind: 'fact_reverted'; fact: FactRow; was: string }
  /** A reminder the batch set is cancelled now; one the batch cancelled is back (`reminder` as it stands after the undo). */
  | { kind: 'reminder_removed'; reminder: ReminderRow }
  | { kind: 'reminder_restored'; reminder: ReminderRow }

/** An undone movement as the record shows it: what it is after the undo, and what a restored correction was before. */
export function undoLine(u: Undone): UndoLine {
  if (
    u.kind === 'fact_removed' ||
    u.kind === 'fact_restored' ||
    u.kind === 'fact_reverted' ||
    u.kind === 'reminder_removed' ||
    u.kind === 'reminder_restored'
  )
    return u
  if (u.kind === 'corrected') {
    return { kind: u.kind, movement: u.to, from: u.from, changed: changedFields(u.from, u.to) }
  }
  return { kind: u.kind, movement: u.movement }
}

type MovementUndo = Extract<UndoLine, { movement: RecentMovement }>

/**
 * The record of an undo. Only logs undone: `↩︎ Deshice: Súper $5.000 · Panadería $3.000`. Anything else (a correction
 * or a delete undone, alone or mixed) is a bulleted list that says what happened to each.
 */
export function renderUndo(lines: UndoLine[], today: string): string {
  const dated = (m: RecentMovement) => `${movementText(m)}${when(m.date, today)}`
  const logs = lines.filter((l): l is MovementUndo => l.kind === 'logged')
  if (logs.length === lines.length) {
    return `↩︎ Deshice: ${logs.map((l) => dated(l.movement)).join(' · ')}`
  }
  const bullets = lines.map((l) => {
    if (l.kind === 'fact_removed') return `Olvidé 🧠 ${renderFact(l.fact)}`
    if (l.kind === 'fact_restored') return `Volvió 🧠 ${renderFact(l.fact)}`
    if (l.kind === 'fact_reverted') {
      return `🧠 ${renderFact(l.fact)} (estaba ${factValue({ kind: l.fact.kind, value: l.was })})`
    }
    if (l.kind === 'reminder_removed') return `Quité ⏰ ${l.reminder.what}`
    if (l.kind === 'reminder_restored') return `Volvió ⏰ ${renderReminderBrief(l.reminder, today)}`
    if (l.kind === 'logged') return `Quité ${dated(l.movement)}`
    if (l.kind === 'deleted') return `Volvió ${dated(l.movement)}`
    const was = l.from && l.changed ? ` (estaba ${wasText(l.from, l.changed, today)})` : ''
    return `${dated(l.movement)}${was}`
  })
  return ['↩︎ Deshice:', ...bullets.map((b) => `${BULLET}${b}`)].join('\n')
}

/** The refusal of an undo whose movements changed since the batch: which ones, and that nothing was touched. */
export const renderStale = (
  moved: RecentMovement[],
  today: string,
  facts: FactRow[] = [],
  reminders: ReminderRow[] = [],
): string => {
  const what = [
    ...moved.map((m) => `${movementText(m)}${when(m.date, today)}`),
    ...facts.map((f) => `🧠 ${renderFact(f)}`),
    ...reminders.map((r) => `⏰ ${r.what}`),
  ]
  return `No deshice nada: ${what.join(' · ')} ${what.length === 1 ? 'cambió' : 'cambiaron'} después. Decime qué querés cambiar.`
}

// ---- Reminders (slice 6). Every line about a reminder is code's, from the stored row and its schedule.

/** A reminder set for a time that has passed: the person says when, the model is not asked to guess. */
export const REPLY_REMINDER_PAST =
  'Esa fecha y hora ya pasaron: decime para cuándo querés que te avise.'
/** A first occurrence more than a year away. */
export const REPLY_REMINDER_FAR =
  'Solo puedo avisarte de cosas que pasan en el próximo año: decime una fecha más cercana.'
export const REPLY_REMINDER_GONE = '⏰ Ese recordatorio ya no existe.'
export const REPLY_REMINDERS_NONE = 'No tenés recordatorios.'
/** The account holds the most reminders already: nothing was set. */
export const renderRemindersFull = (max: number) =>
  `Ya tenés ${max} recordatorios y no me entran más. Cancelá uno y pedime este de nuevo.`
/** The line a text is ended with: no second full stop after the person's own punctuation. */
const stop = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)

/** A reminder as it was understood: what code will send, and when, rendered from the schedule. */
export const renderReminderSet = (r: ReminderRow, today: string) =>
  `⏰ Te aviso ${r.nextDueAt ? describeSchedule(r.schedule, r.nextDueAt, today) : ''}: ${stop(r.what)}`

/** "tomar la pastilla (todos los lunes y jueves a las 09:00)": a reminder in a list, a cancel or an undo. */
export const renderReminderBrief = (r: ReminderRow, today: string) =>
  `${r.what} (${r.nextDueAt ? describeSchedule(r.schedule, r.nextDueAt, today, { since: false }) : 'ya pasó'})`

export const renderReminderCancelled = (r: ReminderRow, today: string) =>
  `⏰ Cancelé el recordatorio: ${renderReminderBrief(r, today)}`

/** Every live reminder, the next to come first: a bulleted list, which `fitReply` collapses when it is long. */
export const renderReminders = (rows: ReminderRow[], today: string) =>
  rows.length === 0
    ? REPLY_REMINDERS_NONE
    : [
        '⏰ Tus recordatorios:',
        ...rows.map((r) => `${BULLET}${r.what} — ${describeReminder(r, today)}`),
      ].join('\n')

/** The line a reminder write comes to, and its outcome for the step list (`applied`, `gone`, `full`...): one place for all three. */
export function reminderReply(
  done: ReminderOutcome,
  today: string,
  max: number,
): { line: string; outcome: string } {
  switch (done.tool) {
    case 'set_reminder':
      if (done.kind === 'applied') {
        return { line: renderReminderSet(done.reminder, today), outcome: 'applied' }
      }
      return {
        line: done.kind === 'full' ? renderRemindersFull(max) : REPLY_REMINDER_PAST,
        outcome: done.kind,
      }
    case 'cancel_reminder':
      return done.kind === 'gone'
        ? { line: REPLY_REMINDER_GONE, outcome: 'gone' }
        : { line: renderReminderCancelled(done.reminder, today), outcome: 'applied' }
  }
}

// ---- Memory (agent slice F). Every line about a fact is code's, from the stored row.

/** What a secret is answered with: nothing was stored. */
export const REPLY_FACT_SECRET = 'No guardo claves, números de tarjeta, CBU/CVU ni documentos.'
/** What a phone number or an email is answered with: nothing was stored. */
export const REPLY_FACT_CONTACT = 'No guardo datos de contacto: teléfonos ni mails.'
export const REPLY_FACTS_NONE = 'Todavía no tengo nada anotado de vos.'
export const REPLY_FACT_GONE = '🧠 Eso ya lo había olvidado.'
/** The most facts one account holds, and what to do about it. */
export const renderFactsFull = (max: number) =>
  `Ya tengo ${max} cosas anotadas de vos y no me entran más. Decime de cuál me olvido y lo guardo.`

/** A fact's value as a person reads it: a category by its label. */
function factValue(f: Pick<FactRow, 'kind' | 'value'>): string {
  return f.kind === 'category'
    ? (CATEGORY_LABEL[f.value as RecentMovement['category']] ?? f.value)
    : f.value
}

/** `la visa = Galicia` (an alias), `café → Entretenimiento` (a category), `cobro: el 5` (a note). */
export function renderFact(f: Pick<FactRow, 'kind' | 'key' | 'value'>): string {
  if (f.kind === 'alias') return `${f.key} = ${f.value}`
  return f.kind === 'category' ? `${f.key} → ${factValue(f)}` : `${f.key}: ${f.value}`
}

/** A fact stored, or updated (`before` is the old value). */
export const renderRemembered = (f: FactRow, before?: string) =>
  `🧠 Me acuerdo: ${renderFact(f)}${before === undefined ? '' : ` (antes ${factValue({ kind: f.kind, value: before })})`}`
export const renderKnown = (f: FactRow) => `🧠 Ya lo tenía anotado: ${renderFact(f)}`
export const renderForgot = (f: FactRow) => `🧠 Me olvidé: ${renderFact(f)}`
export const renderForgotNone = (key: string) => `🧠 No tengo nada anotado de "${key}".`
/** The question before forgetting everything: code asks it, and only a bare "sí" answers it. */
export const renderForgetAllAsk = (count: number) =>
  `¿Seguro que querés que me olvide de todo lo que sé de vos (${count})? Respondé sí.`
export const renderForgotAll = (count: number) =>
  `🧠 Me olvidé de todo lo que sabía de vos (${count}).`

/** Every fact of the account, by kind and key: a bulleted list, which `fitReply` collapses when it is long. */
export const renderFacts = (facts: FactRow[]) =>
  facts.length === 0
    ? REPLY_FACTS_NONE
    : ['🧠 Esto es lo que sé de vos:', ...facts.map((f) => `${BULLET}${renderFact(f)}`)].join('\n')

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

export interface RenderOptions {
  /** Connecting an agent over MCP is on: the help tells how to cut it ("desconectar"). */
  disconnect?: boolean
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
  const help = o.disconnect ? `${REPLY_HELP}\n${REPLY_HELP_DISCONNECT}` : REPLY_HELP
  return o.helpContact ? `${help}\nSi necesitás hablar con una persona: ${o.helpContact}` : help
}
