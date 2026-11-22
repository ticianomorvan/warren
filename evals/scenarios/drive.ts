import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Anthropic from '@anthropic-ai/sdk'
import { estimateCostUsd, type ModelKey, type Usage } from '../../src/agent/models'
import type { Sql } from '../../src/core/db'
import { nextOccurrence } from '../../src/domain/reminders/schedule'
import { fakeGraph, messageBody, photoBody, post, setup, voiceBody } from '../../src/test-harness'
import type { Timings } from '../../src/timings'
import type { Transcriber } from '../../src/transcribe'
import { accountFor } from '../../src/whatsapp/ingest'
import { gradeTurn, type LiveReminder, type Row, type TurnGrade, withoutHeard } from './grade'
import type { Scenario } from './schema'

/** Thrown inside the pipeline when the next model call could take the run over its budget. */
export class BudgetError extends Error {
  constructor() {
    super('budget reached')
  }
}

/** Spend across the whole run, shared by every scenario. */
export class Meter {
  spent = 0
  /** Calls that were allowed to start and have not finished: their cost is not in `spent` yet. */
  private inflight = 0
  /** The dearest call seen so far, to reserve room for the ones in flight. */
  private dearest = 0.001
  exhausted = false
  constructor(readonly cap: number) {}

  /** Claims room for one call, or throws when it might not fit. */
  begin(): void {
    if (this.spent + (this.inflight + 1) * this.dearest > this.cap) {
      this.exhausted = true
      throw new BudgetError()
    }
    this.inflight++
  }

  end(cost: number | null): void {
    this.inflight--
    if (cost !== null) {
      this.spent += cost
      this.dearest = Math.max(this.dearest, cost)
    }
  }
}

export interface CallRecord {
  usage: Usage
  costUsd: number
}

/**
 * The real Anthropic client seen through the meter: every `messages.create` is counted, and one that
 * would break the budget never starts. `calls` is this scenario's own list, so a turn's cost is the
 * calls made during it.
 */
export function meteredClient(
  real: Anthropic,
  meter: Meter,
  calls: CallRecord[],
  model: ModelKey,
): Anthropic {
  const create = async (params: never, options?: never) => {
    meter.begin()
    let cost: number | null = null
    try {
      const response = await real.messages.create(params, options)
      const usage: Usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheWrite1hTokens: response.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      }
      cost = estimateCostUsd(model, usage)
      calls.push({ usage, costUsd: cost })
      return response
    } finally {
      meter.end(cost)
    }
  }
  return { messages: { create } } as unknown as Anthropic
}

export type Action = 'log' | 'correct' | 'delete' | 'undo' | 'query' | 'ask' | 'multi' | 'other'

export interface TurnResult {
  text: string
  now: string
  reply: string
  grade: TurnGrade
  /** Post to reply recorded, in the process (fake Graph, in-process database). */
  wallMs: number
  /** Time inside the agent loop (model calls and reads), as the pipeline stores it. */
  modelMs: number | null
  /** Model calls the turn used. */
  modelTurns: number | null
  action: Action
  /** What the model asked for (`parsed`), for the failure list. */
  parsed: unknown
  /** The turn used more model calls than its scenario said it should (`maxModelTurns`). Not a failure. */
  overTurnCap: boolean
  /** The turn had a `maxModelTurns`. */
  capped: boolean
  /** Output tokens the model wrote this turn, over all its calls (null: no model call). */
  outputTokens: number | null
  /** What each call of the loop came to: turn, tool, status, and the refusal reason. Why a second model call happened. */
  audit: { turn: number; tool: string; status: string; detail?: string }[]
  /** Why the message failed (the failure notice's reason), if it did. */
  error: string | null
  costUsd: number
}

export interface ScenarioResult {
  id: string
  split: Scenario['split']
  tags: Scenario['tags']
  /** `budget`: the run stopped before this scenario could finish; it is not graded. */
  status: 'pass' | 'fail' | 'budget' | 'error'
  turns: TurnResult[]
  /** Index of the first turn that failed. */
  failedTurn: number | null
  error: string | null
}

export interface Env {
  sql: Sql
  client: Anthropic
  meter: Meter
  /** The model's key, only to price its calls. */
  model: ModelKey
  /** The real transcription service, for the scenarios that carry a voice note. */
  transcriber?: Transcriber
}

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const epoch = (now: string) => Date.parse(`${now}:00-03:00`)
/** One fake sender per scenario, so scenarios can run side by side in one database. */
export const waIdOf = (id: string) => `54911${id.slice(1).padStart(8, '0')}`

