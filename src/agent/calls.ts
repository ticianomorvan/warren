import type { z } from 'zod'
import type { FindFilter } from '../ledger'
import { planSummary } from '../range'
import { hasLongNumber, hasNumberWord } from './say'
import { MAX_FOUND, type ModelAction, TOOL_INPUTS, type ToolInput, type ToolName } from './schema'
import {
  checkChanges,
  checkCount,
  checkLog,
  hasChanges,
  isDecimalAmount,
  isIsoDate,
  issueText,
} from './validate'

/** What a tool call comes to: a read to run, an action for the commit point, or a refusal the model is told. */
export type Checked =
  | { kind: 'read'; filter: FindFilter }
  | { kind: 'action'; action: ModelAction }
  | { kind: 'rejected'; message: string }

const rejected = (message: string): Checked => ({ kind: 'rejected', message })

export interface Guard {
  /** The Argentine day of the message: no date may be after it. */
  today: string
  /** Ids the model has been shown (the list, find results, a pending question). Only these may be acted on. */
  seen: ReadonlySet<number>
  /** Movements already asked to be logged by earlier calls of this turn. */
  logged: number
  /** The id of the pending question's only option, when it has exactly one: a change in this message is about it. */
  sole?: number
  /** The person's message: it tells whether they gave a new value at all. */
  message?: string
}

const MAX_QUESTION_WORDS = 6

/** The most issues a refusal names; a longer list says how many more there are, never cuts one in half. */
const MAX_ISSUES = 12

/** What is wrong with an input, one `path: reason` per issue, so the model can fix all of them in one turn. */
export function issueList(error: z.ZodError): string {
  const lines = error.issues.map(
    (i) => `${i.path.length > 0 ? i.path.join('.') : 'input'}: ${i.message}`,
  )
  const shown = lines.slice(0, MAX_ISSUES).join('; ')
  return lines.length > MAX_ISSUES ? `${shown}; and ${lines.length - MAX_ISSUES} more` : shown
}

/** Why a summary cannot run, in words for the model; null when it can. */
export function checkSummary(q: ToolInput<'summarize'>, today: string): string | null {
  const plan = planSummary(q, today)
  return typeof plan === 'string' ? plan : null
}

/** Whether a message holds an amount at all, in digits or in words ("tres mil"): without one there is no new value to send. */
const hasValue = (message: string | undefined) =>
  message === undefined || /\d/.test(message) || hasNumberWord(message)

/**
 * A question is a short phrase from the model ("Cuál", "Qué querés cambiar"), and code adds the
 * options and the instructions. Anything longer than a phrase, or with a digit or a money sign in it
 * (which could smuggle a figure into a reply the model must not write), is replaced by `fallback`.
 */
export function cleanQuestion(question: string, fallback: string): string {
  const q = question.normalize('NFKC').replace(/[¿?]/g, '').replace(/\s+/g, ' ').trim()
  const phrase =
    q !== '' &&
    q.split(' ').length <= MAX_QUESTION_WORDS &&
    !/[\d$.:;!]/.test(q) &&
    !hasNumberWord(q)
  return phrase ? q : fallback
}

function checkIds(ids: number[], guard: Guard): string | null {
  const bad = ids.filter((id) => !Number.isSafeInteger(id) || id < 1 || !guard.seen.has(id))
  return bad.length === 0
    ? null
    : `id ${bad.join(', ')} was not shown to you. Use only ids from "Últimos movimientos", a find_movements result or the pending question; call find_movements to look for an older movement.`
}

/**
 * The guards that need no database: the input has the tool's shape, every value is one the table can
 * hold (amounts are decimal strings, dates are real days, not in the future), and every id is one
 * the model was shown. Ownership and liveness are checked at the commit point, under a row lock.
 */
