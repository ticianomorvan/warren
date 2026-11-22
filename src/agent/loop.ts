import type Anthropic from '@anthropic-ai/sdk'
import type { FindFilter, MovementRow } from '../ledger'
import type { TurnTiming } from '../timings'
import { type Checked, checkCall, type Guard } from './calls'
import { MODELS, type ModelKey, type Usage } from './models'
import { movementFact, movementLine, SYSTEM_PROMPT } from './prompt'
import { type Applied, checkSay } from './say'
import type { ModelAction, Notice } from './schema'
import { TOOLS } from './tools'

/** The amounts and dates an action carries: code renders them, so the model's text may repeat them. */
const amountsOf = (action: Run): string[] => {
  const of = (m: { amount?: string; date?: string }) => `${m.amount ?? ''} ${m.date ?? ''}`
  switch (action.tool) {
    case 'log_movements':
      return action.input.movements.map(of)
    case 'correct_movement':
      return [of(action.input.changes)]
    case 'ask_user':
      return action.input.changes ? [of(action.input.changes)] : []
    default:
      return []
  }
}

/** The most model calls one message may use: a read, then the action, with one to spare for a refusal. */
export const MAX_TURNS = 3

/** The loop could not end in valid actions: the message fails with the failure notice and writes nothing. */
/** The loop ended with no valid action. Carries what it tried, so a failed message keeps its audit. */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly audit: AuditEntry[] = [],
    readonly turns = 0,
    /** The model calls it made, for the failed message's stored timings. */
    readonly turnLog: TurnTiming[] = [],
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
   * run because another call of its turn was refused; `held` valid but not run because the same turn
   * also searched (the model sends it again with the results); `repair` valid but not run because a text
   * of the turn failed the numbers check (the model sends it again with the reason); `applied`, `gone`, `unchanged`,
   * `answered` what the commit point did with an action (an undo that did nothing: `nothing`, `expired`, `stale`).
   */
  status: string
  detail?: string
  ms: number
  /** Index into the message's actions, for the ones that run at the commit point. */
  action?: number
  /** What became of the action's `text`: sent after the lines, or dropped for `textReason`. */
  text?: 'sent' | 'dropped'
  textReason?: string
}

export interface AgentEnv {
  find(filter: FindFilter): Promise<MovementRow[]>
}

/** A photo the person sent: what the model is shown beside the context. Never stored. */
export interface Photo {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  /** Base64 of the bytes. */
  data: string
}

export interface AgentInput {
  client: Anthropic
  model: ModelKey
  /** The volatile first user message (`renderContext`). */
  context: string
  /** The photo of this message, if there is one: shown to the model before the context. */
  photo?: Photo
  /**
   * What the model's own words may take numbers from (`contextFacts`, without this message's searches),
   * what Warren answered earlier (`windowReplies`) and the person's message: a text that fails the numbers
   * check is sent back to the model for another try, inside the cap, instead of being dropped at the end.
   */
  facts: string[]
  window: string[]
  message: string
  today: string
  env: AgentEnv
  /** Ids the model may act on. The loop adds what `find_movements` returns. */
  seen: Set<number>
  /** Ids of the facts the model is shown (`ContextInput.memory`): the only ones `forget_fact` may name by id. */
  seenFacts?: ReadonlySet<number>
  /** The only option of the pending question, when it has exactly one (see `Guard.sole`). */
  sole?: number
  /** Aborts the call and the SDK's retries: the message deadline and the shutdown. */
  signal?: AbortSignal
}

/** What a turn ends in: the model's terminal calls, and a notice code put in place of a refused secret. */
type Run = ModelAction | Notice

export interface AgentResult {
  actions: Run[]
  /** Every movement this message's `find_movements` calls returned: what the model may quote. */
  found: MovementRow[]
  audit: AuditEntry[]
  turns: number
  usage: Usage
  /** Each model call: its own time, the reads that followed it and its tokens (`Timings.turns`). */
  turnLog: TurnTiming[]
  /** Wall time of the whole loop, reads included. */
  ms: number
}

