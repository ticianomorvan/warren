/**
 * The numbers check: the model may write a short text, but every number in it must be one code gave
 * it. A pure function over strings, so it can be tested without a model, a database or a clock.
 *
 * A number is a token of digits, with Argentine or plain separators. It is compared by what it
 * means, not by how it is written: `12.000`, `12000` and `$12.000,00` are the same number; `10:12`
 * is a time; `3/11`, `03/11/26` and `2026-11-03` are the same day. A number in the model's text must
 * be one of those in the sources: the person's message, the context sent with it (the movement list,
 * the conversation window, the pending question), the results of this message's `find_movements`
 * calls, and the lines code rendered for this message. Anything else is dropped and code sends
 * its own lines instead.
 */

import { fitReply } from '../render'

export const MAX_SAY_LENGTH = 280

/**
 * Number words that would smuggle a figure in as text ("doce mil", "tres cafés"). One is allowed only
 * when a source spells the same word: the person wrote "5 mil" or "el dos".
 */
const NUMBER_WORDS = [
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciseis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
  'cien',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
  'mil',
  'millon',
  'millones',
  'luca',
  'lucas',
  'palo',
  'palos',
  'gamba',
  'gambas',
]
/** The words above, plus the families that are open: veintiuno…, dieciséis…, doscientas…, doble, mitad. */
const NUMBER_WORD_RE = new RegExp(
  `\\b(?:${NUMBER_WORDS.join('|')}|veinti[a-z]+|dieci[a-z]+|[a-z]*cient[oa]s|doble|triple|mitad)\\b`,
  'g',
)

/** A digit written some other way (full-width, Arabic-Indic…): code reads only 0-9, so nothing else gets through. */
const FOREIGN_DIGIT = /(?![0-9])\p{Nd}/u
export const hasForeignDigit = (text: string) => FOREIGN_DIGIT.test(text.normalize('NFKC'))

/** The kinds of change a message actually made, from its outcomes (never read back from rendered text). */
export interface Applied {
  deleted: boolean
  corrected: boolean
  logged: boolean
}

const KIND_OF_TOOL = {
  delete_movement: 'deleted',
  correct_movement: 'corrected',
  log_movements: 'logged',
} as const

/**
 * A first-person past claim ("borré", "corregí", "anoté", "listo") is true only if this message did that.
 * `window` is the one other proof: a `reply` that answers about earlier work ("¿borraste el super?" "Sí, lo
 * borré") may lean on what Warren answered before, read from those replies' own wording (`✓ Borré`,
 * `✓ Corregido`, `✓`). That is a wording dependency on render.ts, kept to `reply` and covered by tests; the
 * risk is that an old line proves a claim about a thing it did not do (the same word, another movement).
 */
const NOT = '(?<!\\bno )(?<!\\bno lo )(?<!\\bno te )'
const CLAIMS: { said: RegExp; kind: keyof Applied | 'any'; window: RegExp; what: string }[] = [
  {
    said: new RegExp(`${NOT}\\b(?:borre|elimine|saque)\\b`),
    kind: 'deleted',
    window: /\bborre\b/,
    what: 'a deletion',
  },
  {
    said: new RegExp(`${NOT}\\b(?:corregi|cambie|modifique|actualice)\\b`),
    kind: 'corrected',
    window: /\bcorregido\b/,
    what: 'a correction',
  },
  {
    said: new RegExp(`${NOT}\\b(?:anote|registre|agregue|guarde)\\b`),
    kind: 'logged',
    window: /✓ (?!borre\b|corregido\b)/,
    what: 'a new movement',
  },
  {
    said: /\b(?:listo|hecho|ya esta|quedo en|ahora (?:es|esta|figura|queda))\b/,
    kind: 'any',
    window: /✓/,
    what: 'a change',
  },
]

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/**
 * One alternative per kind of number, most specific first: an ISO day, a clock time, a day and month
 * (with an optional year), and any other digits with `.` or `,` inside. A `.` or `,` must sit between
 * digits, so a full stop after a number ends it ("$3.500.") instead of joining it to the next one.
 */
const TOKEN =
  /(?<iso>\d{4}-\d{2}-\d{2})|(?<time>\d{1,2}:\d{2})(?!\d)|(?<date>\d{1,2}\/\d{1,2}(?:\/\d{4}|\/\d{2})?)(?![\d/])|(?<num>\d+(?:[.,]\d+)*)/g

const pad = (n: string) => n.padStart(2, '0')

