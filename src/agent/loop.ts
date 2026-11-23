import type Anthropic from '@anthropic-ai/sdk'
import { type Call, COMMANDS } from '../core/commands'
import { capFind, checkTurn, checkValues, type Declined, type Shown } from '../core/guards'
import type { MovementRow } from '../domain/movements'
import type { TurnTiming } from '../timings'
import { movementLine } from './context'
import { MODELS, type ModelKey, type Usage } from './models'
import { SYSTEM_PROMPT } from './prompt'
import { TOOLS } from './tools'

/** The most model calls one message may use: a read, then the action, with one to spare for a refusal. */
export const MAX_TURNS = 3

/** The longest one model call may take. A stalled call is cut and tried once more, inside the message's own deadline. */
export const CALL_TIMEOUT_MS = 8_000

/**
 * The loop could not end in valid calls: the message fails with the failure notice and writes nothing. Carries what it tried, so a
 * failed message keeps its audit. `refusal` is the category of a safety refusal: the person gets the failure notice and the model is
 * not asked again.
 */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly audit: AuditEntry[] = [],
    readonly turns = 0,
    /** The model calls it made, for the failed message's stored timings. */
    readonly turnLog: TurnTiming[] = [],
    readonly refusal?: string,
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
   * `ok` a read that ran; `rejected` refused by a guard (the model was told); `skipped` valid but not run because another call of
   * its turn was refused; `held` valid but not run because the same turn also searched (the model sends it again with the results);
   * `accepted` valid, run at the commit point; `declined` answered by code for the person (a secret, a reminder in the past...);
   * `refusal` the model's safety refusal, with its category in `detail`. The commit point then adds `applied`, `gone`, `unchanged`...
   */
  status: string
  detail?: string
  ms: number
  /** Index into the message's calls, for the ones that run at the commit point. */
  action?: number
}

export interface AgentEnv {
  find(filter: ReturnType<typeof capFind>): Promise<MovementRow[]>
}

/** A photo the person sent: what the model is shown beside the context. Never stored. */
export interface Photo {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  /** Base64 of the bytes. */
  data: string
}

export interface AgentInput {
  client: Anthropic
  model?: ModelKey
  /** The volatile first user message (`renderContext(...).text`). */
  context: string
  photo?: Photo
  /** The ids the model may act on. The loop adds what `find_movements` returns, on its own copy. */
  shown: Shown
  /** The person's message (or what was heard), for the conversation rules. */
  message: string
  today: string
  /** The instant of the message: a reminder's first occurrence must be after it. */
  now: Date
  env: AgentEnv
  /** Aborts the call and the SDK's retries: the message deadline and the shutdown. */
  signal?: AbortSignal
  /**
   * Why a `reply` text may not be sent (a number code did not give, a claim of a change), or null when it may. The loop gives the
   * model the reason and another turn to write it again, so the person gets its words and not the fallback.
   */
  vet?: (text: string, found: readonly MovementRow[]) => string | null
  /** When the message's own deadline passes: each call's timeout is cut to fit before it. */
  deadlineAt?: number
}

export interface AgentResult {
  /** What the turn ends in, as the commit point takes it: the model's valid calls, in order. */
  calls: Call[]
  /** What code answers for the person instead of a call (a secret, a reminder in the past...). */
  declined: Declined[]
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

/** The usage of a message, summed from its turn log: the one place tokens are kept. */
export function sumUsage(turnLog: readonly TurnTiming[]): Usage {
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
  }
  for (const t of turnLog) {
    usage.inputTokens += t.input
    usage.outputTokens += t.output
    usage.cacheReadTokens += t.cache_read
    usage.cacheWriteTokens += t.cache_write
    usage.cacheWrite1hTokens += t.cache_write_1h ?? 0
  }
  return usage
}

/**
 * How long the frozen prefix stays cached. One hour, not the default five minutes: a person writes every 10 to 30 minutes, so with
 * 5 minutes nearly every message is a miss that writes the whole prefix again, and with one hour nearly every message is a read.
 * The start-up warm-up goes through `requestBase`, so it writes the same TTL.
 */
export const CACHE_TTL = '1h' as const

/**
 * Everything of a request that does not change between messages: the model, the tools and the system prompt. The tools and the
 * system prompt are the frozen prefix, under one cache breakpoint. Thinking is disabled at effort low (measured); the tools are not
 * `strict` (strict decoding made every call about 0.35 s slower).
 */
