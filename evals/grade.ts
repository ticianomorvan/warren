import type { RecentMovement } from '../src/agent'
import type { Command } from './command'

export type EvalCase = {
  id: string
  split: 'dev' | 'test'
  today: string
  text: string
  recent: RecentMovement[]
  /** The sender's previous message and our reply to it, when the case needs them. */
  previous?: { text: string; reply: string }
  /** An ambiguous message passes by coming back low-confidence, or by being exactly right. */
  ambiguous: boolean
  expected: Command
}

export type SoftCounts = Record<string, { ok: number; total: number }>

export type Grade = {
  /** Command type, movement count and every hard field match exactly. */
  full: boolean
  typeOk: boolean
  /** An amount is wrong while its confidence is high. Must never happen. */
  silentWrongAmount: boolean
  /**
   * A correction or delete aimed at the wrong movement, with no question: the agent acted on a
   * different row than the one expected. Must never happen.
   */
  silentWrongTarget: boolean
  soft: SoftCounts
  /** Why `full` is false, for the dev split's failure list. */
  reasons: string[]
}

const norm = (value: string | null | undefined) =>
  (value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()

const STOPWORDS = new Set(['del', 'los', 'las', 'con', 'por', 'para', 'una', 'que', 'mis'])

/** 4-letter stems of the content words: stopwords and words under 4 letters carry no meaning. */
function stems(text: string): string[] {
  return norm(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word))
    .map((word) => word.slice(0, 4))
}

/**
 * Loose match for free text: equal, one contains the other, or they share the stem of a content
 * word.
 */
export function similarText(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a)
  const y = norm(b)
  if (x === y) return true
  if (x === '' || y === '') return false
  if (x.includes(y) || y.includes(x)) return true
  const sy = new Set(stems(y))
  return stems(x).some((stem) => sy.has(stem))
}

/** An amount as a canonical decimal string, so "2800.50" and "2800.5" compare equal. */
export function canonicalAmount(amount: string | null): string | null {
  if (amount === null || !/^\d+(\.\d+)?$/.test(amount)) return amount
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount
}

const sameAmount = (a: string | null, b: string | null) => canonicalAmount(a) === canonicalAmount(b)

function addSoft(soft: SoftCounts, name: string, ok: boolean) {
  const entry = soft[name] ?? { ok: 0, total: 0 }
  entry.total += 1
  if (ok) entry.ok += 1
  soft[name] = entry
}

export function grade(testCase: EvalCase, actual: Command): Grade {
  const expected = testCase.expected
  const soft: SoftCounts = {}
  const reasons: string[] = []
  let silentWrongAmount = false
  let silentWrongTarget = false
  const typeOk = actual.type === expected.type
  if (!typeOk) {
    reasons.push(`type ${actual.type}, expected ${expected.type}`)
    return { full: false, typeOk, silentWrongAmount, silentWrongTarget, soft, reasons }
  }

  if (expected.type === 'log' && actual.type === 'log') {
    if (actual.movements.length !== expected.movements.length) {
      reasons.push(`${actual.movements.length} movements, expected ${expected.movements.length}`)
      // A merged or invented movement cannot be matched to an expected amount, so any
      // high-confidence one is a silent error (for example two purchases summed into one).
      if (actual.movements.some((m) => m.confidence === 'high')) silentWrongAmount = true
    } else {
      expected.movements.forEach((want, i) => {
        const got = actual.movements[i]
        if (!got) return
        const hardOk =
          got.direction === want.direction &&
          sameAmount(got.amount, want.amount) &&
          got.currency === want.currency &&
          got.date === want.date
        const lowOk = testCase.ambiguous && got.confidence === 'low'
        if (!hardOk && !lowOk) {
          reasons.push(
            `#${i}: got ${got.direction} ${got.amount} ${got.currency} ${got.date} (${got.confidence}), expected ${want.direction} ${want.amount} ${want.currency} ${want.date}`,
          )
        }
        if (!sameAmount(got.amount, want.amount) && got.confidence === 'high')
          silentWrongAmount = true
        addSoft(soft, 'description', similarText(got.description, want.description))
        addSoft(soft, 'category', got.category === want.category)
        addSoft(soft, 'payment', norm(got.payment) === norm(want.payment))
      })
    }
  } else if (expected.type === 'correct' && actual.type === 'correct') {
    for (const field of ['amount', 'currency', 'date', 'direction'] as const) {
      const same =
        field === 'amount'
          ? sameAmount(actual.changes.amount, expected.changes.amount)
          : actual.changes[field] === expected.changes[field]
      if (!same) {
        reasons.push(
          `changes.${field} ${actual.changes[field]}, expected ${expected.changes[field]}`,
        )
      }
    }
    if (
      !sameAmount(actual.changes.amount, expected.changes.amount) &&
      actual.changes.amount !== null &&
      actual.confidence === 'high'
    ) {
      silentWrongAmount = true
    }
    silentWrongTarget = hardTarget(testCase, actual, expected, reasons)
    addSoft(soft, 'category', actual.changes.category === expected.changes.category)
    addSoft(soft, 'payment', norm(actual.changes.payment) === norm(expected.changes.payment))
  } else if (expected.type === 'delete' && actual.type === 'delete') {
    silentWrongTarget = hardTarget(testCase, actual, expected, reasons)
  } else if (expected.type === 'query' && actual.type === 'query') {
    if (actual.period !== expected.period)
      reasons.push(`period ${actual.period}, expected ${expected.period}`)
    if (actual.direction !== expected.direction) {
      reasons.push(`direction ${actual.direction}, expected ${expected.direction}`)
    }
    if (actual.category !== expected.category) {
      reasons.push(`category ${actual.category}, expected ${expected.category}`)
    }
    if (norm(actual.payment) !== norm(expected.payment)) {
      reasons.push(`payment ${actual.payment}, expected ${expected.payment}`)
    }
  }

  return { full: reasons.length === 0, typeOk, silentWrongAmount, silentWrongTarget, soft, reasons }
}

type Targeting = Extract<Command, { type: 'correct' | 'delete' }>

/**
 * Which movement a correction or delete points at is a hard field: a wrong one hits the wrong row.
 * The row (its number in the list) decides, so it is checked first. An ambiguous case also passes by
 * the agent asking instead (the adapter reports an `ask_user` as a low-confidence command). Returns
 * whether the agent would act on the wrong movement silently: a confident, different row.
 */
function hardTarget(
  testCase: EvalCase,
  actual: Targeting,
  expected: Targeting,
  reasons: string[],
): boolean {
  if (testCase.ambiguous && actual.confidence === 'low') return false
  const differs = actual.target_index !== expected.target_index
  if (differs) {
    reasons.push(`target_index ${actual.target_index}, expected ${expected.target_index}`)
  }
  // With the right row the text is not graded; it is the answer itself only when there is no row.
  if (expected.target_index === null && !targetOk(actual.target, expected.target)) {
    reasons.push(`target "${actual.target}", expected "${expected.target}"`)
  }
  return differs && actual.confidence === 'high'
}

function targetOk(got: string, want: string): boolean {
  if (norm(want) === 'last' || norm(got) === 'last') return norm(want) === norm(got)
  return similarText(got, want)
}
