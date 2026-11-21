import { connect, type Sql } from '../../src/db'
import { argentinaTime, argentinaToday } from '../../src/time'

/**
 * Binding between eve and Warren's core. The core (ledger, movement, validate, render, time) is imported
 * from `src/` as it is; this file only finds the caller, the database and the clock.
 */

/** The ledger database: the core's own schema (`src/migrations`), on the throwaway local Postgres. */
let shared: Sql | undefined
export function ledger(): Sql {
  const url = process.env.WARREN_DATABASE_URL
  if (!url) throw new Error('WARREN_DATABASE_URL is not set (the throwaway local Postgres)')
  shared ??= connect(url, { max: 5 })
  return shared
}

/** The caller, as the channel authenticated it. Today an owner is a WhatsApp number (`wa_id`). */
export function callerOf(ctx: { session: { auth: { current: { principalId: string } | null } } }) {
  const principal = ctx.session.auth.current?.principalId
  if (!principal) throw new Error('no authenticated caller on this session')
  return principal
}

let spikeTables: Promise<unknown> | undefined
/** Spike-only tables: the eval's fake clock and the per-call model usage. Never part of the core. */
export function ensureSpikeTables(sql: Sql) {
  spikeTables ??=
    sql`CREATE TABLE IF NOT EXISTS spike_clock (wa_id text PRIMARY KEY, now text NOT NULL)`
      .then(
        () => sql`CREATE TABLE IF NOT EXISTS spike_usage (
        id bigserial PRIMARY KEY, wa_id text NOT NULL, turn_id text NOT NULL,
        input_tokens integer NOT NULL, output_tokens integer NOT NULL,
        cache_read_tokens integer NOT NULL, cache_write_tokens integer NOT NULL,
        at timestamptz NOT NULL DEFAULT now())`,
      )
      .then(
        () =>
          sql`CREATE TABLE IF NOT EXISTS spike_guard (
        id bigserial PRIMARY KEY, wa_id text NOT NULL, turn_id text NOT NULL, kind text NOT NULL,
        detail jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
      )
  return spikeTables
}

/**
 * The Argentine "now" of the message: `yyyy-mm-ddTHH:MM`. Production uses the message's own time; here
 * the eval sets it per sender in `spike_clock` (a test seam), and without it the wall clock is used.
 */
export async function nowOf(sql: Sql, waId: string): Promise<{ today: string; time: string }> {
  await ensureSpikeTables(sql)
  const [row] = await sql<{ now: string }[]>`SELECT now FROM spike_clock WHERE wa_id = ${waId}`
  if (row) return { today: row.now.slice(0, 10), time: row.now.slice(11, 16) }
  const now = new Date()
  return { today: argentinaToday(now), time: argentinaTime(now) }
}

export async function accountOf(sql: Sql, waId: string): Promise<number> {
  await sql`INSERT INTO account (wa_id) VALUES (${waId}) ON CONFLICT (wa_id) DO NOTHING`
  const [row] = await sql<{ id: number }[]>`SELECT id::int AS id FROM account WHERE wa_id = ${waId}`
  if (!row) throw new Error('account missing')
  return row.id
}

/**
 * The `inbound_message` row of this turn, created on first use: movements link to it, and the audit
 * lands on it (`tool_calls`). Keyed on the session and the turn, so a replayed step finds the same row.
 */
export async function turnRow(
  sql: Sql,
  o: { sessionId: string; turnId: string; waId: string },
): Promise<number> {
  const wamid = `eve.${o.sessionId}.${o.turnId}`
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status)
    VALUES (${wamid}, ${o.waId}, 'text', NULL, '{}'::jsonb, 'done')
    ON CONFLICT (wamid) DO UPDATE SET updated_at = now()
    RETURNING id::int AS id`
  if (!row) throw new Error('turn row missing')
  return row.id
}

/** One transaction on the ledger, with the cast `src/store.ts` makes for the core's `Sql` helpers. */
export const inTx = <T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> =>
  sql.begin((tx) => fn(tx as unknown as Sql)) as Promise<T>

/**
 * Serializes the writes of one turn. eve runs the tool calls of a step in parallel, each in its own
 * transaction, so two writes of one message would both take the next `position`. The lock is held to
 * the end of the transaction.
 */
export const lockTurn = (tx: Sql, inboundId: number) =>
  tx`SELECT pg_advisory_xact_lock(${inboundId})`