export const requestBase = (model: ModelKey = 'haiku') => ({
  model: MODELS[model].id,
  thinking: MODELS[model].thinking,
  output_config: { effort: MODELS[model].effort },
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
 * One request at startup that writes the prompt cache (with the TTL of every request) and opens the connection, so the first
 * person's message pays for neither. `max_tokens: 0` is the API's documented pre-warm: it returns at once and bills no output.
 */
export async function warmUp(client: Anthropic, model: ModelKey = 'haiku'): Promise<void> {
  await client.messages.create({
    ...requestBase(model),
    max_tokens: 0,
    messages: [{ role: 'user', content: 'ping' }],
  })
}

const NO_TOOL = `You did not call a tool. Answer only by calling one: ${Object.entries(COMMANDS)
  .filter(([, entry]) => entry.by !== 'code')
  .map(([name]) => name)
  .join(', ')}.`

/** The answer to a change that came in the same turn as a search: it was not run, and why. */
const HELD =
  'Not run: this turn also searched, and you could not have seen the results when you wrote this. Your changes were not run; send every change again (new movements, corrections, deletions, and skip for the parts you did not do), now that you have the results.'
const LAST_TURN =
  'Your next turn is the last one: do not search again; send every action, and a skip for any part you could not do.'
const REFUSED =
  'Not run: another call of this turn was refused. Send all the actions again, corrected.'

const FOUND = (rows: MovementRow[]) =>
  rows.length === 0
    ? 'No matches.'
    : `${rows.length} found, newest first:\n${rows.map(movementLine).join('\n')}`

/** One call after the guards: what it comes to and the audit entry that will say so. */
type Verdict =
  | { kind: 'ok'; call: Call }
  | { kind: 'read'; rows: MovementRow[] }
  | { kind: 'rejected'; message: string }
  | { kind: 'declined'; declined: Declined }

/**
 * The agent loop, by hand. Each turn is one `messages.create`; reads (`find_movements`) run and their results go back in a single
 * user message; the first turn with valid calls ends the loop, and code runs those calls at the commit point. A refused call is
 * answered with its reason (as an error result) and the model gets another turn, up to the cap. Nothing is written here, and a
 * turn runs whole or not at all: if one call is refused the others are `skipped`.
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
  // The caller's set stays untouched: this loop adds what a search finds to its own copy.
  const shown: Shown = { ...i.shown, movements: new Map(i.shown.movements) }
  const audit: AuditEntry[] = []
  const turnLog: TurnTiming[] = []
  const started = performance.now()
  const env = { today: i.today, now: i.now }

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    // Each call's time is cut to what is left of the message's deadline.
    const left = i.deadlineAt === undefined ? CALL_TIMEOUT_MS : i.deadlineAt - Date.now()
    if (left <= 0) throw new AgentError(`turn ${turn}: out of time`, audit, turn - 1, turnLog)
    const calledAt = performance.now()
    const response = await i.client.messages.create(
      { ...requestBase(i.model), max_tokens: 2048, messages },
      {
        timeout: Math.min(CALL_TIMEOUT_MS, left),
        maxRetries: 1,
        ...(i.signal ? { signal: i.signal } : {}),
      },
    )
    const timing: TurnTiming = {
      model_ms: Math.round(performance.now() - calledAt),
      find_ms: 0,
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cache_read: response.usage.cache_read_input_tokens ?? 0,
      cache_write: response.usage.cache_creation_input_tokens ?? 0,
      cache_write_1h: response.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      text_chars: response.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0),
    }
    turnLog.push(timing)

    // A refusal can cut a tool_use off mid-input: nothing of this response is read, and the model is not asked again.
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unknown'
      audit.push({ turn, tool: 'refusal', input: null, status: 'refusal', detail: category, ms: 0 })
      throw new AgentError(`turn ${turn}: refusal ${category}`, audit, turn, turnLog, category)
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AgentError(`turn ${turn}: cut off`, audit, turn, turnLog)
    }
    const uses = response.content.filter((b) => b.type === 'tool_use')
    if (uses.length === 0) {
      // The model wrote text instead of acting. Say so once and let it try again; its text is never sent to the person.
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

    // Layer 1, per call: the shape and the values. Reads run now.
    const checked: {
      use: (typeof uses)[number]
      verdict: Verdict
      entry: AuditEntry
      text: string
    }[] = []
    for (const use of uses) {
      const t0 = performance.now()
      const result = checkValues(use.name, use.input, env)
      let verdict: Verdict
      let text = ''
      if (result.kind === 'read') {
        const rows = await i.env.find(capFind(result.filter))
        timing.find_ms += Math.round(performance.now() - t0)
        for (const row of rows) found.set(row.id, row)
        verdict = { kind: 'read', rows }
        text = FOUND(rows)
      } else if (result.kind === 'rejected') {
        verdict = result
        text = result.message
      } else verdict = result
      const entry: AuditEntry = {
        turn,
        tool: use.name,
        input: use.input,
        status: verdict.kind === 'read' ? 'ok' : verdict.kind === 'ok' ? 'accepted' : verdict.kind,
        ms: Math.round(performance.now() - t0),
      }
      if (verdict.kind === 'rejected') entry.detail = verdict.message
      if (verdict.kind === 'declined') entry.detail = verdict.declined
      checked.push({ use, verdict, entry, text })
    }

    // Layer 2, over the whole turn: ids shown, facts in the person's words, the tools that go alone.
    const pending = checked.flatMap((c) =>
      c.verdict.kind === 'ok' ? [{ c, call: c.verdict.call }] : [],
    )
    const second = checkTurn(
      pending.map((p) => p.call),
      shown,
      i.message,
    )
    for (const [n, { c }] of pending.entries()) {
      const after = second[n]
      if (!after || after.kind === 'read') continue
      if (after.kind === 'rejected') {
        c.verdict = after
        c.text = after.message
        c.entry.status = 'rejected'
        c.entry.detail = after.message
      } else if (after.kind === 'declined') {
        c.verdict = after
        c.entry.status = 'declined'
        c.entry.detail = after.declined
      } else c.verdict = after
    }

    // A reply's words are vetted here, while the model can still write them again (the last turn is sent as it is: `compose` falls back).
    if (i.vet && turn < MAX_TURNS) {
      for (const { c, call } of pending) {
        if (call.tool !== 'reply' || c.verdict.kind !== 'ok') continue
        const why = i.vet(call.input.text, [...found.values()])
        if (why === null) continue
        const message = `text refused: ${why}. Write it again with only numbers that are in the lists, a find_movements result or the message (no count, no number in words), and no claim of a change.`
        c.verdict = { kind: 'rejected', message }
        c.text = message
        c.entry.status = 'rejected'
        c.entry.detail = message
      }
    }

    // Ids found in this turn may be acted on only from the next one: one that appears in a search of this very turn was guessed.
    for (const row of found.values())
      shown.movements = new Map(shown.movements).set(row.id, row.version)

    const refused = checked.some((c) => c.verdict.kind === 'rejected')
    const searched = checked.some((c) => c.verdict.kind === 'read')
    const calls: Call[] = []
    const declined: Declined[] = []
    for (const c of checked) {
      const { verdict } = c
      if (verdict.kind !== 'ok' && verdict.kind !== 'declined') {
        audit.push(c.entry)
        continue
      }
      // A turn that searches and also changes something is not run: the changes were written without the results.
      if (refused) c.entry.status = 'skipped'
      else if (searched) c.entry.status = 'held'
      else if (verdict.kind === 'ok') {
        c.entry.action = calls.length
        calls.push(verdict.call)
      } else declined.push(verdict.declined)
      audit.push(c.entry)
    }
    if (calls.length > 0 || declined.length > 0) {
      return {
        calls,
        declined,
        found: [...found.values()],
        audit,
        turns: turn,
        usage: sumUsage(turnLog),
        turnLog,
        ms: performance.now() - started,
      }
    }

    messages.push({ role: 'assistant', content: response.content })
    const results: Anthropic.ContentBlockParam[] = checked.map(({ use, verdict, text }) => ({
      type: 'tool_result' as const,
      tool_use_id: use.id,
      content:
        verdict.kind === 'read' || verdict.kind === 'rejected' ? text : refused ? REFUSED : HELD,
      is_error: verdict.kind !== 'read',
    }))
    // Nothing is held on a last turn that cannot be repeated, so say that it is the last.
    if (turn === MAX_TURNS - 1) results.push({ type: 'text', text: LAST_TURN })
    messages.push({ role: 'user', content: results })
  }
  throw new AgentError(`no valid action after ${MAX_TURNS} model turns`, audit, MAX_TURNS, turnLog)
}