/** How many live facts the sender has: a fact is live until it is replaced or forgotten. */
async function liveFactsOf(sql: Sql, waId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM fact f JOIN account_address a ON a.account_id = f.account_id AND a.channel = 'whatsapp'
    WHERE a.address = ${waId} AND f.ended_at IS NULL`
  return row?.n ?? 0
}

/** The sender's live reminders, as the grader reads them. */
async function liveRemindersOf(sql: Sql, waId: string): Promise<LiveReminder[]> {
  return sql<LiveReminder[]>`
    SELECT r.what, r.schedule,
      to_char(r.next_due_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD"T"HH24:MI') AS first
    FROM reminder r JOIN account_address a ON a.account_id = r.account_id AND a.channel = 'whatsapp'
    WHERE a.address = ${waId} AND r.ended_at IS NULL AND r.next_due_at IS NOT NULL
    ORDER BY r.id`
}

/**
 * Every version of the sender's movements, as the grader's rows: a version that ended and has a newer version of the same entity is
 * `supersededBy` it (a correction, or an undo that brings an old value back), one that ended with no newer version is deleted.
 */
async function rowsOf(sql: Sql, waId: string): Promise<Row[]> {
  return sql<Row[]>`
    SELECT m.id::int AS id, m.amount::text AS amount, to_char(m.occurred_on, 'YYYY-MM-DD') AS date,
      m.description, m.category, m.payment, m.direction, m.currency,
      (SELECT n.id::int FROM movement n WHERE n.entity_id = m.entity_id AND n.id > m.id ORDER BY n.id LIMIT 1) AS "supersededBy",
      (m.ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM movement n WHERE n.entity_id = m.entity_id AND n.id > m.id)) AS deleted
    FROM movement m JOIN account_address a ON a.account_id = m.account_id AND a.channel = 'whatsapp'
    WHERE a.address = ${waId} ORDER BY m.id`
}

/** Puts the starting ledger in as if earlier messages had logged it, at the times the scenario gives (one seed turn a day before the first message). */
async function seedLedger(sql: Sql, s: Scenario, waId: string): Promise<Map<string, number>> {
  const refs = new Map<string, number>()
  if (s.seed.length === 0 && s.facts.length === 0 && s.reminders.length === 0) return refs
  const accountId = await accountFor(sql, waId)
  const first = epoch(s.turns[0]?.now ?? '')
  await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql
    const [turn] = await tx<{ id: number }[]>`
      INSERT INTO turn (account_id, channel, created_at, label, reply)
      VALUES (${accountId}, 'whatsapp', ${new Date(first - 86_400_000).toISOString()}, 'seed', 'seed') RETURNING id::int AS id`
    const madeIn = turn?.id ?? 0
    // The seeded ledger is not something the person did in this conversation: an undo has nothing of theirs to take back (as in v1,
    // where the seed was no batch). The seed turn is marked as already undone, without ending anything.
    await tx`INSERT INTO turn (account_id, channel, created_at, label, reply, undoes)
      VALUES (${accountId}, 'whatsapp', ${new Date(first - 86_400_000).toISOString()}, 'undo', 'seed', ${madeIn})`
    for (const f of s.facts) {
      await tx`INSERT INTO fact (account_id, made_in, kind, key, value, logged_at)
        VALUES (${accountId}, ${madeIn}, ${f.kind}, ${f.key}, ${f.value}, ${new Date(first - 86_400_000).toISOString()})`
    }
    for (const r of s.reminders) {
      // Its next date is the first occurrence after the scenario's first turn, as if it had been set a day before.
      const due = nextOccurrence(r.schedule, new Date(first))
      // A seed that is not live at the first turn would silently test nothing.
      if (!due)
        throw new Error(
          `${s.id}: the seeded reminder "${r.what}" has no occurrence after the first turn`,
        )
      await tx`INSERT INTO reminder (account_id, made_in, what, schedule, next_due_at, logged_at)
        VALUES (${accountId}, ${madeIn}, ${r.what}, ${tx.json(r.schedule)}, ${due}, ${new Date(first - 86_400_000).toISOString()})`
    }
    for (const m of s.seed) {
      const loggedAt = new Date(epoch(`${m.loggedOn ?? m.on}T${m.at}`)).toISOString()
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO movement (account_id, made_in, direction, amount, currency, occurred_on, description, category, payment, confidence, logged_at)
        VALUES (${accountId}, ${madeIn}, ${m.direction}, ${m.amount}, ${m.currency}, ${m.on}, ${m.description}, ${m.category},
          ${m.payment}, 'high', ${loggedAt})
        RETURNING id::int AS id`
      refs.set(m.ref, row?.id ?? 0)
    }
  })
  return refs
}

const actionOf = (action: string | null, reply: string): Action => {
  if (withoutHeard(reply).trim().startsWith('¿')) return 'ask'
  switch (action) {
    case 'log':
    case 'correct':
    case 'delete':
    case 'undo':
    case 'multi':
      return action
    case 'summarize':
      return 'query'
    default:
      return 'other'
  }
}

/**
 * Plays one scenario through the real pipeline: webhook payload in, `createWarren`
 * on a migrated database, the real model client behind `parseMessage`, a fake Graph. Turns run in
 * order, each one only after the previous reply is stored, as one sender's messages do in production.
 * It stops at the first turn that is not right: later turns would be graded on a ledger that already
 * went wrong.
 */
