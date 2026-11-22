import type { z } from 'zod'
import { checkFact, checkFactValues, normalizeKey } from '../domain/facts'
import type { FindFilter } from '../domain/movements'
import { planRange } from '../domain/range'
import { checkReminder, scheduleOf } from '../domain/reminders/guard'
import { type Call, COMMANDS, type Input, isTool, MAX_FOUND, type Tool } from './commands'
import { hasLongNumber, hasNumberWord, unwritten } from './numbers'
import { holdsSecretValue } from './secrets'
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
 * The two layers of checks on what the model (or an MCP client) sent, none of which touches the database:
 *   - `checkValues` is what a call's input says: the shape of its tool, amounts that are decimal strings, real days not in the
 *     future, words with no long number, a fact that is no secret and fits. Nothing knows of a conversation. WhatsApp and MCP share it.
 *   - `checkTurn` is what the conversation says: every id was shown, a fact is words the person wrote, a key is said once, a message
 *     holds at most 10 movements, the tools that go alone go alone.
 * A refusal the model can fix is `rejected` with its reason. A refusal the person must read is `declined` with a typed code (a secret,
 * contact data, a reminder in the past or too far): redaction and the reply key on the code, never on reply text. Whether an id is the
 * account's and still live is decided at the commit point, under the account lock (`applyCall`).
 */

/** What code refuses on its own, for the person to read: a typed code, not a sentence. */
export const DECLINES = ['secret', 'contact', 'reminder_past', 'reminder_far'] as const
export type Declined = (typeof DECLINES)[number]

/** What a tool call comes to. */
export type Checked =
  /** Run it: the call, with its values as code keeps them (a key normalized, a reminder's text on one line). */
  | { kind: 'ok'; call: Call }
  /** A lookup to run before the turn goes on. */
  | { kind: 'read'; filter: FindFilter }
  /** What the model is told, to send it again. */
  | { kind: 'rejected'; message: string }
  /** Answered by code, for the person. The model is not asked to fix it. */
  | { kind: 'declined'; declined: Declined }

const rejected = (message: string): Checked => ({ kind: 'rejected', message })
const ok = <T extends Tool>(tool: T, input: Input<T>): Checked => ({
  kind: 'ok',
  call: { tool, input } as Call,
})
const declined = (declined: Declined): Checked => ({ kind: 'declined', declined })

export interface Env {
  /** The Argentine day of the message: no date may be after it. */
  today: string
  /** The instant of the message (its own time, never the clock): a reminder's first occurrence must be after it. */
  now: Date
}

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

const declinedFact = (why: 'secret' | 'contact') => declined(why)

