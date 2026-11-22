import { normalizeText } from '../movement'
import { hasForeignDigit, unwritten } from './say'
import { CATEGORIES, FACT_KINDS, type FactKind } from './schema'

/** The most live facts one account holds. A person who reaches it is told, and forgets one to make room. */
export const MAX_FACTS = 100
/** The most facts the model is shown per message (the newest). Code lists them all on request. */
export const CONTEXT_FACTS = 30
export const MAX_KEY = 40
export const MAX_VALUE = 100

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

/**
 * Words that mark a secret. Matched against the folded text, whole words only. "dni" and the bank ids are here
 * because a person who says "mi dni es ..." is giving Warren something it must not keep.
 */
const SECRET_WORDS =
  /\b(?:contrasena|contrasenas|clave|claves|password|passwords|passwd|pin|cvv|cvc|token|dni|cbu|cvu|home ?banking|codigo de seguridad)\b/

/** 13 or more digits, whatever separates them: a card (16), a CBU or CVU (22). */
const LONG_DIGITS = /(?:\d[ .-]?){13,}/
/** A DNI: 8 digits, plain or dotted (`12345678`, `12.345.678`). Only checked in what would be stored. */
const DNI = /(?<![\d.])(?:\d{2}\.\d{3}\.\d{3}|\d{8})(?![\d.]|,\d)/

/**
 * Whether a text looks like something Warren must never keep: a card number, a CBU/CVU, a password or PIN, a DNI.
 * `stored` is text that would go into a fact (the 8-digit DNI shape is only a secret there: in a message it can be
 * an amount, `12.345.678`).
 */
export function looksSecret(text: string, stored = true): boolean {
  const folded = normalizeText(text.normalize('NFKC'))
  return SECRET_WORDS.test(folded) || LONG_DIGITS.test(folded) || (stored && DNI.test(folded))
}

export interface FactInput {
  kind: FactKind
  key: string
  value: string
}

export type FactCheck =
  | { ok: true; fact: FactInput }
  /** What the model is told, to send it again. */
  | { ok: false; message: string }
  /** A secret: nothing is stored and the person is told so (the model is not asked to fix it). */
  | { ok: false; secret: true }

/**
 * The rules of a fact before it is stored, none of them the model's to waive:
 * - it is a secret (a card or CBU number, a password, a DNI): refused, and the person is told so;
 * - the key is 1 to 4 short words and the value fits, and a `category` value is one of the categories;
 * - the person said it: the key (an alias also accepts the value) are words of their message, so a model
 *   cannot remember something it only inferred;
 * - every number in it is a number the person wrote (`cobro el 5` keeps its 5; a model's 4509 is refused).
 * `message` is the person's own message, or what was heard in a voice note.
 */
export function checkFact(input: FactInput, message: string): FactCheck {
  const key = normalizeKey(input.key)
  const value = tidy(input.value)
  const stored = `${key} ${value}`
  if (looksSecret(stored) || looksSecret(message, false)) return { ok: false, secret: true }
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
