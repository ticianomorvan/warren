import type { z } from 'zod'
import type { FindFilter } from '../ledger'
import { hasNumberWord } from './say'
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
}

const MAX_QUESTION_WORDS = 6

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
  if (!parsed.success) return rejected(`invalid input: ${parsed.error.message.slice(0, 300)}`)

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
      if (a.after_answer === 'correct') {
        if (!a.changes || !hasChanges(a.changes))
          return rejected('after_answer "correct" needs changes')
        const issues = checkChanges(a.changes, guard.today)
        if (issues.length > 0) return rejected(issueText(issues))
      }
      const ids = [...new Set(a.movement_ids)]
      return {
        kind: 'action',
        action: {
          tool,
          input: {
            question: cleanQuestion(a.question, ids.length > 1 ? 'Cuál' : 'Qué querés cambiar'),
            movement_ids: ids,
            after_answer: ids.length > 0 ? a.after_answer : 'none',
            changes: a.after_answer === 'correct' && ids.length > 0 ? a.changes : undefined,
            text: a.text,
          },
        },
      }
    }
    default: // summarize, reply, help: any input of the right shape is fine
      return { kind: 'action', action: { tool, input: parsed.data } as ModelAction }
  }
}
