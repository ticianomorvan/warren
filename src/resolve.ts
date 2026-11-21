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
  const norm = normalizeText(text)
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

/** The details of the message that this movement fits: its payment, its old amount, its day. */
function details(text: string, today: string, m: MovementRow): Set<string> {
  const norm = normalizeText(text)
  const fits = new Set<string>()
  const said = new Set(stems(text))
  for (const stem of stems(m.payment ?? '')) if (said.has(stem)) fits.add(`payment:${stem}`)
  if (amountsIn(text).includes(canonicalAmount(m.amount))) fits.add('amount')
  if (/\bhoy\b/.test(norm) && m.date === today) fits.add('day:today')
  if (/\bayer\b/.test(norm) && m.date === addDays(today, -1)) fits.add('day:yesterday')
  for (const [, d = '', mo = ''] of norm.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) {
    if (m.date.endsWith(`-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`)) fits.add('day:date')
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

/**
 * The positions the person's own message names: "el 2", "la tres", "el último", a bare "2". Not
 * "el 15 de octubre", "el 3 mil" or "el 20 lucas" (dates and amounts). "primero" and "anterior"
 * name a position only the model can place, so they are reported as 0 ("use the model's number").
 */
export function positionsIn(text: string): number[] {
  const norm = normalizeText(text)
  const found: number[] = []
  const numbered =
    /\b(?:el|la|lo|del|numero|nro|n°|#)\s*(\d{1,2}|[a-z]+)\b(?!\s*(?:de|mil|lucas|k)\b)/g
  for (const m of norm.matchAll(numbered)) {
    const word = m[1] ?? ''
    const n = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word]
    if (n !== undefined) found.push(n)
  }
  const bare = norm.match(/^\s*#?(\d{1,2})\s*[.!]?\s*$/)
  if (bare) found.push(Number(bare[1]))
  if (/\bultim[oa]/.test(norm)) found.push(1)
  if (/\b(primer[oa]?|anterior)\b/.test(norm)) found.push(0)
  return [...new Set(found)]
}

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

  const positions = positionsIn(ctx.text).filter((n) => n <= recent.length)
  const said = positions.filter((n) => n >= 1)
  if (said.length > 0) {
    const n = modelPick !== undefined && said.includes(modelPick) ? modelPick : (said[0] ?? 1)
    return { kind: 'found', movement: (numbered[n - 1] ?? newest).movement }
  }
  if (positions.includes(0) && modelPick !== undefined) {
    return { kind: 'found', movement: (numbered[modelPick - 1] ?? newest).movement }
  }

  if (LAST.test(normalizeText(command.target))) {
    if (command.confidence === 'low') return ask()
    return index === null || index === 1 ? { kind: 'found', movement: newest.movement } : ask()
  }

  const named = numbered.filter((n) => namesMovement(command.target, n.movement))
  const [first] = named
  if (!first) return ask()
  const narrowed = named.filter((n) => details(ctx.text, ctx.today, n.movement).size > 0)
  const [winner = first] = narrowed.length > 0 ? narrowed : named
  return { kind: 'found', movement: winner.movement }
}