/** The value of digits written the Argentine way: `.` groups thousands, `,` is the decimal mark. */
export function canonical(token: string): string {
  const [w = '', f = '', ...extra] = token.split(',')
  const groups = w.split('.')
  const thousands = groups.length > 1 && groups.slice(1).every((g) => g.length === 3)
  const hasComma = token.includes(',')
  // Only forms we read: at most one comma, and dots that group thousands (or, with no comma, make one
  // decimal point). Anything else ("1,000,000", "1.2.3") is kept distinct and exact: it matches only itself.
  const readable =
    extra.length === 0 && (groups.length === 1 || thousands || (!hasComma && groups.length === 2))
  if (!readable) return `~${token}`
  let whole: string
  let fraction = f
  if (hasComma || thousands || groups.length === 1) whole = groups.join('')
  else [whole = '', fraction = ''] = groups
  whole = whole.replace(/^0+(?=\d)/, '')
  fraction = fraction.replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

interface Token {
  /** What a source containing this token lets a text say. */
  provides: string[]
  /** What a text containing this token must find in the sources. */
  needs: string
  /** The token as written, for the reason. */
  written: string
}

function tokens(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(TOKEN)) {
    const { iso, time, date, num } = m.groups as Record<string, string | undefined>
    const written = m[0]
    if (iso) {
      const [year = '', month = '', day = ''] = iso.split('-')
      const short = `d:${day}/${month}/${year.slice(2)}`
      out.push({ provides: [short, `d:${day}/${month}`], needs: short, written })
    } else if (time) {
      const [h = '', min = ''] = time.split(':')
      const key = `t:${pad(h)}:${min}`
      out.push({ provides: [key], needs: key, written })
    } else if (date) {
      const [d = '', mo = '', y] = date.split('/')
      const day = `d:${pad(d)}/${pad(mo)}`
      const key = y ? `${day}/${y.slice(-2)}` : day
      out.push({ provides: y ? [key, day] : [day], needs: key, written })
    } else if (num) {
      const key = `n:${canonical(num)}`
      out.push({ provides: [key], needs: key, written })
    }
  }
  return out
}

export type SayCheck =
  | { ok: true; text: string }
  | {
      ok: false
      reason: string /** The text only repeats the person: nothing to repair. */
      echo?: true
    }

/** One line, single spaces. */
export const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Letters and digits only, accents and case aside. */
const flat = (text: string) =>
  fold(text.normalize('NFKC'))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * Whether `text` is, in effect, the person's own message said back: the same words, or the message with a
 * few words around it ("cuanto voy este mes" / "¿Cuánto voy este mes?"). Two words or fewer are never an echo.
 */
export function echoes(text: string, message: string): boolean {
  const a = flat(text)
  const b = flat(message)
  if (b.split(' ').length < 3 || a === '') return false
  return (
    a === b ||
    (a.includes(b) && a.length <= b.length + 16) ||
    (b.includes(a) && a.length >= b.length * 0.8)
  )
}

/** Words that say nothing about a movement: articles, prepositions, and the verbs of "I did it" that the line's own label already says. */
const FILLER = new Set(
  (
    'el la los las un una de del en con por para a al y o que se me lo le es fue era su sus tu tus mi este esta ese esa ' +
    'ya ahora queda quedo quedaron listo hecho dale ok perfecto ' +
    'corregi corregido corregida corregidos anote anotado anotados anotada borre borrado borrada borrados ' +
    'registre registrado cambie cambiado actualice actualizado'
  ).split(' '),
)

/**
 * Whether a text adds nothing to the lines code rendered: every word of it is filler or already in
 * those lines ("Corregí el café de las 11:11." beside "✓ Corregido: Café $1.500 (antes $3.500) · 11:11").
 * Such a text is dropped, like an echo of the person's own message: it is not an error.
 */
export function restates(text: string, lines: readonly string[]): boolean {
  const shown = new Set(flat(lines.join(' ')).split(' '))
  const words = flat(text)
    .split(' ')
    .filter((w) => w !== '' && !FILLER.has(w))
  return words.every((w) => shown.has(w))
}

/** What a text may lean on. */
export interface Evidence {
  /** Where numbers may come from: facts and the lines code rendered. */
  numbers: readonly string[]
  /** Where number words may come from: the person's side only (never the model's own descriptions). */
  words: readonly string[]
  /** The person's message: a text that only repeats it adds nothing. */
  message?: string
  /** The changes this message made. A claim of a change needs it here... */
  applied: Applied
  /** ...or, for a `reply` that answers about earlier work, in what Warren answered before. */
  window?: readonly string[]
}

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

/**
 * Whether `text` may be sent: short, not shaped like a code-rendered record (`✓ …`), and with no number
 * that code did not give. The reason of a refusal names the first offence, for the audit.
 */