/**
 * How long the frozen prefix stays cached. One hour, not the default five minutes: a person writes every 10 to
 * 30 minutes, so with 5 minutes nearly every message is a miss that writes the whole prefix again (12.5 times the
 * price of reading it), and with one hour nearly every message is a read. The write costs 2x the input price
 * instead of 1.25x (agent-spec, speed pass notes). The startup warm-up goes through `requestBase`, so it writes
 * the same TTL.
 */
export const CACHE_TTL = '1h' as const

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
    {
      type: 'text' as const,
      text: SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' as const, ttl: CACHE_TTL },
    },
  ],
})

/**
 * One tiny request at startup: it writes the prompt cache (with the TTL of every request) and opens the
 * connection, so the first person's message pays for neither.
 */
export async function warmUp(client: Anthropic, model: ModelKey): Promise<void> {
  await client.messages.create({
    ...requestBase(model),
    max_tokens: 16,
    messages: [{ role: 'user', content: 'ping' }],
  })
}

const NO_TOOL =
  'You did not call a tool. Answer only by calling one: reply (your words), help, ask_user, log_movements, correct_movement, delete_movement, undo_last or summarize.'

/** The answer to a change that came in the same turn as a search: it was not run, and why. */
const HELD =
  'Not run: this turn also searched, and you could not have seen the results when you wrote this. Your changes were not run; send every change again (new movements, corrections, deletions, and your text for the parts you did not do), now that you have the results.'
const LAST_TURN =
  'Your next turn is the last one: do not search again; send every action, and your text for any part you could not do.'
const repairText = (tool: string, reason: string) =>
  `Not run: your text for ${tool} would not be sent (${reason}). A text may use only numbers the person wrote, numbers in the lists or search results you were shown, or the amounts and dates you send in these actions. Counts, totals and numbers in words ("cuatro", "dos veces") are code's: for a count or a total call summarize (it can filter by description) and let its line answer; or word the text without the number. Send every action again, with the text fixed or null.`
const REPAIR_OTHER =
  'Not run: a text of another call of this turn would not be sent. Send every action again, with that text fixed or null.'
const ALONE =
  'undo_last undoes the previous batch of changes and cannot be sent with other actions. Send it alone, with a text for any other part of the message ("Mandame lo otro aparte."); or, if the person named one movement ("deshacé el café"), it is delete_movement or correct_movement instead.'
