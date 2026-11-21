import type { MovementRow } from './ledger'
import { canonicalAmount, normalizeText } from './movement'
import type { Command } from './parse'
import { addDays } from './time'

type Targeting = Extract<Command, { type: 'correct' | 'delete' }>

/** A movement of the list the model was shown, with its number in it (1 is the newest). */
export interface Numbered {
  number: number
  movement: MovementRow
}

export type Resolution =
  | { kind: 'found'; movement: MovementRow }
  /** Nothing is changed; the reply asks which one, listing these (none: there is nothing to pick). */
  | { kind: 'ask'; candidates: Numbered[] }

export interface ResolveContext {
  /** What the person wrote. The model's `target` echoes the row it chose, so only this can tell. */
  text: string
  /** The Argentine day of the message. */
  today: string
}

const STOPWORDS = new Set([
  'last',
  'ultimo',
  'ultima',
  'ese',
  'esa',
  'eso',
  'del',
  'los',
  'las',
  'que',
  'con',
  'por',
  'para',
  'mis',
])

const words = (text: string) =>
  normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** 4-letter stems of the content words, so "super" matches "supermercado" and "cafe" "cafecito". */
const stems = (text: string) =>
  words(text)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map((word) => word.slice(0, 4))

/**
 * Whether the words name this movement: they share a stem with its description, or they are its
 * whole category name ("supermercado"). Never a stem of the category or the payment: "entrada"
 * must not find a Netflix because both start with "entr".
 */
export function namesMovement(target: string, m: MovementRow): boolean {
  const have = new Set(stems(m.description))
  if (stems(target).some((stem) => have.has(stem))) return true
  const content = words(target).filter((word) => !STOPWORDS.has(word) && word.length >= 3)
  return content.length > 0 && content.join(' ') === m.category.replaceAll('_', ' ')
}

const LAST = /^(last|(el |la |lo )?ultim[oa])$/

/** The amounts a person wrote in the message: "3500", "3.500", "3,5", "15 mil", "20k". */
function amountsIn(text: string): string[] {
  const norm = normalizeText(text).replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
  const thousands = [...norm.matchAll(/\b(\d+)\s*(?:mil|k|lucas?)\b/g)].map((m) => `${m[1]}000`)
  const plain = (norm.match(/\d[\d.,]*/g) ?? []).map((token) =>
    canonicalAmount(
      /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(token)
        ? token.replaceAll('.', '').replace(',', '.')
        : token.replace(/[.,]$/, '').replace(',', '.'),
    ),
  )
  return [...plain, ...thousands]
}

/** What the person's new values are: the details they say are not about the old row. */
type Changing = Partial<
  Pick<Extract<Command, { type: 'correct' }>['changes'], 'amount' | 'date' | 'payment'>
>

/**
 * The details of the message that this movement fits: its payment, its old amount, its day. A
 * value the person is setting ("fue 3800", "fue ayer", "con la visa") is the new value, not a
 * detail of the old row, so it is left out.
 */