export function checkSay(text: string, e: Evidence): SayCheck {
  const one = squash(text.normalize('NFKC'))
  if (hasForeignDigit(text)) return { ok: false, reason: 'digits that are not 0-9' }
  if (one === '') return { ok: false, reason: 'empty' }
  if (one.length > MAX_SAY_LENGTH)
    return { ok: false, reason: `longer than ${MAX_SAY_LENGTH} characters` }
  if (one.includes('✓')) return { ok: false, reason: 'imitates a code-rendered line (✓)' }
  if (e.message !== undefined && echoes(one, e.message)) {
    return { ok: false, reason: "echoes the person's message", echo: true }
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

  // A text may say it did something only when this message did it: it adds to the record, never replaces it.
  const proof = (e.window ?? []).map((src) => fold(src))
  for (const claim of CLAIMS) {
    const word = claim.said.exec(mine)?.[0]
    if (!word) continue
    const done =
      claim.kind === 'any' ? Object.values(e.applied).some(Boolean) : e.applied[claim.kind]
    if (!done && !proof.some((src) => claim.window.test(src))) {
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

/**
 * Four or more digits in a row (`1234`, `12.000`, `3,500`) in a field code copies into a reply as it
 * is, a description or a payment name: the model must not smuggle a figure in there.
 */
export const hasLongNumber = (value: string) =>
  hasForeignDigit(value) ||
  [...value.normalize('NFKC').matchAll(/\d+(?:[.,]\d+)*/g)].some(
    (m) => m[0].replace(/\D/g, '').length >= 4,
  )

/** Any number spelled in words, or a digit not 0-9: a short phrase that is not a figure never has one. */
export const hasNumberWord = (value: string) =>
  hasForeignDigit(value) || (fold(value).match(NUMBER_WORD_RE) ?? []).length > 0

/** One piece of what the model said, with the action it was attached to. */
export interface Say {
  action: number
  text: string
}

/** What became of each action of the message: its tool and its outcome (`applied`, `gone`, `unchanged`). */
export interface Step {
  tool: string
  outcome: string
}

export interface Verdict {
  text: 'sent' | 'dropped'
  textReason?: string
}

/**
 * The reply of a message: the lines code rendered first, then the model's texts that pass `checkSay`,
 * in order and without repeats. A text beside an action that did not apply (`gone`, `unchanged`) was
 * written for a change that did not happen and is dropped. When nothing is left to send, `fallback` is, so
 * the person is never left without an answer. Numbers may come from `facts` and from the lines; number
 * words only from `facts`, so a description the model wrote ("doce mil") cannot make its own words
 * allowed. A claim of a change needs this message's own `steps`; only a `reply` may lean on `window`, the
 * earlier replies of the conversation.
 */
export function composeReply(i: {
  lines: string[]
  says: Say[]
  steps: Step[]
  message: string
  facts: readonly string[]
  window: readonly string[]
  fallback: string
  /** What was heard in a voice note: the reply starts with it. */
  heard?: string
}): { reply: string; verdicts: Map<number, Verdict> } {
  const applied: Applied = { deleted: false, corrected: false, logged: false }
  for (const step of i.steps) {
    const kind = KIND_OF_TOOL[step.tool as keyof typeof KIND_OF_TOOL]
    if (kind && step.outcome === 'applied') applied[kind] = true
  }
  const numbers = [...i.facts, ...i.lines]
  const verdicts = new Map<number, Verdict>()
  const notes: string[] = []
  for (const say of i.says) {
    const step = i.steps[say.action]
    if (step?.outcome !== 'applied') {
      verdicts.set(say.action, { text: 'dropped', textReason: `its action was ${step?.outcome}` })
      continue
    }
    const check = checkSay(say.text, {
      numbers,
      words: i.facts,
      message: i.message,
      applied,
      ...(step.tool === 'reply' ? { window: i.window } : {}),
    })
    if (check.ok && step.tool !== 'reply' && restates(check.text, i.lines)) {
      verdicts.set(say.action, { text: 'dropped', textReason: 'only restates the lines' })
    } else if (check.ok) {
      verdicts.set(say.action, { text: 'sent' })
      if (!notes.includes(check.text)) notes.push(check.text)
    } else {
      verdicts.set(say.action, { text: 'dropped', textReason: check.reason })
    }
  }
  const body = i.lines.length === 0 && notes.length === 0 ? [i.fallback] : i.lines
  return { reply: fitReply({ heard: i.heard, lines: body, notes }), verdicts }
}
