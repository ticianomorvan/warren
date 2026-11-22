import type { z } from 'zod'
import type { FindFilter } from '../ledger'
import { planSummary } from '../range'
import { REPLY_FACT_CONTACT, REPLY_FACT_SECRET } from '../render'
import { checkFact, checkFactValues, normalizeKey } from './memory'
import { hasLongNumber, hasNumberWord } from './say'
import {
  MAX_FOUND,
  type ModelAction,
  type Movement,
  type Notice,
  TOOL_INPUTS,
  type ToolInput,
  type ToolName,
} from './schema'
import {
  checkChanges,
  checkCount,
  checkLog,
  hasChanges,
  isDecimalAmount,
  isoDateProblem,
  issueText,
} from './validate'

/** What a tool call comes to: a read to run, an action for the commit point, or a refusal the model is told. */
export type Checked =
  | { kind: 'read'; filter: FindFilter }
  | { kind: 'action'; action: ModelAction | Notice }
  | { kind: 'rejected'; message: string }

const rejected = (message: string): Checked => ({ kind: 'rejected', message })

export interface Guard {
  /** The Argentine day of the message: no date may be after it. */
  today: string
  /** Ids the model has been shown (the list, find results, a pending question). Only these may be acted on. */
  seen: ReadonlySet<number>
  /** Ids of the facts the model has been shown ("Hechos"). A fact id is in another space than a movement id. */
  seenFacts?: ReadonlySet<number>
  /** Movements already asked to be logged by earlier calls of this turn. */
  logged: number
  /** The kind and key of every fact earlier calls of this turn asked to remember: a key is said once per message. */
  remembered?: Set<string>
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

/** A call whose input has the tool's shape. */
interface Parsed {
  tool: ToolName
  data: unknown
}

function parseInput(name: string, input: unknown): Parsed | string {
  if (!(name in TOOL_INPUTS)) return `unknown tool ${name}`
  const tool = name as ToolName
  const parsed = (TOOL_INPUTS[tool]() as z.ZodType).safeParse(input)
  return parsed.success ? { tool, data: parsed.data } : `invalid input: ${issueList(parsed.error)}`
}

/** The issues of a log's movements: every value, and no more than a call may hold. */
const logIssues = (movements: Movement[], today: string) => checkLog(movements, today)

/**
 * The value guards: what a call's input says is a value the tables can hold, whoever sends it (WhatsApp's model or an MCP
 * client): amounts are decimal strings, dates are real days (and not in the future), words hold no long number, a fact is no
 * secret and fits. Nothing here knows of a conversation: no id was "shown", no earlier call of the message counts, and a fact
 * need not be words the person wrote. The refusal says why, in words for whoever sent it.
 */
function valueGuards(p: Parsed, today: string): Checked {
  const { tool } = p
  switch (tool) {
    case 'find_movements': {
      const f = p.data as ToolInput<'find_movements'>
      const issues = [
        ...(f.amount != null && !isDecimalAmount(f.amount)
          ? ['amount is not a decimal string']
          : []),
        ...(['from', 'to'] as const).flatMap((field) => {
          const day = f[field]
          const problem = day == null ? null : isoDateProblem(day)
          return problem ? [`${field} "${day}": ${problem}`] : []
        }),
      ]
      if (issues.length > 0) return rejected(issues.join('; '))
      // The size of a page is the caller's: WhatsApp's model is capped by `checkCall`, MCP's by its own page.
      return {
        kind: 'read',
        filter: {
          text: f.text ?? null,
          from: f.from ?? null,
          to: f.to ?? null,
          category: f.category ?? null,
          payment: f.payment ?? null,
          amount: f.amount ?? null,
          limit: Math.max(f.limit ?? 10, 1),
        },
      }
    }
    case 'log_movements': {
      const { movements, text } = p.data as ToolInput<'log_movements'>
      const issues = [...logIssues(movements, today), ...checkCount(movements.length)]
      return issues.length > 0
        ? rejected(issueText(issues))
        : { kind: 'action', action: { tool, input: { movements, text } } }
    }
    case 'correct_movement': {
      const { id, changes, text } = p.data as ToolInput<'correct_movement'>
      const issues = checkChanges(changes, today)
      if (issues.length > 0) return rejected(issueText(issues))
      if (!hasChanges(changes)) {
        return rejected('changes is empty: if you do not know what to change, call ask_user')
      }
      return { kind: 'action', action: { tool, input: { id, changes, text } } }
    }
    case 'summarize': {
      const q = p.data as ToolInput<'summarize'>
      // The description and the payment are copied into the line code renders, as written.
      const bad = [q.description, q.payment].some((w) => w != null && hasLongNumber(w))
      if (bad) return rejected('description and payment may not hold a number of 4 or more digits')
      const why = checkSummary(q, today)
      return why ? rejected(why) : { kind: 'action', action: { tool, input: q } }
    }
    case 'remember_fact': {
      const f = p.data as ToolInput<'remember_fact'>
      const checked = checkFactValues(f)
      if ('refused' in checked) return refusedFact(checked.refused)
      return checked.ok
        ? { kind: 'action', action: { tool, input: { ...checked.fact, text: f.text } } }
        : rejected(checked.message)
    }
    case 'forget_fact': {
      const { id, key, text } = p.data as ToolInput<'forget_fact'>
      const words = normalizeKey(key)
      if (id <= 0 && words === '') {
        return rejected('send the id of a fact you were shown, or its key (the words)')
      }
      // When both are sent the id decides: a key is only for a fact the sender cannot see.
      return {
        kind: 'action',
        action: { tool, input: { id: Math.max(id, 0), key: id > 0 ? '' : words, text } },
      }
    }
    // ask_user and reply are a conversation's alone; delete_movement is only an id; the rest take any input of the right shape.
    default:
      return { kind: 'action', action: { tool, input: p.data } as ModelAction }
  }
}

const refusedFact = (why: 'secret' | 'contact'): Checked => ({
  kind: 'action',
  action: {
    tool: 'notice',
    input: { text: why === 'secret' ? REPLY_FACT_SECRET : REPLY_FACT_CONTACT },
  },
})

/**
 * The value guards alone, for a caller that is not a conversation (an MCP client): the input has the tool's shape and
 * every value is one the tables can hold. See `valueGuards`.
 */
export function checkInput(name: string, input: unknown, today: string): Checked {
  const parsed = parseInput(name, input)
  return typeof parsed === 'string' ? rejected(parsed) : valueGuards(parsed, today)
}

/**
 * The guards of WhatsApp's model, that need no database: the value guards (`valueGuards`) plus what depends on the
 * conversation: every id is one the model was shown, the message holds at most 10 movements across its calls, a fact is
 * words the person wrote in this message, one value per key. Ownership and liveness are checked at the commit
 * point, under a row lock.
 */
export function checkCall(name: string, input: unknown, guard: Guard): Checked {
  const parsed = parseInput(name, input)
  if (typeof parsed === 'string') return rejected(parsed)
  const { tool, data } = parsed

  switch (tool) {
    case 'find_movements': {
      const checked = valueGuards(parsed, guard.today)
      return checked.kind === 'read'
        ? {
            kind: 'read',
            filter: { ...checked.filter, limit: Math.min(checked.filter.limit, MAX_FOUND) },
          }
        : checked
    }
    case 'log_movements': {
      const { movements, text } = data as ToolInput<'log_movements'>
      const issues = [
        ...logIssues(movements, guard.today),
        ...checkCount(guard.logged + movements.length),
      ]
      return issues.length > 0
        ? rejected(issueText(issues))
        : { kind: 'action', action: { tool, input: { movements, text } } }
    }
    case 'correct_movement': {
      const unseen = checkIds([(data as ToolInput<'correct_movement'>).id], guard)
      return unseen ? rejected(unseen) : valueGuards(parsed, guard.today)
    }
    case 'delete_movement': {
      const { id, text } = data as ToolInput<'delete_movement'>
      const unseen = checkIds([id], guard)
      return unseen ? rejected(unseen) : { kind: 'action', action: { tool, input: { id, text } } }
    }
    case 'ask_user':
      return checkAsk(data as ToolInput<'ask_user'>, guard)
    case 'remember_fact': {
      const f = data as ToolInput<'remember_fact'>
      const checked = checkFact(f, guard.message ?? '')
      if ('refused' in checked) return refusedFact(checked.refused)
      if (!checked.ok) return rejected(checked.message)
      const at = `${checked.fact.kind}:${checked.fact.key}`
      if (guard.remembered?.has(at)) {
        return rejected(`"${checked.fact.key}" was already sent in this message: one value per key`)
      }
      guard.remembered?.add(at)
      return { kind: 'action', action: { tool, input: { ...checked.fact, text: f.text } } }
    }
    case 'forget_fact': {
      const checked = valueGuards(parsed, guard.today)
      const id = (data as ToolInput<'forget_fact'>).id
      // An id the model sends must have been shown to it.
      if (checked.kind === 'action' && id > 0 && !guard.seenFacts?.has(id)) {
        return rejected(
          `fact id ${id} was not shown to you. Use only ids from "Hechos", or send its key (the words)`,
        )
      }
      return checked
    }
    default: // summarize, reply, help, undo_last, forget_all_facts, list_facts
      return valueGuards(parsed, guard.today)
  }
}

/** `ask_user`: a question with the movements to offer, whose every id the model was shown. */
function checkAsk(a: ToolInput<'ask_user'>, guard: Guard): Checked {
  const tool = 'ask_user'
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