/** The value rule of each tool. A tool without a rule of its own takes any input of the right shape. */
const VALUES = {
  find_movements: (f, _env) => {
    const issues = [
      ...(f.amount != null && !isDecimalAmount(f.amount) ? ['amount is not a decimal string'] : []),
      ...(['from', 'to'] as const).flatMap((field) => {
        const day = f[field]
        const problem = day == null ? null : isoDateProblem(day)
        return problem ? [`${field} "${day}": ${problem}`] : []
      }),
    ]
    if (issues.length > 0) return rejected(issues.join('; '))
    // The size of a page is the caller's: WhatsApp's model is capped by `checkTurn`, MCP's by its own page.
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
  },
  log_movements: (input, env) => {
    const issues = [...checkLog(input.movements, env.today), ...checkCount(input.movements.length)]
    return issues.length > 0 ? rejected(issueText(issues)) : ok('log_movements', input)
  },
  correct_movement: (input, env) => {
    const issues = checkChanges(input.changes, env.today)
    if (issues.length > 0) return rejected(issueText(issues))
    if (!hasChanges(input.changes)) {
      return rejected('changes is empty: if you do not know what to change, call ask_user')
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
  ask_user: (a, env) => {
    // One movement to delete is not a question: the person said which, so the delete is the answer.
    if (a.then.do === 'delete' && new Set(a.movement_ids).size === 1) {
      return rejected(
        'ask_user with then delete needs two or more movements. If the one movement is what they want gone, call delete_movement with its id; if nothing fits, reply',
      )
    }
    if (a.then.do === 'correct') {
      const issues = checkChanges(a.then.changes, env.today, 'then.changes')
      if (issues.length > 0) return rejected(issueText(issues))
      if (!hasChanges(a.then.changes)) {
        return rejected(
          'then.changes is empty: send the new value the person gave, or then {do: "ask_change"}',
        )
      }
    }
    return ok('ask_user', { ...a, movement_ids: [...new Set(a.movement_ids)] })
  },
  reply: (r) => (r.text.trim() === '' ? rejected('text is empty') : ok('reply', r)),
  skip: (s) => {
    const part = s.part.normalize('NFKC').replace(/\s+/g, ' ').trim()
    if (part === '') return rejected('part is empty: name the part of the message you did not do')
    if (part.split(' ').length > 8) return rejected('part is too long: at most 8 words')
    // Code copies it into the line it writes, so a figure there would be one no rule vouches for.
    if (/\d/.test(part) || hasNumberWord(part) || /[$:;!?¿¡]/.test(part)) {
      return rejected(
        'part has a number, a money sign or punctuation: name it in words, without figures',
      )
    }
    return ok('skip', { ...s, part })
  },
  help: (input) => ok('help', input),
  undo_last: (input) => ok('undo_last', input),
  remember_fact: (f) => {
    const checked = checkFactValues(f)
    if ('refused' in checked) return declinedFact(checked.refused)
    return checked.ok ? ok('remember_fact', checked.fact) : rejected(checked.message)
  },
  forget_fact: ({ target }) => {
    if ('id' in target) {
      return Number.isSafeInteger(target.id) && target.id > 0
        ? ok('forget_fact', { target })
        : rejected('target.id must be the id of a fact you were shown')
    }
    const key = normalizeKey(target.key)
    return key === ''
      ? rejected('send the id of a fact you were shown, or its key (the words)')
      : ok('forget_fact', { target: { key } })
  },
  forget_all_facts: (input) => ok('forget_all_facts', input),
  forget_all_confirmed: () => rejected('unknown tool forget_all_confirmed'),
  list_facts: (input) => ok('list_facts', input),
  set_reminder: (r, env) => reminder(r, env),
  cancel_reminder: ({ id }) =>
    Number.isSafeInteger(id) && id > 0
      ? ok('cancel_reminder', { id })
      : rejected('send the id of a reminder you were shown ("Recordatorios")'),
  list_reminders: (input) => ok('list_reminders', input),
} satisfies { [T in Tool]: (input: Input<T>, env: Env) => Checked }

/** The rules of a reminder, whoever sends it. `message` is the person's own, when there is one: a number in the text must be one they wrote. */
function reminder(r: Input<'set_reminder'>, env: Env, message?: string): Checked {
  const schedule = scheduleOf(r, env.now)
  if (typeof schedule === 'string') return rejected(schedule)
  const checked = checkReminder({ what: r.what, schedule }, env.now, message)
  if (checked.ok) return ok('set_reminder', { ...r, what: checked.what })
  if ('message' in checked) return rejected(checked.message)
  return declined(
    checked.refused === 'past'
      ? 'reminder_past'
      : checked.refused === 'far'
        ? 'reminder_far'
        : checked.refused,
  )
}

/**
 * The value guards of a call, for a caller that is not a conversation (an MCP client) and as the first layer of WhatsApp's: the
 * input has the tool's shape and every value is one the tables can hold.
 */
export function checkValues(tool: string, input: unknown, env: Env): Checked {
  if (!isTool(tool) || COMMANDS[tool].by === 'code') return rejected(`unknown tool ${tool}`)
  const parsed = COMMANDS[tool].input.safeParse(input)
  if (!parsed.success) return rejected(`invalid input: ${issueList(parsed.error)}`)
  const rule = VALUES[tool] as (input: unknown, env: Env) => Checked
  return rule(parsed.data, env)
}

// ---- The conversation's rules

/** What the model has been shown, by the ids it may act on (`context.ts` builds it): each kind of id is in its own space. */
export interface Shown {
  movements: ReadonlySet<number>
  facts: ReadonlySet<number>
  reminders: ReadonlySet<number>
  /** The id of the pending question's only option, when it has exactly one: a change in this message is about it. */
  sole?: number
}

const ALONE =
  'goes alone: it cannot be sent with other actions. Send it alone; for any other part of the message use skip {part, reason}.'

function unseen(
  ids: number[],
  shown: ReadonlySet<number>,
  what: string,
  where: string,
): string | null {
  const bad = ids.filter((id) => !Number.isSafeInteger(id) || id < 1 || !shown.has(id))
  return bad.length === 0
    ? null
    : `${what} ${bad.join(', ')} was not shown to you. Use only ids from ${where}; call find_movements to look for an older movement.`
}

/**
 * The conversation rules over the whole turn: `calls` are already value-checked (`checkValues`), in the order the model sent
 * them, and each gets a verdict in the same order. `message` is the person's own message (or what was heard in a voice note).
 */
export function checkTurn(calls: readonly Call[], shown: Shown, message: string): Checked[] {
  let logged = 0
  const remembered = new Set<string>()
  const alone = new Set(calls.filter((c) => COMMANDS[c.tool].alone).map((c) => c.tool))
  return calls.map((call): Checked => {
    // A tool that goes alone is refused beside any other call of the turn.
    if (alone.has(call.tool) && calls.length > 1) return rejected(`${call.tool} ${ALONE}`)
    switch (call.tool) {
      case 'log_movements': {
        logged += call.input.movements.length
        const issues = checkCount(logged)
        return issues.length > 0 ? rejected(issueText(issues)) : { kind: 'ok', call }
      }
      case 'correct_movement': {
        const bad = unseen(
          [call.input.id],
          shown.movements,
          'id',
          '"Últimos movimientos", a find_movements result or the pending question',
        )
        return bad ? rejected(bad) : { kind: 'ok', call }
      }
      case 'delete_movement': {
        const bad = unseen(
          [call.input.id],
          shown.movements,
          'id',
          '"Últimos movimientos", a find_movements result or the pending question',
        )
        return bad ? rejected(bad) : { kind: 'ok', call }
      }
      case 'ask_user': {
        const bad = unseen(
          call.input.movement_ids,
          shown.movements,
          'id',
          '"Últimos movimientos", a find_movements result or the pending question',
        )
        if (bad) return rejected(bad)
        const [only] = call.input.movement_ids
        const { then } = call.input
        // The person answers a question about one movement with a change ("a ese ponele 3500"): that is the correction, on the
        // movement they were shown. Asking again would loop.
        if (
          then.do === 'correct' &&
          only !== undefined &&
          call.input.movement_ids.length === 1 &&
          only === shown.sole
        ) {
          return {
            kind: 'ok',
            call: { tool: 'correct_movement', input: { id: only, changes: then.changes } },
          }
        }
        return { kind: 'ok', call }
      }
      case 'remember_fact': {
        const checked = checkFact(call.input, message)
        if ('refused' in checked) return declinedFact(checked.refused)
        if (!checked.ok) return rejected(checked.message)
        const at = `${checked.fact.kind}:${checked.fact.key}`
        if (remembered.has(at)) {
          return rejected(
            `"${checked.fact.key}" was already sent in this message: one value per key`,
          )
        }
        remembered.add(at)
        return ok('remember_fact', checked.fact)
      }
      case 'forget_fact': {
        const { target } = call.input
        if ('id' in target && !shown.facts.has(target.id)) {
          return rejected(
            `fact id ${target.id} was not shown to you. Use only ids from "Hechos", or send its key (the words)`,
          )
        }
        return { kind: 'ok', call }
      }
      case 'cancel_reminder':
        return shown.reminders.has(call.input.id)
          ? { kind: 'ok', call }
          : rejected(
              `reminder id ${call.input.id} was not shown to you. Use only ids from "Recordatorios"; if it is not listed, reply that you do not see it`,
            )
      case 'set_reminder': {
        // A message that holds a secret sets no reminder, whatever the model leaves of it in `what`; and the text may hold only
        // numbers the person wrote.
        if (holdsSecretValue(message)) return declined('secret')
        const made = unwritten(call.input.what, message)
        return made.length > 0
          ? rejected(
              `numbers the person did not write in what: ${[...new Set(made)].join(', ')}. Leave them out`,
            )
          : { kind: 'ok', call }
      }
      default:
        return { kind: 'ok', call }
    }
  })
}

/** A read, capped for WhatsApp's model: `find_movements` returns at most `MAX_FOUND` rows. */
export const capFind = (filter: FindFilter): FindFilter => ({
  ...filter,
  limit: Math.min(filter.limit, MAX_FOUND),
})