export async function runScenario(s: Scenario, env: Env): Promise<ScenarioResult> {
  const waId = waIdOf(s.id)
  const calls: CallRecord[] = []
  const base = { id: s.id, split: s.split, tags: s.tags }
  const turns: TurnResult[] = []
  const app = await setup({
    sql: env.sql,
    // A turn with an image or a voice note: the fake Graph serves the fixture under the media id the webhook names.
    fake: fakeGraph({
      media: Object.fromEntries(
        s.turns.flatMap((turn, k) => {
          const file = turn.image ?? turn.audio
          return file ? [[`media.${s.id}.${k}`, readFileSync(join(fixtures, file))]] : []
        }),
      ),
    }),
    transcriber: env.transcriber,
    model: {
      client: meteredClient(env.client, env.meter, calls, env.model),
      calls: { n: 0 },
      requests: [],
    },
    // Production's own limits: a model that is too slow ends in the failure notice here as there.
    interimMs: 10_000,
    deadlineMs: 30_000,
  })
  try {
    const refs = await seedLedger(env.sql, s, waId)
    for (const [k, turn] of s.turns.entries()) {
      const before = await rowsOf(env.sql, waId)
      const wamid = `wamid.${s.id}.${k}`
      const callsBefore = calls.length
      const started = performance.now()
      const timestamp = String(Math.floor(epoch(turn.now) / 1000))
      await post(
        app.base,
        turn.image
          ? photoBody(wamid, `media.${s.id}.${k}`, turn.text, waId, timestamp)
          : turn.audio
            ? voiceBody(wamid, `media.${s.id}.${k}`, waId, timestamp)
            : messageBody(wamid, waId, { timestamp, text: { body: turn.text } }),
      )
      const stored = await waitFor(env.sql, wamid)
      const wallMs = performance.now() - started
      if (env.meter.exhausted)
        return { ...base, status: 'budget', turns, failedTurn: null, error: null }

      const failed = stored.status !== 'done' || stored.reply === null
      const reply = stored.reply ?? app.calls.sent.at(-1)?.body ?? ''
      const after = await rowsOf(env.sql, waId)
      const grade = gradeTurn({
        turn,
        today: turn.now.slice(0, 10),
        before,
        after,
        refs,
        reply,
        failed,
        commandType: stored.calls?.some((c) => c.tool === 'summarize') ? 'query' : stored.action,
        liveFacts: await liveFactsOf(env.sql, waId),
        liveReminders: await liveRemindersOf(env.sql, waId),
      })
      refs.clear()
      for (const [ref, id] of grade.refs) refs.set(ref, id)
      turns.push({
        text: turn.text,
        now: turn.now,
        reply,
        grade,
        wallMs,
        modelMs: stored.timings?.model_ms ?? null,
        modelTurns: stored.timings?.turns?.length ?? null,
        action: actionOf(stored.action, reply),
        parsed: stored.calls,
        capped: turn.maxModelTurns !== undefined,
        overTurnCap:
          turn.maxModelTurns !== undefined &&
          (stored.timings?.turns?.length ?? 0) > turn.maxModelTurns,
        outputTokens: stored.timings?.turns?.length
          ? stored.timings.turns.reduce((n, t) => n + t.output, 0)
          : null,
        audit: (stored.audit ?? []).map(({ turn, tool, status, detail }) => ({
          turn,
          tool,
          status,
          ...(detail ? { detail: detail.slice(0, 160) } : {}),
        })),
        error: stored.error,
        costUsd: calls.slice(callsBefore).reduce((sum, c) => sum + c.costUsd, 0),
      })
      if (!grade.ok) return { ...base, status: 'fail', turns, failedTurn: k, error: null }
    }
    return { ...base, status: 'pass', turns, failedTurn: null, error: null }
  } catch (error) {
    if (env.meter.exhausted)
      return { ...base, status: 'budget', turns, failedTurn: null, error: null }
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error)
    return { ...base, status: 'error', turns, failedTurn: turns.length, error: message }
  } finally {
    app.close()
  }
}

interface Stored {
  id: number
  status: string
  /** What the person got: the turn's reply (a message that failed has none). */
  reply: string | null
  /** The turn's label (log, correct, delete, summarize, ...). */
  action: string | null
  /** The tool calls the turn ran. */
  calls: { tool: string }[] | null
  error: string | null
  timings: Timings | null
  audit: { turn: number; tool: string; status: string; detail?: string }[] | null
}

/** Waits until the message has left the worker: replied, failed or given up. */
async function waitFor(sql: Sql, wamid: string, timeoutMs = 60_000): Promise<Stored> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const [row] = await sql<Stored[]>`
      SELECT m.id::int AS id, m.status, t.reply, t.label AS action, t.calls, m.error, m.timings, m.audit
      FROM wa_message m LEFT JOIN turn t ON t.id = m.turn_id WHERE m.wamid = ${wamid}`
    if (row && ['done', 'failed', 'unknown', 'ignored'].includes(row.status)) return row
    if (Date.now() > end) throw new Error(`timed out waiting for ${wamid}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
