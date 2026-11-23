import { fold, hasForeignDigit, NUMBER_WORD_RE, tokens } from './numbers'

/**
 * Whether the model's own words may be sent as a `reply`, pure: short, not shaped like a code-rendered record, with no number code
 * did not give, no figure made of given pieces and no claim of a change this message did not make. The turn's guards run it
 * (`checkTurn`), so a text that fails goes back to the model with the reason while it can still write it again.
 */

export const MAX_REPLY_TEXT = 280

/**
 * A first-person past claim ("borré", "corregí", "anoté", "listo") is true only if this message did that.
 * `window` is the one other proof: a `reply` that answers about earlier work ("¿borraste el super?" "Sí, lo
 * borré") may lean on what Warren answered before, read from those replies' own wording (`✓ Borré`,
 * `✓ Corregido`, `✓`). That is a wording dependency on render.ts, kept to `reply` and covered by tests; the
 * risk is that an old line proves a claim about a thing it did not do (the same word, another movement).
 */
const NOT = '(?<!\\bno )(?<!\\bno lo )(?<!\\bno te )'
const CLAIMS: {
  said: RegExp
  window: RegExp
  what: string
}[] = [
  {
    said: new RegExp(`${NOT}\\b(?:borre|elimine|saque)\\b`),
    window: /\bborre\b/,
    what: 'a deletion',
  },
  {
    said: new RegExp(`${NOT}\\b(?:corregi|cambie|modifique|actualice)\\b`),
    window: /\bcorregido\b/,
    what: 'a correction',
  },
  {
    said: new RegExp(`${NOT}\\b(?:anote|registre|agregue|guarde)\\b`),
    window: /✓ (?!borre\b|corregido\b)|🧠 me acuerdo/,
    what: 'a new movement or fact',
  },
  {
    // "Anotado como dato: ...", "Tomo nota": a reply that opens by saying it took note. Only a log or a stored fact makes that
    // true. Only at the start of a sentence: "la nafta fue $20.000, anotada hoy" describes what is stored.
    said: /(?:^|[.!?:] ?)(?:anotado|anotada|guardado|guardada|tomo nota|tome nota)\b/,
    window: /✓ (?!borre\b|corregido\b)|🧠 me acuerdo/,
    what: 'a note taken',
  },
  {
    said: new RegExp(`${NOT}\\b(?:me acuerdo|me acorde|ya lo recuerdo|lo recordare)\\b`),
    window: /🧠 me acuerdo/,
    what: 'a fact remembered',
  },
  {
    said: new RegExp(`${NOT}\\b(?:me olvide|olvide)\\b`),
    window: /🧠 me olvide/,
    what: 'a fact forgotten',
  },
  {
    // "Te aviso", "programé": only a reminder that code set makes that true ("¿me vas a avisar?" is a question, not this).
    said: new RegExp(`${NOT}\\b(?:programe|agende|te aviso|te voy a avisar)\\b`),
    window: /⏰ te aviso/,
    what: 'a reminder set',
  },
  {
    // "¿Cuál querés que cancele?" is a question, not a claim: accent-stripped it reads like "cancelé".
    said: new RegExp(`${NOT}(?<!\\bque )\\bcancele\\b`),
    window: /⏰ cancele/,
    what: 'a reminder cancelled',
  },
  {
    said: new RegExp(`${NOT}\\b(?:deshice|anule|reverti|volvi atras)\\b`),
    window: /↩/,
    what: 'an undo',
  },
  {
    said: /\b(?:listo|hecho|ya esta|quedo en|ahora (?:es|esta|figura|queda))\b/,
    window: /✓/,
    what: 'a change',
  },
]

/** One line, single spaces. */
export const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * Whether `phrase` appears in `source` on its own: not as the tail of a longer number ("12 lucas" does not
 * hold "2 lucas") .
 */
const holds = (source: string, phrase: string) => {
  for (let at = source.indexOf(phrase); at >= 0; at = source.indexOf(phrase, at + 1)) {
    if (!/[\d.,]/.test(source[at - 1] ?? '')) return true
  }
  return false
}

