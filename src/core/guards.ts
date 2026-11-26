import type { z } from 'zod'
import { checkFactValues, normalizeKey } from '../domain/facts'
import { planRange } from '../domain/range'
import { type Call, COMMANDS, type Input, isTool, type Tool } from './commands'
import { hasLongNumber } from './numbers'
import { looksContact, looksSecret } from './secrets'
import {
  checkChanges,
  checkCount,
  checkLog,
  hasChanges,
  isDecimalAmount,
  isoDateProblem,
  issueText,
} from './values'

/**
 * The value guards on what a client sent, none of which touches the database: the shape of its tool, amounts that are decimal
 * strings, real days not in the future, words with no long number, a fact that is no secret and fits. A refusal the client can fix
 * is `rejected` with its reason; one Warren will not take at all is `declined` with a typed code (a secret, contact data). Whether an
 * id is the account's and still live is decided at the commit point, under the account lock (`applyCall`).
 */

/** What code refuses on its own: a typed code, not a sentence. */
export const DECLINES = ['secret', 'contact'] as const
export type Declined = (typeof DECLINES)[number]

/** What a tool call comes to. */
export type Checked =
  /** Run it: the call, with its values as code keeps them (a key normalized). */
  | { kind: 'ok'; call: Call }
  /** What the client is told, to send it again. */
  | { kind: 'rejected'; message: string }
  /** Refused by code: the client cannot fix it by sending it again. */
  | { kind: 'declined'; declined: Declined }

const rejected = (message: string): Checked => ({ kind: 'rejected', message })
const ok = <T extends Tool>(tool: T, input: Input<T>): Checked => ({
  kind: 'ok',
  call: { tool, input } as Call,
})
const declined = (declined: Declined): Checked => ({ kind: 'declined', declined })

export interface Env {
  /** The Argentine day of the call: no date may be after it. */
  today: string
}

/** The most issues a refusal names; a longer list says how many more there are, never cuts one in half. */
const MAX_ISSUES = 12

/** What is wrong with an input, one `path: reason` per issue, so the client can fix all of them in one call. */
export function issueList(error: z.ZodError): string {
  const lines = error.issues.map(
    (i) => `${i.path.length > 0 ? i.path.join('.') : 'input'}: ${i.message}`,
  )
  const shown = lines.slice(0, MAX_ISSUES).join('; ')
  return lines.length > MAX_ISSUES ? `${shown}; and ${lines.length - MAX_ISSUES} more` : shown
}

/**
 * The words a client wants stored in a movement (description, payment): a secret or contact data is declined, as in a fact, and the
 * client is not asked to fix it. Returns the first code found.
 */
function declinedWords(
  values: { description?: string | null; payment?: string | null }[],
): Checked | null {
  for (const v of values) {
    const text = [v.description, v.payment].filter((w): w is string => w != null).join(' ')
    if (looksSecret(text)) return declined('secret')
    if (looksContact(text)) return declined('contact')
  }
  return null
}

/** The value rule of each tool. A tool without a rule of its own takes any input of the right shape. */
const VALUES = {
  find_movements: (f) => {
    const issues = [
      ...(f.amount != null && !isDecimalAmount(f.amount) ? ['amount is not a decimal string'] : []),
      ...(['from', 'to'] as const).flatMap((field) => {
        const day = f[field]
        const problem = day == null ? null : isoDateProblem(day)
        return problem ? [`${field} "${day}": ${problem}`] : []
      }),
    ]
    if (issues.length > 0) return rejected(issues.join('; '))
    // The size of a page is the caller's.
    return ok('find_movements', f)
  },
  log_movements: (input, env) => {
    const words = declinedWords(input.movements)
    if (words) return words
    const issues = [...checkLog(input.movements, env.today), ...checkCount(input.movements.length)]
    return issues.length > 0 ? rejected(issueText(issues)) : ok('log_movements', input)
  },
  correct_movement: (input, env) => {
    const words = declinedWords([input.changes])
    if (words) return words
    const issues = checkChanges(input.changes, env.today)
    if (issues.length > 0) return rejected(issueText(issues))
    if (!hasChanges(input.changes)) {
      return rejected('changes is empty: send at least one field to change')
    }
    return ok('correct_movement', input)
  },
  delete_movement: (input) => ok('delete_movement', input),
  summarize: (q, env) => {
    // The description and the payment are copied into the line code renders, as written.
    if ([q.description, q.payment].some((w) => w != null && hasLongNumber(w))) {
      return rejected('description and payment may not hold a number of 4 or more digits')
    }
    const plan = planRange(q, env.today)
    return typeof plan === 'string' ? rejected(plan) : ok('summarize', q)
  },
  undo_last: (input) => ok('undo_last', input),
  remember_fact: (f) => {
    const checked = checkFactValues(f)
    if ('refused' in checked) return declined(checked.refused)
    return checked.ok ? ok('remember_fact', checked.fact) : rejected(checked.message)
  },
  forget_fact: ({ target }) => {
    if ('id' in target) {
      return Number.isSafeInteger(target.id) && target.id > 0
        ? ok('forget_fact', { target })
        : rejected('target.id must be the id of a fact you got from warren_list_facts')
    }
    const key = normalizeKey(target.key)
    return key === ''
      ? rejected('send the id of a fact you were shown, or its key (the words)')
      : ok('forget_fact', { target: { key } })
  },
  list_facts: (input) => ok('list_facts', input),
} satisfies { [T in Tool]: (input: Input<T>, env: Env) => Checked }

/** The value guards of a call: the input has the tool's shape and every value is one the tables can hold. */
export function checkValues(tool: string, input: unknown, env: Env): Checked {
  if (!isTool(tool)) return rejected(`unknown tool ${tool}`)
  const parsed = COMMANDS[tool].input.safeParse(input)
  if (!parsed.success) return rejected(`invalid input: ${issueList(parsed.error)}`)
  const rule = VALUES[tool] as (input: unknown, env: Env) => Checked
  return rule(parsed.data, env)
}
