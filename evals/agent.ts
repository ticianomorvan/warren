import type Anthropic from '@anthropic-ai/sdk'
import {
  type Action,
  type ModelKey,
  type RecentMovement,
  renderContext,
  runAgent,
  type Usage,
} from '../src/agent'
import { MAX_FOUND } from '../src/agent/schema'
import type { FindFilter, MovementRow } from '../src/ledger'
import { normalizeText } from '../src/movement'
import { argentinaTime } from '../src/time'
import type { Changes, Command } from './command'
import type { EvalCase } from './grade'

/** Ids of the case's list: the newest has the highest, like stored ones. */
const idOf = (k: number) => 200 - k

const NONE: Changes = {
  direction: null,
  amount: null,
  currency: null,
  date: null,
  description: null,
  category: null,
  payment: null,
}

const rows = (recent: RecentMovement[]): MovementRow[] =>
  recent.map((m, k) => ({ ...m, id: idOf(k), time: m.time ?? '10:00' }))

/** `find_movements` over the case's own list: the eval has no database. */
function find(list: MovementRow[], f: FindFilter): MovementRow[] {
  const words = normalizeText(f.text ?? '')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  return list
    .filter((m) => {
      const hay = normalizeText(`${m.description} ${m.category.replace('_', ' ')}`)
      return (
        words.every((w) => hay.includes(w)) &&
        (!f.category || m.category === f.category) &&
        (!f.from || m.date >= f.from) &&
        (!f.to || m.date <= f.to) &&
        (!f.amount || Number(m.amount) === Number(f.amount)) &&
        (!f.payment || normalizeText(m.payment ?? '').includes(normalizeText(f.payment)))
      )
    })
    .slice(0, Math.min(f.limit, MAX_FOUND))
}

/** What a case's previous reply offered: its option numbers are list positions, as the old questions numbered them. */
const optionsOf = (reply: string, list: MovementRow[]) =>
  [...reply.matchAll(/(?:^|\s)(\d+)\. /g)]
    .map((m, k) => ({ number: k + 1, id: list[Number(m[1]) - 1]?.id ?? 0 }))
    .filter((a) => a.id > 0)

/** The agent's first action as the command the case grades; an `ask_user` is a low-confidence command. */
export function toCommand(actions: Action[], list: MovementRow[]): Command {
  const [first] = actions
  const index = (id: number) => {
    const k = list.findIndex((m) => m.id === id)
    return k < 0 ? null : k + 1
  }
  const word = (id: number) => list.find((m) => m.id === id)?.description ?? ''
  switch (first?.tool) {
    case 'log_movements':
      return { type: 'log', movements: first.input.movements }
    case 'correct_movement':
      return {
        type: 'correct',
        target: word(first.input.id),
        target_index: index(first.input.id),
        changes: {
          ...NONE,
          ...Object.fromEntries(Object.entries(first.input.changes).filter(([, v]) => v != null)),
        },
        confidence: 'high',
      }
    case 'delete_movement':
      return {
        type: 'delete',
        target: word(first.input.id),
        target_index: index(first.input.id),
        confidence: 'high',
      }
    case 'summarize':
      return { type: 'query', ...first.input }
    case 'ask_user':
      return first.input.after_answer === 'delete'
        ? { type: 'delete', target: first.input.question, target_index: null, confidence: 'low' }
        : {
            type: 'correct',
            target: first.input.question,
            target_index: null,
            changes: {
              ...NONE,
              ...Object.fromEntries(
                Object.entries(first.input.changes ?? {}).filter(([, v]) => v != null),
              ),
            },
            confidence: 'low',
          }
    case 'reply':
      return first.input.kind === 'help' || first.input.kind === 'nothing_logged'
        ? { type: 'help' }
        : { type: 'off_topic' }
    default:
      return { type: 'help' }
  }
}

export interface AgentCaseResult {
  command: Command
  actions: Action[]
  usage: Usage
  turns: number
  latencyMs: number
}

/** Runs the agent on one case: the case's list as the 10 newest movements, its previous exchange as the conversation. */
export async function runCase(
  c: EvalCase,
  o: { client: Anthropic; model: ModelKey },
): Promise<AgentCaseResult> {
  const list = rows(c.recent)
  const asked = c.previous ? optionsOf(c.previous.reply, list) : []
  const result = await runAgent({
    client: o.client,
    model: o.model,
    context: renderContext({
      text: c.text,
      today: c.today,
      time: argentinaTime(new Date(`${c.today}T15:00:00Z`)),
      movements: list,
      conversation: c.previous ? [{ ...c.previous, minutesAgo: 1 }] : [],
      pending: asked.length > 0 ? { asked, action: 'none' } : null,
    }),
    today: c.today,
    env: { find: async (f) => find(list, f) },
    seen: new Set([...list.map((m) => m.id), ...asked.map((a) => a.id)]),
  })
  return {
    command: toCommand(result.actions, list),
    actions: result.actions,
    usage: result.usage,
    turns: result.turns,
    latencyMs: result.ms,
  }
}

/**
 * Cases the agent answers in code, with no model call: the message is only the pick of an option
 * of the question just asked ("2", "el primero"), or "sí" after a one-option question. The unit
 * tests cover them (`answerAction`); the model is not measured on them.
 */
export const answeredByCode = (c: EvalCase) =>
  c.previous?.reply.startsWith('¿Cuál?') === true &&
  !c.ambiguous &&
  (c.expected.type === 'correct' || c.expected.type === 'delete')
