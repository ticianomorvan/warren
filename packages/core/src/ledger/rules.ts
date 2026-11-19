import { parseCbu, parseCuit } from '../mail/parse/fields'

/**
 * Rules say which movements count toward the allowance. They match on the counterparty and are
 * applied when the allowance is read, never written into a movement.
 */
export const RULE_SCHEMES = ['counterparty-account', 'counterparty-tax-id', 'merchant'] as const
export type RuleScheme = (typeof RULE_SCHEMES)[number]

/** `allowance` counts (the default), `fixed` is a fixed cost reported apart, `excluded` is neither. */
export const RULE_CLASSES = ['allowance', 'fixed', 'excluded'] as const
export type RuleClass = (typeof RULE_CLASSES)[number]

export const MERCHANT_MAX = 120

export type RuleInput = { scheme: RuleScheme; value: string; class: RuleClass }

export type RuleIssue = 'scheme' | 'class' | 'value'
export type RuleResult = { ok: true; rule: RuleInput } | { ok: false; issue: RuleIssue }

/*
 * Case and accent folding, shared by the write side (here) and the SQL that reads (the database
 * module builds its `translate` from these same strings), so they cannot drift. One character
 * map does both jobs, so it does not depend on the database's locale (`lower()` folds only ASCII
 * in a C locale): accented Latin letters become their base letter, and A to Z become a to z.
 * Every other character stays as it is, and the comparison is exact on the result.
 */
const ACCENTED = 'ÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇáàâäãéèêëíìîïóòôöõúùûüñç'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const FOLD_FROM = ACCENTED + UPPER
export const FOLD_TO = [...FOLD_FROM]
  .map((c) => (c.normalize('NFD')[0] ?? c).toLowerCase())
  .join('')
/** Decomposed accents (a letter then a combining mark): the mark is dropped. */
export const COMBINING_MARKS = '[\u0300-\u036f]'
/** The whitespace the fold collapses to one space, as a regex JavaScript and Postgres read alike. */
export const FOLD_SPACE = '[ \t\r\n]+'

const FOLD_MAP = new Map([...FOLD_FROM].map((c, i) => [c, FOLD_TO[i] ?? c]))

/** "Cafetería  Ñandú" -> "cafeteria nandu". */
export function foldMerchant(text: string): string {
  return [...text.replace(new RegExp(COMBINING_MARKS, 'g'), '')]
    .map((c) => FOLD_MAP.get(c) ?? c)
    .join('')
    .replace(new RegExp(FOLD_SPACE, 'g'), ' ')
    .replace(/^ | $/g, '')
}

/** Validates a rule and returns it clean: the value in the form the movement columns hold. Never throws. */
export function parseRule(input: unknown): RuleResult {
  const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const scheme = RULE_SCHEMES.find((s) => s === r.scheme)
  if (!scheme) return { ok: false, issue: 'scheme' }
  const cls = RULE_CLASSES.find((c) => c === r.class)
  if (!cls) return { ok: false, issue: 'class' }
  if (typeof r.value !== 'string') return { ok: false, issue: 'value' }
  try {
    const value =
      scheme === 'counterparty-account'
        ? parseCbu(r.value)
        : scheme === 'counterparty-tax-id'
          ? parseCuit(r.value)
          : foldMerchant(r.value)
    if (value === '' || [...value].length > MERCHANT_MAX) return { ok: false, issue: 'value' }
    return { ok: true, rule: { scheme, value, class: cls } }
  } catch {
    return { ok: false, issue: 'value' }
  }
}
