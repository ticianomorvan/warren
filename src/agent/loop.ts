import type Anthropic from '@anthropic-ai/sdk'
import type { FindFilter, MovementRow } from '../ledger'
import { type Checked, checkCall, type Guard } from './calls'
import { MODELS, type ModelKey, type Usage } from './models'
import { movementLine, SYSTEM_PROMPT } from './prompt'
import type { Action } from './schema'
import { TOOLS } from './tools'

/** The most model calls one message may use: a read, then the action, with one to spare for a refusal. */
export const MAX_TURNS = 3

/** The loop could not end in valid actions: the message fails with the failure notice and writes nothing. */
/** The loop ended with no valid action. Carries what it tried, so a failed message keeps its audit. */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly audit: AuditEntry[] = [],
    readonly turns = 0,
  ) {
    super(message)
  }
}

/** One tool call of the loop, kept on the message row. */
export interface AuditEntry {
  turn: number
  tool: string
  input: unknown
  /**
   * `ok` a read that ran; `rejected` refused by a guard (the model was told); `skipped` valid but not
   * run because another call of its turn was refused; `applied`, `gone`, `unchanged`, `answered` what
   * the commit point did with an action.
   */
  status: string
  detail?: string
  ms: number
  /** Index into the message's actions, for the ones that run at the commit point. */
  action?: number
}

export interface AgentEnv {
  find(filter: FindFilter): Promise<MovementRow[]>
}

export interface AgentInput {
  client: Anthropic
  model: ModelKey
  /** The volatile first user message (`renderContext`). */
  context: string
  today: string
  env: AgentEnv
  /** Ids the model may act on. The loop adds what `find_movements` returns. */
  seen: Set<number>
  /** Aborts the call and the SDK's retries: the message deadline and the shutdown. */
  signal?: AbortSignal
}

export interface AgentResult {
  actions: Action[]
  audit: AuditEntry[]
  turns: number
  usage: Usage
  /** Wall time of the whole loop, reads included. */
  ms: number
}

/**
 * Everything of a request that does not change between messages: the model, the tools and the system
 * prompt. The tools and the system prompt are the frozen prefix, under one cache breakpoint.
 */
export const requestBase = (model: ModelKey) => ({
  model: MODELS[model].id,
  thinking: MODELS[model].thinking,
  output_config: { effort: 'low' as const },
  tools: TOOLS,
  system: [
    { type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } },
  ],
})

/**
 * One tiny request at startup. The API compiles the strict tool grammar on the first request after
 * the tool schema changes (about 10 s, measured 2026-11-21) and caches it; this makes the first
 * person's message not pay for that, and it writes the prompt cache.
 */
export async function warmUp(client: Anthropic, model: ModelKey): Promise<void> {
  await client.messages.create({
    ...requestBase(model),
    max_tokens: 16,
    messages: [{ role: 'user', content: 'ping' }],
  })
}

const NO_TOOL =
  'You did not call a tool. Answer only by calling one: reply (help, off_topic, smalltalk, nothing_logged), ask_user, log_movements, correct_movement, delete_movement or summarize.'

const FOUND = (rows: MovementRow[]) =>
  rows.length === 0
    ? 'No matches.'
    : `${rows.length} found, newest first:\n${rows.map(movementLine).join('\n')}`

/**
 * The agent loop, by hand. Each turn is one `messages.create`; reads (`find_movements`) run and their
 * results go back in a single user message; the first turn with valid action calls ends the loop, and
 * code runs those actions at the commit point. A refused call is answered with its reason (as an
 * error result) and the model gets another turn, up to the cap. Nothing is written here.
 */
export async function runAgent(i: AgentInput): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: i.context }]
  const audit: AuditEntry[] = []
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const started = performance.now()

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const response = await i.client.messages.create(
      { ...requestBase(i.model), max_tokens: 2048, messages },
      i.signal ? { signal: i.signal } : undefined,
    )
    usage.inputTokens += response.usage.input_tokens
    usage.outputTokens += response.usage.output_tokens
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0

    if (response.stop_reason === 'max_tokens')
      throw new AgentError(`turn ${turn}: cut off`, audit, turn)
    const calls = response.content.filter((b) => b.type === 'tool_use')
    if (calls.length === 0) {
      // The model wrote text instead of acting (tool use cannot be forced on every model). Say so once
      // and let it try again; its text is never sent to the person.
      audit.push({
        turn,
        tool: 'text',
        input: null,
        status: 'rejected',
        detail: 'no tool call',
        ms: 0,
      })
      messages.push({
        role: 'assistant',
        content: response.content.length > 0 ? response.content : '(no answer)',
      })
      messages.push({ role: 'user', content: NO_TOOL })
      continue
    }

    // Writes are checked against what the model had seen when this turn began: results of a
    // find_movements in the same turn reach the model only on the next turn, so an id that appears
    // there for the first time was guessed, not chosen.
    const guard: Guard = { today: i.today, seen: new Set(i.seen), logged: 0 }
    const foundThisTurn: number[] = []
    const actions: Action[] = []
    const checked: {
      call: (typeof calls)[number]
      result: Checked
      entry: AuditEntry
      text: string
    }[] = []
    for (const call of calls) {
      const t0 = performance.now()
      const result = checkCall(call.name, call.input, guard)
      let text = ''
      let status = 'ok'
      if (result.kind === 'read') {
        const rows = await i.env.find(result.filter)
        for (const row of rows) foundThisTurn.push(row.id)
        text = FOUND(rows)
      } else if (result.kind === 'action') {
        status = 'accepted'
        if (result.action.tool === 'log_movements')
          guard.logged += result.action.input.movements.length
      } else {
        status = 'rejected'
        text = result.message
      }
      const entry: AuditEntry = {
        turn,
        tool: call.name,
        input: call.input,
        status,
        ms: Math.round(performance.now() - t0),
      }
      if (result.kind === 'rejected') entry.detail = result.message
      checked.push({ call, result, entry, text })
    }

    for (const id of foundThisTurn) i.seen.add(id)

    const refused = checked.some((c) => c.result.kind === 'rejected')
    for (const c of checked) {
      if (c.result.kind === 'action') {
        if (refused) c.entry.status = 'skipped'
        else {
          c.entry.action = actions.length
          actions.push(c.result.action)
        }
      }
      audit.push(c.entry)
    }
    if (actions.length > 0) {
      return { actions, audit, turns: turn, usage, ms: performance.now() - started }
    }

    messages.push({ role: 'assistant', content: response.content })
    messages.push({
      role: 'user',
      content: checked.map(({ call, result, text }) => ({
        type: 'tool_result' as const,
        tool_use_id: call.id,
        content:
          result.kind === 'action'
            ? 'Not run: another call of this turn was refused. Send all the actions again, corrected.'
            : text,
        is_error: result.kind !== 'read',
      })),
    })
  }
  throw new AgentError(`no valid action after ${MAX_TURNS} model turns`, audit, MAX_TURNS)
}
