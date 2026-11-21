import type { Command, Movement } from '../src/parse/schema'

export type EvalCase = {
  id: string
  split: 'dev' | 'test'
  today: string
  text: string
  recent: Array<
    Pick<
      Movement,
      'direction' | 'amount' | 'currency' | 'date' | 'description' | 'category' | 'payment'
    >
  >
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

function stems(text: string): string[] {
  return norm(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
    .map((word) => word.slice(0, 4))
}

/** Loose match for free text: one contains the other, or they share a word stem. */
export function similarText(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a)
  const y = norm(b)
  if (x === y) return true
  if (x === '' || y === '') return false
  if (x.includes(y) || y.includes(x)) return true
  const sy = new Set(stems(y))
  return stems(x).some((stem) => sy.has(stem))
}

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
  const typeOk = actual.type === expected.type
  if (!typeOk) {
    reasons.push(`type ${actual.type}, expected ${expected.type}`)
    return { full: false, typeOk, silentWrongAmount, soft, reasons }
  }

  if (expected.type === 'log' && actual.type === 'log') {
    if (actual.movements.length !== expected.movements.length) {
      reasons.push(`${actual.movements.length} movements, expected ${expected.movements.length}`)
    } else {
      expected.movements.forEach((want, i) => {
        const got = actual.movements[i]
        if (!got) return
        const hardOk =
          got.direction === want.direction &&
          got.amount === want.amount &&
          got.currency === want.currency &&
          got.date === want.date
        const lowOk = testCase.ambiguous && got.confidence === 'low'
        if (!hardOk && !lowOk) {
          reasons.push(
            `#${i}: got ${got.direction} ${got.amount} ${got.currency} ${got.date} (${got.confidence}), expected ${want.direction} ${want.amount} ${want.currency} ${want.date}`,
          )
        }
        if (got.amount !== want.amount && got.confidence === 'high') silentWrongAmount = true
        addSoft(soft, 'description', similarText(got.description, want.description))
        addSoft(soft, 'category', got.category === want.category)
        addSoft(soft, 'payment', norm(got.payment) === norm(want.payment))
      })
    }
  } else if (expected.type === 'correct' && actual.type === 'correct') {
    for (const field of ['amount', 'currency', 'date', 'direction'] as const) {
      if (actual.changes[field] !== expected.changes[field]) {
        reasons.push(
          `changes.${field} ${actual.changes[field]}, expected ${expected.changes[field]}`,
        )
      }
    }
    if (
      actual.changes.amount !== expected.changes.amount &&
      actual.changes.amount !== null &&
      actual.confidence === 'high'
    ) {
      silentWrongAmount = true
    }
    addSoft(soft, 'target', targetOk(actual.target, expected.target))
    addSoft(soft, 'category', actual.changes.category === expected.changes.category)
    addSoft(soft, 'payment', norm(actual.changes.payment) === norm(expected.changes.payment))
  } else if (expected.type === 'delete' && actual.type === 'delete') {
    addSoft(soft, 'target', targetOk(actual.target, expected.target))
  } else if (expected.type === 'query' && actual.type === 'query') {
    if (actual.period !== expected.period)
      reasons.push(`period ${actual.period}, expected ${expected.period}`)
    addSoft(soft, 'query.direction', actual.direction === expected.direction)
    addSoft(soft, 'query.category', actual.category === expected.category)
    addSoft(soft, 'query.payment', norm(actual.payment) === norm(expected.payment))
  }

  return { full: reasons.length === 0, typeOk, silentWrongAmount, soft, reasons }
}

function targetOk(got: string, want: string): boolean {
  if (norm(want) === 'last' || norm(got) === 'last') return norm(want) === norm(got)
  return similarText(got, want)
}
