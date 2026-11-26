/**
 * The number primitives, pure: how a number in a text is read, compared by what it means and not by how it is written
 * (`12.000`, `12000` and `$12.000,00` are the same number; `10:12` is a time; `3/11`, `03/11/26` and `2026-11-03` are the same
 * day), and which numbers a text may hold. Used by the numbers check of the model's words, by the value guards and by the
 * fact and reminder rules.
 */

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
export const NUMBER_WORD_RE = new RegExp(
  `\\b(?:${NUMBER_WORDS.join('|')}|veinti[a-z]+|dieci[a-z]+|[a-z]*cient[oa]s|doble|triple|mitad)\\b`,
  'g',
)

/** A digit written some other way (full-width, Arabic-Indic…): code reads only 0-9, so nothing else gets through. */
const FOREIGN_DIGIT = /(?![0-9])\p{Nd}/u
export const hasForeignDigit = (text: string) => FOREIGN_DIGIT.test(text.normalize('NFKC'))

export const fold = (text: string) =>
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

export interface Token {
  /** What a source containing this token lets a text say. */
  provides: string[]
  /** What a text containing this token must find in the sources. */
  needs: string
  /** The token as written, for the reason. */
  written: string
}

export function tokens(text: string): Token[] {
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

/**
 * Four or more digits in a row (`1234`, `12.000`, `3,500`) in a field code copies into a reply as it
 * is, a description or a payment name: the model must not smuggle a figure in there.
 */
export const hasLongNumber = (value: string) =>
  hasForeignDigit(value) ||
  [...value.normalize('NFKC').matchAll(/\d+(?:[.,]\d+)*/g)].some(
    (m) => m[0].replace(/\D/g, '').length >= 4,
  )

/**
 * The numbers in `text` that `message` does not hold: a figure in digits (compared by what it means, `12.000` =
 * `12000`) or a number word the person did not write. Empty means every number is theirs. What a stored fact may
 * contain: code never lets the model put a number of its own into the person's memory.
 */
export function unwritten(text: string, message: string): string[] {
  const known = new Set(tokens(message.normalize('NFKC')).flatMap((t) => t.provides))
  const spelled = new Set(fold(message).match(NUMBER_WORD_RE) ?? [])
  return [
    ...tokens(text.normalize('NFKC'))
      .filter((t) => !known.has(t.needs))
      .map((t) => t.written),
    ...(fold(text).match(NUMBER_WORD_RE) ?? []).filter((w) => !spelled.has(w)),
  ]
}

/** Any number spelled in words, or a digit not 0-9: a short phrase that is not a figure never has one. */
export const hasNumberWord = (value: string) =>
  hasForeignDigit(value) || (fold(value).match(NUMBER_WORD_RE) ?? []).length > 0
