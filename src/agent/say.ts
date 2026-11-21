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

/** A number with a multiplier ("2 lucas", "20k", "5 mil"): two allowed pieces must not make a new amount. */
const MULTIPLIED = /\d+(?:[.,]\d+)?\s*(?:mil|lucas?|lukas?|palos?|millon(?:es)?|k|m)\b/g

/** What a first-person past claim ("borré", "corregí", "anoté") needs to find in the record to be true. */
const CLAIMS: { said: RegExp; needs: RegExp; what: string }[] = [
  {
    said: /(?<!\bno )(?<!\bno lo )(?<!\bno te )\b(?:borre|elimine|saque)\b/,
    needs: /\bborre\b/,
    what: 'a deletion',
  },
  {
    said: /(?<!\bno )(?<!\bno lo )(?<!\bno te )\b(?:corregi|cambie|modifique|actualice)\b/,
    needs: /\bcorregido\b/,
    what: 'a correction',
  },
  {
    said: /(?<!\bno )(?<!\bno lo )(?<!\bno te )\b(?:anote|registre|agregue|guarde)\b/,
    needs: /✓/,
    what: 'a new movement',
  },
  {
    said: /\b(?:listo|hecho|ya esta|quedo en|ahora (?:es|esta|figura|queda))\b/,
    needs: /✓|\bcorregido\b|\bborre\b/,
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
  let whole: string
  let fraction = ''
  const comma = token.lastIndexOf(',')
  if (comma >= 0) {
    whole = token.slice(0, comma).replaceAll('.', '').replaceAll(',', '')
    fraction = token.slice(comma + 1)
  } else {
    const groups = token.split('.')
    const thousands = groups.length > 1 && groups.slice(1).every((g) => g.length === 3)
    if (groups.length === 1 || thousands) whole = groups.join('')
    else if (groups.length === 2) [whole = '', fraction = ''] = groups
    else whole = groups.join('') // "1.2.3": not a number we read; keep it distinct and exact
  }
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

export type SayCheck = { ok: true; text: string } | { ok: false; reason: string }

/** One line, single spaces. */
export const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * Whether `text` may be sent: short, not shaped like a code-rendered record (`✓ …`), and with no number
 * that is not in `sources`. The reason of a refusal names the first offence, for the audit.
 */
export function checkSay(
  text: string,
  sources: readonly string[],
  wordSources: readonly string[] = sources,
): SayCheck {
  const one = squash(text.normalize('NFKC'))
  if (hasForeignDigit(text)) return { ok: false, reason: 'digits that are not 0-9' }
  if (one === '') return { ok: false, reason: 'empty' }
  if (one.length > MAX_SAY_LENGTH)
    return { ok: false, reason: `longer than ${MAX_SAY_LENGTH} characters` }
  if (one.includes('✓')) return { ok: false, reason: 'imitates a code-rendered line (✓)' }

  const known = new Set(sources.flatMap((s) => tokens(s).flatMap((t) => t.provides)))
  const unknown = tokens(one).filter((t) => !known.has(t.needs))
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `number not given by code: ${[...new Set(unknown.map((t) => t.written))].join(', ')}`,
    }
  }

  // "2 lucas" is 2000 whatever 2 and "lucas" were given separately: the whole phrase must be given.
  const given = sources.map((src) => fold(squash(src.normalize('NFKC'))))
  const made = (fold(one).match(MULTIPLIED) ?? []).filter(
    (phrase) => !given.some((src) => src.includes(phrase)),
  )
  if (made.length > 0)
    return { ok: false, reason: `amount made of given pieces: ${made.join(', ')}` }

  // A text may say it did something only when the record says so: it adds to the record, never replaces it.
  const foldedOne = fold(one)
  for (const claim of CLAIMS) {
    const word = claim.said.exec(foldedOne)?.[0]
    if (word && !given.some((src) => claim.needs.test(src))) {
      return { ok: false, reason: `claims ${claim.what} the record does not show: ${word}` }
    }
  }

  const spelled = new Set(wordSources.flatMap((s) => fold(s).match(NUMBER_WORD_RE) ?? []))
  const words = [...new Set(fold(one).match(NUMBER_WORD_RE) ?? [])].filter((w) => !spelled.has(w))
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

export interface Verdict {
  text: 'sent' | 'dropped'
  textReason?: string
}

/**
 * The reply of a message: the lines code rendered first, then the model's texts that pass `checkSay`,
 * in order and without repeats. `outcomes[k]` is what happened to action k; a text beside an action that
 * did not apply (`gone`, `unchanged`) was written for a change that did not happen and is dropped. When
 * nothing is left to send, `fallback` is, so the person is never left without an answer. Numbers may come
 * from `facts` and from the lines; number words only from `facts`, so a description the model wrote
 * ("doce mil") cannot make its own words allowed.
 */
export function composeReply(i: {
  lines: string[]
  says: Say[]
  outcomes: string[]
  facts: readonly string[]
  fallback: string
}): { reply: string; verdicts: Map<number, Verdict> } {
  const sources = [...i.facts, ...i.lines]
  const verdicts = new Map<number, Verdict>()
  const notes: string[] = []
  for (const say of i.says) {
    const outcome = i.outcomes[say.action]
    if (outcome !== 'applied') {
      verdicts.set(say.action, { text: 'dropped', textReason: `its action was ${outcome}` })
      continue
    }
    const check = checkSay(say.text, sources, i.facts)
    if (check.ok) {
      verdicts.set(say.action, { text: 'sent' })
      if (!notes.includes(check.text)) notes.push(check.text)
    } else {
      verdicts.set(say.action, { text: 'dropped', textReason: check.reason })
    }
  }
  const body = i.lines.length === 0 && notes.length === 0 ? [i.fallback] : i.lines
  return { reply: [...body, ...notes].join('\n'), verdicts }
}