const REFUSED =
  'Not run: another call of this turn was refused. Send all the actions again, corrected.'

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
  const first: Anthropic.MessageParam['content'] = i.photo
    ? [
        {
          type: 'image',
          source: { type: 'base64', media_type: i.photo.mediaType, data: i.photo.data },
        },
        { type: 'text', text: i.context },
      ]
    : i.context
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: first }]
  const found = new Map<number, MovementRow>()

  /** The texts among `acts` that fail the numbers check (an echo of the person is not a flaw: it is just dropped). */
  const textFlaws = (acts: Run[]) => {
    const rows = [...found.values()].map(movementFact)
    const given = acts.flatMap(amountsOf)
    const applied: Applied = {
      deleted: acts.some((a) => a.tool === 'delete_movement'),
      corrected: acts.some((a) => a.tool === 'correct_movement'),
      logged: acts.some((a) => a.tool === 'log_movements'),
      undone: acts.some((a) => a.tool === 'undo_last'),
      remembered: acts.some((a) => a.tool === 'remember_fact'),
      forgotten: acts.some((a) => a.tool === 'forget_fact'),
    }
    return acts.flatMap((action) => {
      if (!('text' in action.input)) return []
      const text = action.input.text ?? ''
      if (text.trim() === '' && action.tool !== 'reply') return []
      const check = checkSay(text, {
        numbers: [...i.facts, ...rows, ...given],
        words: [...i.facts, ...rows],
        message: i.message,
        applied,
        ...(action.tool === 'reply' ? { window: i.window } : {}),
      })
      return check.ok || check.echo ? [] : [{ action, tool: action.tool, reason: check.reason }]
    })
  }
  const audit: AuditEntry[] = []
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
  }
  const turnLog: TurnTiming[] = []
  const started = performance.now()

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const calledAt = performance.now()
    const response = await i.client.messages.create(
      { ...requestBase(i.model), max_tokens: 2048, messages },
      i.signal ? { signal: i.signal } : undefined,
    )
    const timing: TurnTiming = {
      model_ms: Math.round(performance.now() - calledAt),
      find_ms: 0,
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cache_read: response.usage.cache_read_input_tokens ?? 0,
      cache_write: response.usage.cache_creation_input_tokens ?? 0,
      text_chars: response.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0),
    }
    turnLog.push(timing)
    usage.inputTokens += response.usage.input_tokens
    usage.outputTokens += response.usage.output_tokens
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0
    usage.cacheWrite1hTokens += response.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0

    if (response.stop_reason === 'max_tokens')
      throw new AgentError(`turn ${turn}: cut off`, audit, turn, turnLog)
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

    // Ids found in this turn are added to `i.seen` only after every call is checked, so an id that
    // appears in a search of this very turn was guessed, not chosen (and a turn that searched runs no
    // write anyway: it is held).
    const guard: Guard = {
      today: i.today,
      seen: i.seen,
      logged: 0,
      sole: i.sole,
      message: i.message,
      seenFacts: i.seenFacts,
      remembered: new Set(),
    }
    const foundThisTurn: number[] = []
    const actions: Run[] = []
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
        timing.find_ms += Math.round(performance.now() - t0)
        for (const row of rows) {
          foundThisTurn.push(row.id)
          found.set(row.id, row)
        }
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

    // Undoing the last batch stands alone: it is about earlier messages, and a change beside it would be
    // part of "the last thing", whichever order code ran them in.
    const undo = checked.find(
      (c) => c.result.kind === 'action' && c.result.action.tool === 'undo_last',
    )
    if (undo && checked.some((c) => c !== undo && c.result.kind === 'action')) {
      undo.result = {
        kind: 'rejected',
        message: ALONE,
      }
      undo.text = ALONE
      undo.entry.status = 'rejected'
      undo.entry.detail = ALONE
    }

    for (const id of foundThisTurn) i.seen.add(id)

    // A turn that searches and also changes something is not run: the changes were written without the
    // results, so the model sends them again (a part it wrote blind may be wrong, or missing).
    const refused = checked.some((c) => c.result.kind === 'rejected')
    const searched = checked.some((c) => c.result.kind === 'read')
    const candidates = checked.flatMap((c) => (c.result.kind === 'action' ? [c.result.action] : []))
    // A text that would be dropped at the end is sent back instead, while there is a turn left to fix it.
    // (On the last turn it goes on and the commit point drops it.)
    const flaws = refused || searched || turn === MAX_TURNS ? [] : textFlaws(candidates)
    for (const c of checked) {
      if (c.result.kind === 'action') {
        const { action } = c.result
        const flaw = flaws.find((f) => f.action === action)
        if (refused) c.entry.status = 'skipped'
        else if (searched) c.entry.status = 'held'
        else if (flaws.length > 0) {
          c.entry.status = 'repair'
          if (flaw) c.entry.detail = flaw.reason
        } else {
          c.entry.action = actions.length
          actions.push(action)
        }
      }
      audit.push(c.entry)
    }
    if (actions.length > 0) {
      return {
        actions,
        found: [...found.values()],
        audit,
        turns: turn,
        usage,
        turnLog,
        ms: performance.now() - started,
      }
    }

    messages.push({ role: 'assistant', content: response.content })
    const answerFor = (action: Run) => {
      if (refused) return REFUSED
      if (searched) return HELD
      const flaw = flaws.find((f) => f.action === action)
      return flaw ? repairText(flaw.tool, flaw.reason) : REPAIR_OTHER
    }
    const results: Anthropic.ContentBlockParam[] = checked.map(({ call, result, text }) => ({
      type: 'tool_result' as const,
      tool_use_id: call.id,
      content: result.kind === 'action' ? answerFor(result.action) : text,
      is_error: result.kind !== 'read',
    }))
    // Nothing is held on a last turn that cannot be repeated, so say that it is the last.
    if (turn === MAX_TURNS - 1) results.push({ type: 'text', text: LAST_TURN })
    messages.push({ role: 'user', content: results })
  }
  throw new AgentError(`no valid action after ${MAX_TURNS} model turns`, audit, MAX_TURNS, turnLog)
}
