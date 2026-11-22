/**
 * What Warren must never keep, pure: a card or CBU number, a password or PIN, a DNI, contact data (an email, a phone). The same
 * rules decide what a fact, a reminder's text and a log may hold, and what is wiped from the record of a message (`sensitive`).
 */
import { fold as foldAccents } from './numbers'

const fold = (text: string) => foldAccents(text.normalize('NFKC')).trim()

/** Words that name a credential wherever they are said: a password, a PIN, a security code. Whole words, on folded text. */
const CREDENTIAL_WORDS =
  /\b(?:contrasenas?|claves?|passwords?|passwd|pin|cvv|cvc|token|home ?banking|codigo de seguridad)\b/
/** More words that mark a secret in what would be stored: "el código del cajero es 1234". */
const STORED_WORDS = /\b(?:codigos?|cajero|numero de tarjeta)\b/
/** Words for an id that is a secret only with its digits: a DNI, a bank account number. "pagué por cbu 15000" is not one. */
const ID_WORDS = /\b(?:dni|cbu|cvu)\b/

/** 13 or more digits, joined by at most a space, a dot, a dash, a slash or an underscore (a card: 13 to 19; a CBU or CVU: 22). */
const LONG_DIGITS = /(?:\d(?: ?[./_-] ?| )?){13,}/
/** A DNI: 7 or 8 digits, plain or grouped by dots or spaces (`12345678`, `12.345.678`, `1.234.567`, `12 345 678`). */
const DNI = /(?<![\d.,])\d{1,2}[ .]?\d{3}[ .]?\d{3}(?![\d]|[.,]\d)/g
/** What makes such a number an amount: a money sign before it, or a unit after it. */
const MONEY_BEFORE = /(?:\$|us\$|u\$s|usd|ars) ?$/
const MONEY_AFTER = /^ ?(?:pesos|mil|lucas?|palos?|usd|ars|dolares|millones)\b/

const dniShaped = (folded: string) =>
  [...folded.matchAll(DNI)].some((m) => {
    const before = folded.slice(0, m.index)
    const after = folded.slice(m.index + m[0].length)
    return !MONEY_BEFORE.test(before) && !MONEY_AFTER.test(after)
  })

/**
 * A password said with no keyword: a word that mixes upper case, lower case and digits ("Perro123"), in a sentence that
 * says how it is used ("en el galicia uso Perro123", "entro con ..."). Heuristic: a password said without such a cue
 * passes, and "uso la PlayStation5" is refused (the fact is not kept, and nothing else is lost).
 */
const PASSWORD_CUE = /\b(?:uso|usar|usa|entro con|ingreso con|ingreso|login|acceso|pongo|escribo)\b/
const looksPassword = (text: string, folded: string) =>
  PASSWORD_CUE.test(folded) &&
  text
    .normalize('NFKC')
    .split(/[\s,;:()]+/)
    .some((w) => /^(?=.*\p{Lu})(?=.*\p{Ll})(?=.*\d)\S{6,}$/u.test(w.replace(/^\W+|\W+$/gu, '')))

/**
 * Whether a text looks like something Warren must never keep: a card number, a CBU/CVU, a password or PIN, a DNI.
 * `stored` is text that would go into a fact: it also refuses the bare DNI shape and a few more words. In the person's
 * own message (`stored: false`) only what cannot be a movement counts: an amount such as `12.345.678` or "por cbu 15000" is fine.
 * Decides what is refused and what is wiped from the record of a message (`sensitive`).
 */
export function looksSecret(text: string, stored = true): boolean {
  const folded = fold(text)
  if (CREDENTIAL_WORDS.test(folded) || LONG_DIGITS.test(folded) || looksPassword(text, folded)) {
    return true
  }
  if (stored) {
    return (
      STORED_WORDS.test(folded) ||
      (ID_WORDS.test(folded) && /\d{4}/.test(folded)) ||
      dniShaped(folded)
    )
  }
  // "mi dni es 12345678", "el código del cajero es 1234".
  return (
    (/\bdni\b/.test(folded) && /\d{7}|\d\.\d{3}\.\d{3}/.test(folded)) ||
    (/\bcodigo\b/.test(folded) && /\d{4}/.test(folded))
  )
}

/**
 * Whether a text holds a secret's VALUE: a card or CBU number, a DNI, a password said with a cue, or a credential word beside a number
 * ("la clave 7788", "el pin es 4455"). The word alone is not: "cambiar la contraseña del wifi", "renovar el pin de la tarjeta" and
 * "el código postal" are plain words a reminder may carry. A reminder leaves through Meta as written, so this is what it must not hold.
 */
export function holdsSecretValue(text: string): boolean {
  const folded = fold(text)
  return (
    LONG_DIGITS.test(folded) ||
    looksPassword(text, folded) ||
    dniShaped(folded) ||
    ((CREDENTIAL_WORDS.test(folded) || STORED_WORDS.test(folded) || ID_WORDS.test(folded)) &&
      /\d{4}/.test(folded))
  )
}

/** Whether a person's message holds something Warren must not keep, in the database or in the model's window. */
export const sensitive = (message: string) => looksSecret(message, false)

/** An email address or a phone number: contact data, which Warren does not keep either. */
const EMAIL = /[\w.%+-]+@[\w-]+\.[\w.-]{2,}/u
const PHONE =
  /(?<!\d)(?:\+\d{1,3}[ .-]?)?(?:\(?0?\d{2,4}\)?[ .-]?)(?:15[ .-]?)?\d{3,4}[ .-]?\d{4}(?![\d])/
export const looksContact = (text: string) => {
  const raw = text.normalize('NFKC')
  return EMAIL.test(raw) || PHONE.test(raw)
}
