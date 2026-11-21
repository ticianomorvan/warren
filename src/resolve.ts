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

/** The person gave a position that is the picked row's: "el 3", "el último", "el primero". */
function explicitPosition(text: string, pickedNumber: number): boolean {
  const norm = normalizeText(text)
  const numbers = [...norm.matchAll(/\b(?:el|la|lo|del)\s+(\d{1,2})\b(?!\s*(?:de|mil|lucas|k)\b)/g)]
  if (numbers.length > 0) return numbers.some((m) => Number(m[1]) === pickedNumber)
  if (/\bultim[oa]/.test(norm)) return pickedNumber === 1
  return /\b(primer[oa]?|anterior)\b/.test(norm)
}

/** The person's text says something that fits the picked row and none of the other matches. */
function setsApart(text: string, today: string, picked: Numbered, others: Numbered[]): boolean {
  const mine = details(text, today, picked.movement)
  const theirs = others.map((o) => details(text, today, o.movement))
  return [...mine].some((d) => theirs.every((t) => !t.has(d)))
}

/** How many candidates a question lists when nothing narrower is known. */
const ASK_FALLBACK = 3

/**
 * Turns the model's pointer into one stored movement, or into a question. `recent` is the list the
 * model saw, newest first. A wrong row is worse than a question, so it asks whenever it is not
 * sure: low confidence, nothing named, a number that its words contradict, or words that fit
 * several movements with nothing in the person's own message (a position, or a detail such as
 * the payment, the old amount or the day) that points at one of them. The question's answer
 * carries a number, so it never loops.
 */
export function resolveTarget(
  command: Targeting,
  recent: MovementRow[],
  ctx: ResolveContext,
): Resolution {
  const numbered = recent.map((movement, i) => ({ number: i + 1, movement }))
  const isLast = LAST.test(normalizeText(command.target))
  const named = isLast ? [] : numbered.filter((n) => namesMovement(command.target, n.movement))
  const ask = (): Resolution => ({
    kind: 'ask',
    candidates: named.length >= 1 ? named : numbered.slice(0, ASK_FALLBACK),
  })
  const [newest] = numbered
  if (command.confidence === 'low' || !newest) return ask()

  const index = command.target_index
  if (isLast) {
    // "Last" is number 1; a different number is a contradiction, not a hint.
    return index === null || index === 1 ? { kind: 'found', movement: newest.movement } : ask()
  }

  const picked =
    index !== null && Number.isInteger(index) && index >= 1 && index <= recent.length
      ? numbered[index - 1]
      : undefined
  if (picked && namesMovement(command.target, picked.movement)) {
    const others = named.filter((n) => n !== picked)
    const sure =
      others.length === 0 ||
      explicitPosition(ctx.text, picked.number) ||
      setsApart(ctx.text, ctx.today, picked, others)
    return sure ? { kind: 'found', movement: picked.movement } : ask()
  }
  const [only] = named
  return named.length === 1 && only ? { kind: 'found', movement: only.movement } : ask()
}
