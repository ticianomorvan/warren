/**
 * The number primitives, pure, used by the value guards and the fact and secret rules: which digits and numbers a text may hold,
 * and how a text is folded for comparison.
 */

/** A digit written some other way (full-width, Arabic-Indic…): code reads only 0-9, so nothing else gets through. */
const FOREIGN_DIGIT = /(?![0-9])\p{Nd}/u
export const hasForeignDigit = (text: string) => FOREIGN_DIGIT.test(text.normalize('NFKC'))

export const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/**
 * Four or more digits in a row (`1234`, `12.000`, `3,500`) in a field code copies into a record line as it is, a description or a
 * payment name: a client must not smuggle a figure in there.
 */
export const hasLongNumber = (value: string) =>
  hasForeignDigit(value) ||
  [...value.normalize('NFKC').matchAll(/\d+(?:[.,]\d+)*/g)].some(
    (m) => m[0].replace(/\D/g, '').length >= 4,
  )