/** ISO days are numbers of their own (the dashes are theirs): leave them out before looking for other dashes. */
const withoutDays = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}/g, ' ')

/**
 * Pieces of a figure that are each given but make a new one when put together: a number with a multiplier
 * ("2 lucas"), digits split by a space ("12 500"), a minus or a range ("-3500", "3500-4000"), a percent.
 * Each must appear in a source exactly as it is written in the text.
 */
const MADE_OF_PIECES = [
  /\d+(?:[.,]\d+)?\s*(?:mil|lucas?|lukas?|palos?|millon(?:es)?|k|m)\b/g,
  /(?<!\d)(?<!\d[.,])\d{1,3}(?: \d{3})+(?!\d|[.,]\d)/g,
  /(?<![\p{L}\d])-\s*\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*\s*-\s*\d+(?:[.,]\d+)*/gu,
  /\d+(?:[.,]\d+)*\s*%|%/g,
]

export type ReplyCheck = { ok: true; text: string } | { ok: false; reason: string }

/** What a reply may lean on. */
export interface Evidence {
  /** Where numbers may come from: the person's message, the context and what searches found. */
  numbers: readonly string[]
  /** Where number words may come from: the person's side only (never the model's own descriptions). */
  words: readonly string[]
  /** What Warren answered earlier: the proof of a claim of a change. */
  window: readonly string[]
}

/**
 * Whether `text` may be sent as a `reply`: short, not shaped like a code-rendered record (`✓ ...`), with no number that code did not
 * give, no figure made of given pieces, and no claim of a change this message did not make (a reply is alone, so only an earlier
 * reply can prove one). The reason of a refusal names the first offence, for the audit.
 */
export function checkReply(text: string, e: Evidence): ReplyCheck {
  const one = squash(text.normalize('NFKC'))
  if (hasForeignDigit(text)) return { ok: false, reason: 'digits that are not 0-9' }
  if (one === '') return { ok: false, reason: 'empty' }
  if (one.length > MAX_REPLY_TEXT)
    return { ok: false, reason: `longer than ${MAX_REPLY_TEXT} characters` }
  if (one.includes('✓') || one.includes('↩') || one.includes('🧠')) {
    return { ok: false, reason: 'imitates a code-rendered line (✓, ↩︎, 🧠)' }
  }
  const known = new Set(e.numbers.flatMap((s) => tokens(s).flatMap((t) => t.provides)))
  const unknown = tokens(one).filter((t) => !known.has(t.needs))
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `number not given by code: ${[...new Set(unknown.map((t) => t.written))].join(', ')}`,
    }
  }
  // "2 lucas" is 2000 whatever 2 and "lucas" were given separately: the whole phrase must be given.
  const given = e.numbers.map((src) => fold(withoutDays(squash(src.normalize('NFKC')))))
  const mine = fold(withoutDays(one))
  for (const re of MADE_OF_PIECES) {
    const made = (mine.match(re) ?? []).filter((phrase) => !given.some((src) => holds(src, phrase)))
    if (made.length > 0) {
      return { ok: false, reason: `figure made of given pieces: ${made.join(', ')}` }
    }
  }
  const proof = e.window.map((src) => fold(src))
  for (const claim of CLAIMS) {
    const word = claim.said.exec(mine)?.[0]
    if (word && !proof.some((src) => claim.window.test(src))) {
      return { ok: false, reason: `claims ${claim.what} this message did not make: ${word}` }
    }
  }
  const spelled = new Set(e.words.flatMap((s) => fold(s).match(NUMBER_WORD_RE) ?? []))
  const words = [...new Set(mine.match(NUMBER_WORD_RE) ?? [])].filter((w) => !spelled.has(w))
  if (words.length > 0) {
    return { ok: false, reason: `number written in words not given by code: ${words.join(', ')}` }
  }
  return { ok: true, text: one }
}
