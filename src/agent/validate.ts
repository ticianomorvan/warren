import { type Changes, MAX_MOVEMENTS, type Movement } from './schema'

/** A value the movement table cannot hold, or a rule the model broke. Never repaired: the model is told. */
export type Issue = { path: string; message: string }

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const isDecimalAmount = (amount: string) => AMOUNT_RE.test(amount) && Number(amount) > 0
export const isIsoDate = (date: string) => DATE_RE.test(date)

/** A real calendar date in ISO form, not after `today` (both are Argentine calendar days). */
function dateProblem(date: string, today: string): string | null {
  if (!DATE_RE.test(date)) return 'date is not yyyy-mm-dd'
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return 'date does not exist'
  }
  if (date > today) return 'date is after today'
  return null
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

/** The movements of a `log_movements` call: 1 to 10, with values the table can hold. */
export function checkLog(movements: Movement[], today: string): Issue[] {
  if (movements.length === 0) return [{ path: 'movements', message: 'no movements' }]
  const issues: Issue[] = []
  movements.forEach((movement, i) => {
    issues.push(...checkValues(movement, today, `movements[${i}]`))
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
export function checkChanges(changes: Changes, today: string, path = 'changes'): Issue[] {
  const issues = checkValues(changes, today, path)
  for (const field of ['description', 'payment'] as const) {
    if (changes[field] != null && changes[field].trim() === '') {
      issues.push({ path: `${path}.${field}`, message: `${field} is empty` })
    }
  }
  return issues
}

export const hasChanges = (changes: Changes) => Object.values(changes).some((v) => v != null)

export const issueText = (issues: Issue[]) =>
  issues.map((i) => `${i.path}: ${i.message}`).join('; ')
