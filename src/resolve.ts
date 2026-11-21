import { type MovementRow, normalizeText } from './ledger'
import type { Command } from './parse'

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

/** 4-letter stems of the content words, so "super" matches "supermercado" and "cafe" "cafecito". */
const stems = (text: string) =>
  normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map((word) => word.slice(0, 4))

/** Whether the words the person used name this movement: its description, category or payment. */
export function namesMovement(target: string, m: MovementRow): boolean {
  const have = new Set(
    stems(`${m.description} ${m.category.replaceAll('_', ' ')} ${m.payment ?? ''}`),
  )
  return stems(target).some((stem) => have.has(stem))
}

/** How many candidates a question lists when nothing narrower is known. */
const ASK_FALLBACK = 3

/**
 * Turns the model's pointer into one stored movement, or into a question. `recent` is the list the
 * model saw, newest first. The number is trusted only when the words agree with the row it names
 * ("last" agrees with number 1), so an off-by-one from the model hits nothing; then the words
 * decide: "last", or the one movement they name. A low-confidence command, no match, or several
 * matches ask instead of guessing: a wrong row is worse than a question.
 */
export function resolveTarget(command: Targeting, recent: MovementRow[]): Resolution {
  const numbered = recent.map((movement, i) => ({ number: i + 1, movement }))
  const target = normalizeText(command.target)
  const isLast = target === 'last'
  const named = numbered.filter((n) => !isLast && namesMovement(command.target, n.movement))
  const ask = (): Resolution => ({
    kind: 'ask',
    candidates: named.length > 1 ? named : numbered.slice(0, ASK_FALLBACK),
  })
  if (command.confidence === 'low' || recent.length === 0) return ask()

  const index = command.target_index
  const picked =
    index !== null && Number.isInteger(index) && index >= 1 && index <= recent.length
      ? numbered[index - 1]
      : undefined
  if (picked) {
    const agrees = isLast ? picked.number === 1 : namesMovement(command.target, picked.movement)
    if (agrees) return { kind: 'found', movement: picked.movement }
  }

  const [newest] = recent
  if (isLast && newest) return { kind: 'found', movement: newest }
  const [only] = named
  if (named.length === 1 && only) return { kind: 'found', movement: only.movement }
  return ask()
}
