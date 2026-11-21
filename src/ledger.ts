import type { Sql } from './db'
import { normalizeText } from './movement'
import type { Movement, RecentMovement } from './parse'
import type { DateRange } from './time'

/** How many live movements the model is shown. 10 is the most one message can log, so a whole message can always be addressed. */
export const RECENT_LIMIT = 10

/** A live movement as the parser and the reply see it, with the id code resolves a target to. */
export type MovementRow = RecentMovement & { id: number }

export interface QueryTotal {
  direction: Movement['direction']
  currency: Movement['currency']
  /** The SQL sum, as a decimal string. */
  total: string
  count: number
}

export interface QueryFilter {
  direction: Movement['direction'] | null
  category: Movement['category'] | null
  /** Matched loosely: case- and accent-insensitive, contained in the stored payment. */
  payment: string | null
  range: DateRange
}

/** Neither replaced by a correction nor deleted: the only movements that count. */
const LIVE = `superseded_by IS NULL AND deleted_at IS NULL`

const columns = (sql: Sql) => sql`
  id::int AS id, direction, amount::text AS amount, currency,
  to_char(occurred_on, 'YYYY-MM-DD') AS date, description, category, payment,
  to_char(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI') AS time`

/** The account's newest live movements, newest first. A corrected movement counts as new again. */
export function recentMovements(sql: Sql, accountId: number, limit = RECENT_LIMIT) {
  return sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    ORDER BY id DESC LIMIT ${limit}`
}

export async function insertMovements(
  sql: Sql,
  o: { accountId: number; inboundId: number; movements: Movement[] },
): Promise<number[]> {
  const values = o.movements.map((x, position) => ({
    account_id: o.accountId,
    inbound_message_id: o.inboundId,
    position,
    direction: x.direction,
    amount: x.amount,
    currency: x.currency,
    occurred_on: x.date,
    description: x.description.trim(),
    category: x.category,
    payment: x.payment?.trim() || null,
    confidence: x.confidence,
  }))
  const rows = await sql<
    { id: number }[]
  >`INSERT INTO movement ${sql(values)} RETURNING id::int AS id`
  return rows.map((r) => r.id)
}

/**
 * Takes a row lock on a movement that is still live. Null when it is not: a message that ran
 * meanwhile corrected or deleted it, and a second change must not apply to it.
 */
export async function lockLive(
  sql: Sql,
  accountId: number,
  id: number,
): Promise<MovementRow | null> {
  const [row] = await sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE id = ${id} AND account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    FOR UPDATE`
  return row ?? null
}

/** Inserts the corrected movement, linked to the correcting message, and points the old one at it. */
export async function supersede(
  sql: Sql,
  o: { accountId: number; inboundId: number; old: MovementRow; next: RecentMovement },
): Promise<void> {
  const [id] = await insertMovements(sql, {
    accountId: o.accountId,
    inboundId: o.inboundId,
    movements: [{ ...o.next, confidence: 'high' }],
  })
  // The correction keeps the time the movement was first logged: that is how the person tells it apart.
  await sql`
    UPDATE movement SET created_at = old.created_at
    FROM movement old WHERE movement.id = ${id ?? null} AND old.id = ${o.old.id}`
  await sql`UPDATE movement SET superseded_by = ${id ?? null} WHERE id = ${o.old.id}`
}

export async function softDelete(sql: Sql, id: number, inboundId: number): Promise<void> {
  await sql`UPDATE movement SET deleted_at = now(), deleted_by = ${inboundId} WHERE id = ${id}`
}

/** Totals per direction and currency, summed by the database. Currencies are never converted. */
export async function queryTotals(
  sql: Sql,
  accountId: number,
  f: QueryFilter,
): Promise<QueryTotal[]> {
  const needle = f.payment ? normalizeText(f.payment) : ''
  return sql<QueryTotal[]>`
    SELECT direction, currency, sum(amount)::text AS total, count(*)::int AS count
    FROM movement
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
      AND occurred_on BETWEEN ${f.range.from}::date AND ${f.range.to}::date
      ${f.direction ? sql`AND direction = ${f.direction}` : sql``}
      ${f.category ? sql`AND category = ${f.category}` : sql``}
      ${
        needle
          ? sql`AND position(${needle}::text IN lower(translate(coalesce(payment, ''),
              'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'))) > 0`
          : sql``
      }
    GROUP BY direction, currency
    ORDER BY direction DESC, currency`
}
