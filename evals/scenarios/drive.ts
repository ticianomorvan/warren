import type Anthropic from '@anthropic-ai/sdk'
import type { Sql } from '../../src/db'
import { estimateCostUsd, type ModelKey, type Usage } from '../../src/parse'
import { fakeGraph, messageBody, post, setup } from '../../src/test-harness'
import { gradeTurn, type Row, type TurnGrade } from './grade'
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
 * The real Anthropic client seen through the meter: every `messages.parse` is counted, and one that
 * would break the budget never starts. `calls` is this scenario's own list, so a turn's cost is the
 * calls made during it.
 */
export function meteredClient(
  real: Anthropic,
  meter: Meter,
  calls: CallRecord[],
  model: ModelKey,
): Anthropic {
  const parse = async (params: never, options?: never) => {
    meter.begin()
    let cost: number | null = null
    try {
      const response = await real.messages.parse(params, options)
      const usage: Usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      }
      cost = estimateCostUsd(model, usage)
      calls.push({ usage, costUsd: cost })
      return response
    } finally {
      meter.end(cost)
    }
  }
  return { messages: { parse } } as unknown as Anthropic
}

export type Action = 'log' | 'correct' | 'delete' | 'query' | 'ask' | 'other'

export interface TurnResult {
  text: string
  now: string
  reply: string
  grade: TurnGrade
  /** Post to reply recorded, in the process (fake Graph, in-process database). */
  wallMs: number
  /** Time inside `parseMessage`, as the pipeline stores it. */
  modelMs: number | null
  action: Action
  /** What the model returned (`parsed`), for the failure list. */
  parsed: unknown
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
}

const epoch = (now: string) => Date.parse(`${now}:00-03:00`)
/** One fake sender per scenario, so scenarios can run side by side in one database. */
export const waIdOf = (id: string) => `54911${id.slice(1).padStart(8, '0')}`

async function rowsOf(sql: Sql, waId: string): Promise<Row[]> {
  return sql<Row[]>`
    SELECT m.id::int AS id, m.amount::text AS amount, to_char(m.occurred_on, 'YYYY-MM-DD') AS date,
      m.description, m.category, m.payment, m.direction, m.currency,
      m.superseded_by::int AS "supersededBy", m.deleted_at IS NOT NULL AS deleted
    FROM movement m JOIN account a ON a.id = m.account_id
    WHERE a.wa_id = ${waId} ORDER BY m.id`
}

/** Puts the starting ledger in as if earlier messages had logged it, at the times the scenario gives. */
async function seedLedger(sql: Sql, s: Scenario, waId: string): Promise<Map<string, number>> {
  const refs = new Map<string, number>()
  if (s.seed.length === 0) return refs
  const [account] = await sql<{ id: number }[]>`
    INSERT INTO account (wa_id) VALUES (${waId})
    ON CONFLICT (wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id RETURNING id::int AS id`
  const [inbound] = await sql<{ id: number }[]>`
    INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status)
    VALUES (${`seed.${waId}`}, ${waId}, 'text', 'seed', '{}'::jsonb, 'done') RETURNING id::int AS id`
  for (const [position, m] of s.seed.entries()) {
    const loggedAt = new Date(epoch(`${m.loggedOn ?? m.on}T${m.at}`)).toISOString()
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency,
        occurred_on, description, category, payment, confidence, created_at)
      VALUES (${account?.id ?? 0}, ${inbound?.id ?? 0}, ${position}, ${m.direction}, ${m.amount},
        ${m.currency}, ${m.on}, ${m.description}, ${m.category}, ${m.payment}, 'high', ${loggedAt})
      RETURNING id::int AS id`
    refs.set(m.ref, row?.id ?? 0)
  }
  return refs
}

const actionOf = (commandType: string | null, reply: string): Action => {
  if (reply.trim().startsWith('¿')) return 'ask'
  return commandType === 'log' ||
    commandType === 'correct' ||
    commandType === 'delete' ||
    commandType === 'query'
    ? commandType
    : 'other'
}

/**
 * Plays one scenario through the real pipeline: webhook payload in, `createApp` and `createProcessor`
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
    fake: fakeGraph(),
    model: { client: meteredClient(env.client, env.meter, calls, env.model), calls: { n: 0 } },
    // Production's own limits: a model that is too slow ends in the failure notice here as there.
    interimMs: 10_000,
    deadlineMs: 30_000,
  })
  try {
    const refs = await seedLedger(env.sql, s, waId)
    let previous: { id: number; at: number } | null = null
    for (const [k, turn] of s.turns.entries()) {
      // The exchange window counts from `received_at`, which is the real clock: age the previous
      // message by the gap the scenario says passed between the two turns.
      if (previous) {
        const gap = Math.max(0, (epoch(turn.now) - previous.at) / 1000)
        await env.sql`UPDATE inbound_message SET received_at = now() - make_interval(secs => ${gap})
          WHERE id = ${previous.id}`
      }
      const before = await rowsOf(env.sql, waId)
      const wamid = `wamid.${s.id}.${k}`
      const callsBefore = calls.length
      const started = performance.now()
      await post(
        app.base,
        messageBody(wamid, waId, {
          timestamp: String(Math.floor(epoch(turn.now) / 1000)),
          text: { body: turn.text },
        }),
      )
      const stored = await waitFor(env.sql, wamid)
      const wallMs = performance.now() - started
      if (env.meter.exhausted)
        return { ...base, status: 'budget', turns, failedTurn: null, error: null }

      if (stored.command?.type === 'log') {
        // New movements are stamped with the clock of the turn, not the real one.
        await env.sql`UPDATE movement SET created_at = ${new Date(epoch(turn.now)).toISOString()}
          WHERE inbound_message_id = ${stored.id}`
      }
      const failed = stored.status !== 'done' || stored.reply_text === null
      const reply = stored.reply_text ?? app.calls.sent.at(-1)?.body ?? ''
      const after = await rowsOf(env.sql, waId)
      const grade = gradeTurn({
        turn,
        today: turn.now.slice(0, 10),
        before,
        after,
        refs,
        reply,
        failed,
        commandType: stored.command?.type ?? null,
      })
      refs.clear()
      for (const [ref, id] of grade.refs) refs.set(ref, id)
      turns.push({
        text: turn.text,
        now: turn.now,
        reply,
        grade,
        wallMs,
        modelMs: stored.model_ms,
        action: actionOf(stored.command?.type ?? null, reply),
        parsed: stored.parsed,
        costUsd: calls.slice(callsBefore).reduce((sum, c) => sum + c.costUsd, 0),
      })
      previous = { id: stored.id, at: epoch(turn.now) }
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
  reply_text: string | null
  command: { type: string } | null
  parsed: unknown
  model_ms: number | null
}

/** Waits until the message has left the processor: replied, failed or given up. */
async function waitFor(sql: Sql, wamid: string, timeoutMs = 60_000): Promise<Stored> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const [row] = await sql<Stored[]>`
      SELECT id::int AS id, status, reply_text, command, parsed, model_ms
      FROM inbound_message WHERE wamid = ${wamid}`
    if (row && ['done', 'failed', 'unknown', 'ignored'].includes(row.status)) return row
    if (Date.now() > end) throw new Error(`timed out waiting for ${wamid}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
