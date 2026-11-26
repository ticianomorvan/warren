import { hasLongNumber } from './numbers'

/** The most movements one message may log. */
export const MAX_MOVEMENTS = 10

/** The text fields of a stored movement as one comparison and one sentence know them. */
type Words = { description?: string | null; payment?: string | null }
/** What a logged movement holds that these rules check. */
export type MovementValues = {
  amount: string
  date: string
  description: string
  payment?: string | null
}
/** The fields a correction may change. */
export type ChangeValues = { [field: string]: string | undefined }

/** Lowercase without accents: how code compares what a person wrote with what is stored. */
export const normalizeText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()

/** A canonical decimal string, so "3500", "3500.00" and "03500" compare equal. */
export const canonicalAmount = (amount: string) =>
  (amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount).replace(
    /^0+(?=\d)/,
    '',
  )

/** A value the movement table cannot hold, or a rule the agent broke. Never repaired: the agent is told. */
export type Issue = { path: string; message: string }

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const isDecimalAmount = (amount: string) => AMOUNT_RE.test(amount) && Number(amount) > 0
/** A real calendar day written yyyy-mm-dd, from the year 2000 ("2026-13-01" and "2026-02-30" are not days: the database would refuse them). */
export function isIsoDate(date: string): boolean {
  // From the year 2000, like `range.ts`: "0000-01-01" is a day the calendar has, but no one's movement.
  if (!DATE_RE.test(date) || date < '2000-01-01') return false
  const parsed = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

/** Why a text is not a real day written yyyy-mm-dd, or null when it is one. */
export function isoDateProblem(date: string): string | null {
  if (!DATE_RE.test(date)) return 'date is not yyyy-mm-dd'
  return isIsoDate(date) ? null : 'date does not exist'
}

/** A real calendar date in ISO form, not after `today` (both are Argentine calendar days). */
function dateProblem(date: string, today: string): string | null {
  const problem = isoDateProblem(date)
  if (problem) return problem
  return date > today ? 'date is after today' : null
}

function checkValues(
  values: { amount?: string | null; date?: string | null },
  today: string,
  path: string,
): Issue[] {
  const issues: Issue[] = []
  if (values.amount != null && !isDecimalAmount(values.amount)) {
    issues.push({
      path: `${path}.amount`,
      message: `amount "${values.amount}" is not a positive decimal string like "3500" or "1500.50"`,
    })
  }
  if (values.date != null) {
    const problem = dateProblem(values.date, today)
    if (problem) issues.push({ path: `${path}.date`, message: problem })
  }
  return issues
}

/**
 * Code copies a description and a payment name into the reply as the agent wrote them, so a run of
 * four or more digits there ("café 12000", "visa 4509") would put a figure in the record that no
 * rule vouches for. Refused, never repaired: the agent is told and sends it again.
 */
function checkWords(values: Words, path: string): Issue[] {
  return (['description', 'payment'] as const).flatMap((field) => {
    const value = values[field]
    return value != null && hasLongNumber(value)
      ? [
          {
            path: `${path}.${field}`,
            message: `${field} has a number of 4 or more digits: leave numbers out of descriptions and payment names (the amount goes in "amount")`,
          },
        ]
      : []
  })
}

/** The movements of a `log_movements` call: 1 to 10, with values the table can hold. */
export function checkLog(movements: MovementValues[], today: string): Issue[] {
  if (movements.length === 0) return [{ path: 'movements', message: 'no movements' }]
  const issues: Issue[] = []
  movements.forEach((movement, i) => {
    issues.push(...checkValues(movement, today, `movements[${i}]`))
    issues.push(...checkWords(movement, `movements[${i}]`))
    if (movement.description.trim() === '') {
      issues.push({ path: `movements[${i}].description`, message: 'description is empty' })
    }
  })
  return issues
}

/** The most movements one message may log, over every `log_movements` call of the turn. */
export function checkCount(count: number): Issue[] {
  return count > MAX_MOVEMENTS
    ? [
        {
          path: 'movements',
          message: `at most ${MAX_MOVEMENTS} movements per message, got ${count}`,
        },
      ]
    : []
}

/** Changed values the movement table cannot hold. Same rules as a logged movement. */
export function checkChanges(changes: ChangeValues, today: string, path = 'changes'): Issue[] {
  const issues = [...checkValues(changes, today, path), ...checkWords(changes, path)]
  for (const field of ['description', 'payment'] as const) {
    if (changes[field] != null && changes[field].trim() === '') {
      issues.push({ path: `${path}.${field}`, message: `${field} is empty` })
    }
  }
  return issues
}

export const hasChanges = (changes: ChangeValues) => Object.values(changes).some((v) => v != null)

export const issueText = (issues: Issue[]) =>
  issues.map((i) => `${i.path}: ${i.message}`).join('; ')