function details(text: string, today: string, m: MovementRow, setting: Changing): Set<string> {
  const norm = normalizeText(text)
  const yesterday = addDays(today, -1)
  const fits = new Set<string>()
  const newPayment = new Set(stems(setting.payment ?? ''))
  const said = new Set(stems(text))
  for (const stem of stems(m.payment ?? '')) {
    if (said.has(stem) && !newPayment.has(stem)) fits.add(`payment:${stem}`)
  }
  const newAmount = setting.amount ? canonicalAmount(setting.amount) : null
  const old = canonicalAmount(m.amount)
  if (old !== newAmount && amountsIn(text).includes(old)) fits.add('amount')
  if (/\bhoy\b/.test(norm) && m.date === today && setting.date !== today) fits.add('day:today')
  if (/\bayer\b/.test(norm) && m.date === yesterday && setting.date !== yesterday) {
    fits.add('day:yesterday')
  }
  if (m.time) {
    const [hh = '', mm = ''] = m.time.split(':')
    for (const [, h = '', min] of norm.matchAll(
      /\blas?\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:mil|k|lucas?|pesos|usd))/g,
    )) {
      const hour = Number(h)
      if ((Number(hh) === hour || Number(hh) === hour + 12) && (min === undefined || min === mm)) {
        fits.add('time:clock')
      }
    }
    if (/\b(?:de|a)\s+(?:esta|la)\s+manana\b/.test(norm) && m.time < '12:00')
      fits.add('time:morning')
    if (/\b(?:de|a)\s+la\s+tarde\b/.test(norm) && m.time >= '12:00' && m.time < '19:00') {
      fits.add('time:afternoon')
    }
    if (/\b(?:de|a)\s+(?:esta|la)\s+noche\b/.test(norm) && m.time >= '19:00') fits.add('time:night')
    if (/\banoche\b/.test(norm) && m.date === yesterday && m.time >= '19:00')
      fits.add('time:last-night')
  }
  for (const [, d = '', mo = ''] of norm.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) {
    const suffix = `-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
    if (m.date.endsWith(suffix) && !setting.date?.endsWith(suffix)) fits.add('day:date')
  }
  return fits
}

const NUMBER_WORDS: Record<string, number> = {
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
}

/** "primero", "segunda", "tercer", "cuarta": positions of a list only the model can place. */
const ORDINAL = /\b(?:primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa])\b/

const CONNECTORS =
  '(?:fue|era|es|son|eran|por|a|con|en|borr\\w*|elimin\\w*|sac\\w*|quit\\w*|cancel\\w*|cambi\\w*|corrig\\w*|modific\\w*|pon\\w*|pas\\w*)'

/**
 * The positions the person's own message names, from 1 to `max`: a bare "2", or "el 2" / "la tres" /
 * "numero 4" followed by the end, a punctuation mark or a verb or connector ("el 2 fue 4500",
 * "borrá el 3", "el 2, bórralo"). Never an article before an amount or a date ("el 2.500", "el 1
 * luca", "el 3/11", "el 15 de octubre"), and never "no el 1" (a negation is not a second action).
 * "primero" and "anterior" name a position only the model can place: reported as 0, "use the
 * model's number". "Último" is handled by `saysLast`, since it can qualify a description.
 */
export function positionsIn(text: string, max = 99): number[] {
  const norm = normalizeText(text)
  const found: number[] = []
  const number = new RegExp(
    `(?<!\\bno\\s)(?:\\b(?:el|la|lo|numero|nro)\\s+|#\\s*)(\\d{1,2}|[a-z]+)(?=\\s*$|\\s*(?:,(?!\\d)|[;:!?])|\\s*\\.(?!\\d)|\\s+${CONNECTORS}\\b)`,
    'g',
  )
  for (const m of norm.matchAll(number)) {
    const word = m[1] ?? ''
    const n = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word]
    if (n !== undefined) found.push(n)
  }
  const bare = norm.match(/^\s*#?(\d{1,2})\s*[.!]?\s*$/)
  if (bare) found.push(Number(bare[1]))
  if (ORDINAL.test(norm) || /\banterior\b/.test(norm)) found.push(0)
  return [...new Set(found)].filter((n) => n <= max)
}

/** The message says "último/a" ("el último", "borrá lo último", "la última nafta"). */
export const saysLast = (text: string) => /\bultim[oa]\b/.test(normalizeText(text))

/** "Uno de los cafés estaba mal": one of several, not said which. */
export const saysOneOf = (text: string) =>
  /\buno\s+de\s+(?:los|las|mis)\b/.test(normalizeText(text))

/** "El otro café", "el anterior café": the one before the newest. */
export const saysOther = (text: string) =>
  /\b(?:el|la)\s+otr[oa]\b|\banterior\b/.test(normalizeText(text))

/** How many candidates a question lists when nothing is known. */
const ASK_FALLBACK = 3

/**
 * Turns the model's pointer into one stored movement, or into a question. `recent` is the list the
 * model saw, newest first. In order:
 * 1. A position in the person's own message ("el 2", "el último") wins, whatever the model's words
 *    say: the model's `target` only echoes the row it chose and has been wrong while its number was
 *    right. If the model's number is one of the positions named, it is used; else the first named.
 * 2. Otherwise the rows the words name are the candidates; the person's details (payment, old
 *    amount, hoy/ayer, dd/mm) narrow them, and the newest one left wins: a correction almost
 *    always means the movement just mentioned. The reply shows the choice (the old values and, when
 *    it is not from today, its date).
 * 3. Nothing named asks. "Last" is number 1; a different number alongside it is a contradiction and
 *    asks, and so does a low-confidence "last".
 */
