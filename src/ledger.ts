import { MAX_FOUND, type Movement, type RecentMovement } from './agent/schema'
import type { Sql } from './db'
import { normalizeText } from './movement'
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
  /** Words of the description, every one contained in it (accents and case ignored). */
  description: string | null
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
  o: {
    accountId: number
    inboundId: number
    movements: Movement[]
    /** The position of the first one in its message: a message may log, correct and log again. */
    firstPosition?: number
  },
): Promise<number[]> {
  const first = o.firstPosition ?? 0
  const values = o.movements.map((x, k) => ({
    account_id: o.accountId,
    inbound_message_id: o.inboundId,
    position: first + k,
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

/** The live movements among these ids that belong to the account, newest first. */
export function liveByIds(sql: Sql, accountId: number, ids: number[]) {
  return sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE account_id = ${accountId} AND id = ANY(${ids}::bigint[]) AND ${sql.unsafe(LIVE)}
    ORDER BY id DESC`
}

/** Inserts the corrected movement, linked to the correcting message, and points the old one at it. */
export async function supersede(
  sql: Sql,
  o: {
    accountId: number
    inboundId: number
    old: MovementRow
    next: RecentMovement
    position: number
  },
): Promise<void> {
  const [id] = await insertMovements(sql, {
    accountId: o.accountId,
    inboundId: o.inboundId,
    firstPosition: o.position,
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

/** The id of the account's newest live movement, or null when it has none. */
export async function newestLiveId(sql: Sql, accountId: number): Promise<number | null> {
  const [row] = await sql<{ id: number | null }[]>`
    SELECT max(id)::int AS id FROM movement WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}`
  return row?.id ?? null
}

export interface FindFilter {
  /** Words of the description or the category, all of them, accents and case ignored. */
  text: string | null
  from: string | null
  to: string | null
  category: Movement['category'] | null
  /** Matched loosely, like a query's payment filter. */
  payment: string | null
  amount: string | null
  limit: number
}

const ACCENTS = ["'áéíóúüñÁÉÍÓÚÜÑ'", "'aeiouunAEIOUUN'"] as const
const folded = (column: string) =>
  `lower(translate(coalesce(${column}, ''), ${ACCENTS[0]}, ${ACCENTS[1]}))`

/** The account's live movements that match every filter set, newest first, at most `MAX_FOUND`. */
export function findMovements(sql: Sql, accountId: number, f: FindFilter) {
  const words = normalizeText(f.text ?? '')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  const like = (w: string) => `%${w.replace(/[\\%_]/g, '\\$&')}%`
  const payment = f.payment ? normalizeText(f.payment) : ''
  return sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
      ${f.from ? sql`AND occurred_on >= ${f.from}::date` : sql``}
      ${f.to ? sql`AND occurred_on <= ${f.to}::date` : sql``}
      ${f.category ? sql`AND category = ${f.category}` : sql``}
      ${f.amount ? sql`AND amount = ${f.amount}::numeric` : sql``}
      ${payment ? sql`AND position(${payment}::text IN ${sql.unsafe(folded('payment'))}) > 0` : sql``}
      ${
        words.length > 0
          ? sql`AND ${sql.unsafe(folded("description || ' ' || replace(category, '_', ' ')"))} LIKE ALL (${words.map(like)}::text[])`
          : sql``
      }
    ORDER BY id DESC LIMIT ${Math.min(Math.max(f.limit, 1), MAX_FOUND)}`
}

/** Totals per direction and currency, summed by the database. Currencies are never converted. */
export async function queryTotals(
  sql: Sql,
  accountId: number,
  f: QueryFilter,
): Promise<QueryTotal[]> {
  const needle = f.payment ? normalizeText(f.payment) : ''
  const words = normalizeText(f.description ?? '')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  const like = (w: string) => `%${w.replace(/[\\%_]/g, '\\$&')}%`
  return sql<QueryTotal[]>`
    SELECT direction, currency, sum(amount)::text AS total, count(*)::int AS count
    FROM movement
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
      AND occurred_on BETWEEN ${f.range.from}::date AND ${f.range.to}::date
      ${f.direction ? sql`AND direction = ${f.direction}` : sql``}
      ${f.category ? sql`AND category = ${f.category}` : sql``}
      ${
        words.length > 0
          ? sql`AND ${sql.unsafe(folded('description'))} LIKE ALL (${words.map(like)}::text[])`
          : sql``
      }
      ${
        needle
          ? sql`AND position(${needle}::text IN lower(translate(coalesce(payment, ''),
              'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'))) > 0`
          : sql``
      }
    GROUP BY direction, currency
    ORDER BY direction DESC, currency`
}
