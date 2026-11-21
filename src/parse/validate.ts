import type { Changes, Command, Movement } from './schema'

export type Issue = { path: string; message: string }

/** The model's command cannot be used at all (as opposed to a doubtful one, which is low confidence). */
export class InvalidCommandError extends Error {}

function checkTarget(target: string): Issue[] {
  return target.trim() === '' ? [{ path: 'target', message: 'target is empty' }] : []
}

export const MAX_MOVEMENTS = 10

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidAmount(amount: string): boolean {
  return AMOUNT_RE.test(amount) && Number(amount) > 0
}

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
  if (values.amount != null && !isValidAmount(values.amount)) {
    issues.push({
      path: `${path}.amount`,
      message: `amount "${values.amount}" is not a positive decimal`,
    })
  }
  if (values.date != null) {
    const problem = dateProblem(values.date, today)
    if (problem) issues.push({ path: `${path}.date`, message: problem })
  }
  return issues
}

function checkMovement(movement: Movement, today: string, path: string): Issue[] {
  const issues = checkValues(movement, today, path)
  if (movement.description.trim() === '') {
    issues.push({ path: `${path}.description`, message: 'description is empty' })
  }
  return issues
}

/** Changed values the movement table cannot hold. Same rules as a `log` movement. */
function checkChangedValues(changes: Changes, today: string, path: string): Issue[] {
  const issues = checkValues(changes, today, path)
  for (const field of ['description', 'payment'] as const) {
    if (changes[field] !== null && changes[field].trim() === '') {
      issues.push({ path: `${path}.${field}`, message: `${field} is empty` })
    }
  }
  return issues
}

/**
 * Checks what the schema cannot: amount form, calendar dates, the future. A failure is never
 * repaired. It lowers the confidence of the movement (or correction) and is listed as an issue,
 * so the reply can ask the person instead of storing a guess as sure. `fatal` is the subset that
 * makes a `log` or a `correct` unstorable (bad amount, date or description); a message with any fails.
 */
export function validateCommand(
  command: Command,
  today: string,
): { command: Command; issues: Issue[]; fatal: Issue[] } {
  if (command.type === 'log') {
    // A log with nothing in it is not a command at all.
    if (command.movements.length === 0) throw new InvalidCommandError('log has no movements')
    const issues: Issue[] = []
    // Values the movement table cannot hold: an amount, date or description that is not usable.
    const fatal: Issue[] = []
    // Too many movements is a sign the model invented or split things: none of them is trusted.
    const tooMany = command.movements.length > MAX_MOVEMENTS
    if (tooMany) {
      issues.push({ path: 'movements', message: `expected 1 to ${MAX_MOVEMENTS} movements` })
    }
    const movements = command.movements.map((movement, i) => {
      const found = checkMovement(movement, today, `movements[${i}]`)
      issues.push(...found)
      fatal.push(...found)
      return found.length > 0 || tooMany ? { ...movement, confidence: 'low' as const } : movement
    })
    return { command: { ...command, movements }, issues, fatal }
  }
  if (command.type === 'correct') {
    // A changed value that cannot be stored is unusable, like the same value in a `log`. Nothing
    // changing at all is not an error here: the reply says so.
    const fatal = checkChangedValues(command.changes, today, 'changes')
    const issues = [...checkTarget(command.target), ...fatal]
    return {
      command: issues.length > 0 ? { ...command, confidence: 'low' } : command,
      issues,
      fatal,
    }
  }
  if (command.type === 'delete') {
    const issues = checkTarget(command.target)
    return {
      command: issues.length > 0 ? { ...command, confidence: 'low' } : command,
      issues,
      fatal: [],
    }
  }
  return { command, issues: [], fatal: [] }
}