export function resolveTarget(
  command: Targeting,
  recent: MovementRow[],
  ctx: ResolveContext,
): Resolution {
  const numbered = recent.map((movement, i) => ({ number: i + 1, movement }))
  const ask = (): Resolution => ({ kind: 'ask', candidates: numbered.slice(0, ASK_FALLBACK) })
  const [newest] = numbered
  if (!newest) return ask()

  const index = command.target_index
  const modelPick =
    index !== null && Number.isInteger(index) && index >= 1 && index <= recent.length
      ? index
      : undefined

  const named = numbered.filter((n) => namesMovement(command.target, n.movement))
  const askAbout = (): Resolution => ({
    kind: 'ask',
    candidates: named.length > 0 ? named : numbered.slice(0, ASK_FALLBACK),
  })
  // A position must be one of the rows the target's words name, or the model's own number (two
  // sources agree on it): "fue el 5 en la panadería" is not row 5 when the panadería is row 2.
  const fits = (n: number) =>
    named.length === 0 || named.some((x) => x.number === n) || modelPick === n

  const positions = positionsIn(ctx.text, recent.length)
  const said = positions.filter((n) => n >= 1)
  if (said.length > 0) {
    const n = modelPick !== undefined && said.includes(modelPick) ? modelPick : (said[0] ?? 1)
    return fits(n) ? { kind: 'found', movement: (numbered[n - 1] ?? newest).movement } : askAbout()
  }
  const setting = command.type === 'correct' ? command.changes : {}
  const narrowedNamed = named.filter(
    (n) => details(ctx.text, ctx.today, n.movement, setting).size > 0,
  )
  const candidates = narrowedNamed.length > 0 ? narrowedNamed : named
  // "El último café": the newest row the description names, whatever number the model gave.
  if (saysLast(ctx.text) && candidates.length > 0) {
    return { kind: 'found', movement: candidates[0]?.movement ?? newest.movement }
  }
  // "El otro café": the second newest of the rows the words name.
  if (saysOther(ctx.text) && candidates.length > 0) {
    const [, second] = candidates
    return second ? { kind: 'found', movement: second.movement } : askAbout()
  }
  // "Primero", "segunda"…: only the model can place them, and only on a row the words name.
  if (positions.includes(0)) {
    const pick = modelPick !== undefined ? numbered[modelPick - 1] : undefined
    return pick && named.some((x) => x.number === pick.number)
      ? { kind: 'found', movement: pick.movement }
      : askAbout()
  }

  // "El último" alone is number 1. With a description ("el último café", "la última nafta") it is
  // the newest row that description names, which the default below already is.
  if (saysLast(ctx.text) && named.length === 0 && command.confidence !== 'low') {
    return { kind: 'found', movement: newest.movement }
  }
  if (LAST.test(normalizeText(command.target))) {
    if (command.confidence === 'low') return ask()
    return index === null || index === 1 ? { kind: 'found', movement: newest.movement } : ask()
  }

  const [first] = candidates
  if (!first) return ask()
  // A confident model pick among the candidates stands (it may have understood a detail code
  // cannot parse: "el de la mañana"); otherwise the newest candidate wins.
  const pick =
    command.confidence === 'high' && modelPick !== undefined
      ? candidates.find((n) => n.number === modelPick)
      : undefined
  return { kind: 'found', movement: (pick ?? first).movement }
}

const SHAPE =
  /^(?:(?:dale|bueno|ok|si)[,\s]+)?(?:(?:el|la|lo|numero|nro)\s*|#\s*)?(\d{1,2}|[a-z]+)\s*[.!]?$/
const YES = /^(?:(?:si|dale|ok|bueno)[,\s]*)+[.!]?$/
const ORDINAL_INDEX: [RegExp, number][] = [
  [/^primer[oa]?$/, 0],
  [/^segund[oa]$/, 1],
  [/^tercer[oa]?$/, 2],
  [/^cuart[oa]$/, 3],
]

/**
 * Which of the options of a `¿Cuál?` question (`asked`: the list numbers it showed, in order) a
 * message picks, when the message is only that answer: "2", "el 2", "la tres", "el primero" /
 * "la segunda" (the first, second… option shown, not list rows), "el último" (row 1), or "sí" /
 * "dale" / "sí, dale" after a one-option question. Anything with more in it (a change, a
 * description) is not an answer.
 */
export function answerNumber(text: string, asked: number[]): number | null {
  const norm = normalizeText(text)
  if (YES.test(norm)) return asked.length === 1 ? (asked[0] ?? null) : null
  const token = SHAPE.exec(norm)?.[1]
  if (token === undefined) return null
  const ordinal = ORDINAL_INDEX.find(([re]) => re.test(token))
  const n = /^\d+$/.test(token)
    ? Number(token)
    : ordinal
      ? asked[ordinal[1]]
      : /^ultim[oa]$/.test(token)
        ? 1
        : NUMBER_WORDS[token]
  return n !== undefined && asked.includes(n) ? n : null
}
