import { hasForeignDigit, unwritten } from '../core/numbers'
import { looksContact, looksSecret, sensitive } from '../core/secrets'
import { normalizeText } from '../movement'
import { CATEGORIES, FACT_KINDS, type FactKind } from './schema'

/** The most live facts one account holds. A person who reaches it is told, and forgets one to make room. */
export const MAX_FACTS = 100
/** The most facts the model is shown per message (the newest). Code lists them all on request. */
export const CONTEXT_FACTS = 30
export const MAX_KEY = 40
export const MAX_VALUE = 100
/** The most facts shown beyond the newest ones because the message says their key. */
export const MAX_MATCHED_FACTS = 20

/** The sent text of a fact: whitespace squashed, and the characters that could close a tag or a quote swapped for a space. */
export const tidy = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[<>"“”\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** How a key is compared and stored: lowercase, no accents, no punctuation, single spaces ("¡El Chino!" is "el chino"). */
export const normalizeKey = (key: string) =>
  normalizeText(tidy(key))
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Two values are the same fact when they only differ in case, accents or spacing. */
export const sameValue = (a: string, b: string) => normalizeText(tidy(a)) === normalizeText(tidy(b))

export interface FactInput {
  kind: FactKind
  key: string
  value: string
}

export type FactCheck =
  | { ok: true; fact: FactInput }
  /** What the model is told, to send it again. */
  | { ok: false; message: string }
  /** A secret or contact data: nothing is stored and the person is told so (the model is not asked to fix it). */
  | { ok: false; refused: 'secret' | 'contact' }

/**
 * The value rules of a fact, whoever sends it: a secret (a card or CBU number, a password, a DNI) or contact data (an email,
 * a phone) is refused and the sender told so; the key is 1 to 4 short words, the value fits, a `category` value is one of the
 * categories. `messageHasSecret`: the message the fact came with held a secret (a conversation's). Nothing about whose words they are.
 */
export function checkFactValues(input: FactInput, messageHasSecret = false): FactCheck {
  const key = normalizeKey(input.key)
  const value = tidy(input.value)
  const stored = `${key} ${value}`
  // What the model would store, as it wrote it (a key loses its punctuation and a card number its separators).
  const raw = `${tidy(input.key)} ${value}`
  // A phone number with its country code is as long as a card number: it is contact data, not a secret.
  const contact = looksContact(raw)
  if (contact && /\+\d/.test(raw)) return { ok: false, refused: 'contact' }
  if (looksSecret(raw) || messageHasSecret) return { ok: false, refused: 'secret' }
  if (contact) return { ok: false, refused: 'contact' }
  const why = (message: string): FactCheck => ({ ok: false, message })

  if (!(FACT_KINDS as readonly string[]).includes(input.kind)) return why('unknown kind')
  if (hasForeignDigit(stored)) return why('digits that are not 0-9')
  if (key === '') return why('key is empty: it is the words the person used')
  if (key.length > MAX_KEY || key.split(' ').length > 4) {
    return why(`key is too long: at most 4 words and ${MAX_KEY} characters`)
  }
  if (value === '') return why('value is empty')
  if (value.length > MAX_VALUE) return why(`value is too long: at most ${MAX_VALUE} characters`)
  if (input.kind === 'category' && !(CATEGORIES as readonly string[]).includes(value)) {
    return why(`for a category fact the value is exactly one of: ${CATEGORIES.join(', ')}`)
  }
  return { ok: true, fact: { kind: input.kind, key, value } }
}

/**
 * The rules of a fact before it is stored, none of them the model's to waive:
 * - it is a secret (a card or CBU number, a password, a DNI) or contact data (an email, a phone): refused, and the person is told so;
 * - the key is 1 to 4 short words and the value fits, and a `category` value is one of the categories;
 * - the person said it: the key (an alias also accepts the value) are words of their message, so a model
 *   cannot remember something it only inferred;
 * - every number in it is a number the person wrote (`cobro el 5` keeps its 5; a model's 4509 is refused).
 * `message` is the person's own message, or what was heard in a voice note.
 */
export function checkFact(input: FactInput, message: string): FactCheck {
  const checked = checkFactValues(input, sensitive(message))
  if (!checked.ok) return checked
  const { key, value } = checked.fact
  const stored = `${key} ${value}`
  const why = (message: string): FactCheck => ({ ok: false, message })
  // The person's own words: the key, or for an alias either side (the other may be in your terms: "la visa" is "crédito visa").
  const said = normalizeKey(message)
  const inMessage = (words: string) => words !== '' && said.includes(words)
  const traced =
    input.kind === 'alias' ? inMessage(key) || inMessage(normalizeKey(value)) : inMessage(key)
  if (!traced) {
    return why(
      'the key must be words the person wrote in this message; remember only what they state, never what you inferred (if unsure, ask with reply)',
    )
  }
  const made = unwritten(stored, message)
  if (made.length > 0) {
    return why(
      `numbers the person did not write: ${[...new Set(made)].join(', ')}. A fact holds only numbers they wrote; leave them out`,
    )
  }
  return { ok: true, fact: { kind: input.kind, key, value } }
}