export function checkCall(name: string, input: unknown, guard: Guard): Checked {
  if (!(name in TOOL_INPUTS)) return rejected(`unknown tool ${name}`)
  const tool = name as ToolName
  const parsed = (TOOL_INPUTS[tool]() as z.ZodType).safeParse(input)
  if (!parsed.success) return rejected(`invalid input: ${issueList(parsed.error)}`)

  switch (tool) {
    case 'find_movements': {
      const f = parsed.data as ToolInput<'find_movements'>
      const issues = [
        ...(f.amount != null && !isDecimalAmount(f.amount)
          ? ['amount is not a decimal string']
          : []),
        ...[f.from, f.to].flatMap((d) =>
          d != null && !isIsoDate(d) ? ['dates are yyyy-mm-dd'] : [],
        ),
      ]
      if (issues.length > 0) return rejected(issues.join('; '))
      return {
        kind: 'read',
        filter: {
          text: f.text ?? null,
          from: f.from ?? null,
          to: f.to ?? null,
          category: f.category ?? null,
          payment: f.payment ?? null,
          amount: f.amount ?? null,
          limit: Math.min(Math.max(f.limit ?? 10, 1), MAX_FOUND),
        },
      }
    }
    case 'log_movements': {
      const { movements, text } = parsed.data as ToolInput<'log_movements'>
      const issues = [
        ...checkLog(movements, guard.today),
        ...checkCount(guard.logged + movements.length),
      ]
      return issues.length > 0
        ? rejected(issueText(issues))
        : { kind: 'action', action: { tool, input: { movements, text } } }
    }
    case 'correct_movement': {
      const { id, changes, text } = parsed.data as ToolInput<'correct_movement'>
      const issues = checkChanges(changes, guard.today)
      const unseen = checkIds([id], guard)
      if (unseen) return rejected(unseen)
      if (issues.length > 0) return rejected(issueText(issues))
      if (!hasChanges(changes)) {
        return rejected('changes is empty: if you do not know what to change, call ask_user')
      }
      return { kind: 'action', action: { tool, input: { id, changes, text } } }
    }
    case 'delete_movement': {
      const { id, text } = parsed.data as ToolInput<'delete_movement'>
      const unseen = checkIds([id], guard)
      return unseen ? rejected(unseen) : { kind: 'action', action: { tool, input: { id, text } } }
    }
    case 'ask_user': {
      const a = parsed.data as ToolInput<'ask_user'>
      const unseen = checkIds(a.movement_ids, guard)
      if (unseen) return rejected(unseen)
      if (a.movement_ids.length > 10) return rejected('at most 10 movement_ids')
      const given = a.changes && hasChanges(a.changes) ? a.changes : null
      // "Correct" with no change, when the message has no number at all ("cambiemos el valor de uno de los YPFs"),
      // is the question what to change: take it as `none`. With a number in the message the model left the change
      // out (s061), so it is refused and sent again.
      const noValue = a.after_answer === 'correct' && !given && !hasValue(guard.message)
      if (a.after_answer === 'correct' && !given && !noValue) {
        return rejected(
          'after_answer "correct" needs changes: send the new value the person gave in changes (or after_answer "none" if they gave none)',
        )
      }
      if (given) {
        const issues = checkChanges(given, guard.today)
        if (issues.length > 0) return rejected(issueText(issues))
      }
      const ids = [...new Set(a.movement_ids)]
      // The person answers a question about one movement with a change ("a ese ponele 3500"): that is the
      // correction, on the movement they were shown. Asking again would loop.
      const [only] = ids
      if (
        given &&
        a.after_answer === 'correct' &&
        only !== undefined &&
        ids.length === 1 &&
        only === guard.sole
      ) {
        return {
          kind: 'action',
          action: { tool: 'correct_movement', input: { id: only, changes: given, text: null } },
        }
      }
      return {
        kind: 'action',
        action: {
          tool,
          input: {
            question: cleanQuestion(a.question, ids.length > 1 ? 'Cuál' : 'Qué querés cambiar'),
            movement_ids: ids,
            after_answer: ids.length === 0 || noValue ? 'none' : a.after_answer,
            changes: given && a.after_answer === 'correct' && ids.length > 0 ? given : undefined,
          },
        },
      }
    }
    case 'summarize': {
      const q = parsed.data as ToolInput<'summarize'>
      // The description and the payment are copied into the line code renders, as written.
      const bad = [q.description, q.payment].some((w) => w != null && hasLongNumber(w))
      if (bad) return rejected('description and payment may not hold a number of 4 or more digits')
      const why = checkSummary(q, guard.today)
      return why ? rejected(why) : { kind: 'action', action: { tool, input: q } }
    }
    default: // reply, help: any input of the right shape is fine
      return { kind: 'action', action: { tool, input: parsed.data } as ModelAction }
  }
}
