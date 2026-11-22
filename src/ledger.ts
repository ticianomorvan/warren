import {
  type GroupBy,
  isTimeGroup,
  MAX_FOUND,
  type Movement,
  type RecentMovement,
} from './agent/schema'
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

// ---- Undo (agent slice C). A write batch is the inbound message that made the changes; what it did to each
// ---- movement is in the rows themselves. Nothing here updates a row's values, deletes a row or clears a mark.

/** The sender's newest write batch that is not undone, and how long before the asking message it was made. */
export interface LastBatch {
  id: number
  ageSecs: number
}

/**
 * The newest batch of the account before the message `inboundId` (the one asking to undo): a committed
 * message from the sender that inserted or deleted a movement of the account, that is not itself an undo
 * and that no undo reverted. An undone batch is skipped, so a second "deshacer" reaches the one before.
 */
export async function lastBatch(
  sql: Sql,
  o: { accountId: number; inboundId: number },
): Promise<LastBatch | null> {
  const [row] = await sql<LastBatch[]>`
    SELECT i.id::int AS id, extract(epoch FROM cur.received_at - i.received_at)::float8 AS "ageSecs"
    FROM inbound_message cur
    JOIN account a ON a.id = ${o.accountId}
    JOIN inbound_message i ON i.wa_id = a.wa_id AND i.id < cur.id
    WHERE cur.id = ${o.inboundId}
      AND i.action IS NOT NULL AND i.reply_text IS NOT NULL AND i.undoes IS NULL
      AND (EXISTS (SELECT 1 FROM movement m WHERE m.inbound_message_id = i.id AND m.account_id = a.id)
        OR EXISTS (SELECT 1 FROM movement m WHERE m.deleted_by = i.id AND m.account_id = a.id))
      AND NOT EXISTS (SELECT 1 FROM inbound_message u WHERE u.undoes = i.id)
    ORDER BY i.id DESC LIMIT 1`
  return row ?? null
}

/** A movement row of a batch, in any state, with how the batch touched it. */
export interface BatchRow extends MovementRow {
  /** The message that inserted the row. */
  inbound: number
  /** The message that deleted it, if one did. */
  deletedBy: number | null
  /** The row a correction of this batch replaced; null when the row was logged. */
  predecessor: number | null
}

/** Every row the batch inserted (a log, or a correction's new row) or deleted, of this account, oldest first. */
export function batchRows(sql: Sql, accountId: number, batch: number) {
  return sql<BatchRow[]>`
    SELECT ${columns(sql)}, inbound_message_id::int AS inbound, deleted_by::int AS "deletedBy",
      (SELECT p.id::int FROM movement p WHERE p.superseded_by = movement.id) AS predecessor
    FROM movement
    WHERE account_id = ${accountId} AND (inbound_message_id = ${batch} OR deleted_by = ${batch})
    ORDER BY id`
}

/** Rows by id, in any state, only the account's. */
export function rowsByIds(sql: Sql, accountId: number, ids: number[]) {
  return sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE account_id = ${accountId} AND id = ANY(${ids}::bigint[]) ORDER BY id`
}

/** Row locks on these rows whatever their state, in id order. A change that needs one of them waits for the commit. */
export async function lockRows(sql: Sql, accountId: number, ids: number[]): Promise<void> {
  await sql`
    SELECT id FROM movement
    WHERE account_id = ${accountId} AND id = ANY(${ids}::bigint[]) ORDER BY id FOR UPDATE`
}

/** One row of a movement's history, after the row it started from. */
export interface Link {
  root: number
  /** 0 is the root itself. */
  hop: number
  id: number
  /** The message that inserted this row. */
  madeIn: number
  live: boolean
}

/**
 * Follows each root forward through what came after it: the row that replaced it, or the row that restored it
 * after a delete. The last link of a root is where the movement stands now.
 */
export function followForward(sql: Sql, accountId: number, roots: number[]) {
  return sql<Link[]>`
    WITH RECURSIVE walk(root, id, hop) AS (
        SELECT id, id, 0 FROM movement WHERE account_id = ${accountId} AND id = ANY(${roots}::bigint[])
      UNION ALL
        SELECT w.root, nxt.id, w.hop + 1
        FROM walk w
        JOIN movement cur ON cur.id = w.id
        JOIN movement nxt ON nxt.account_id = ${accountId}
          AND (nxt.id = cur.superseded_by OR nxt.restores = cur.id)
        WHERE w.hop < 50)
    SELECT w.root::int AS root, w.hop::int AS hop, m.id::int AS id,
      m.inbound_message_id::int AS "madeIn",
      (m.superseded_by IS NULL AND m.deleted_at IS NULL) AS live
    FROM walk w JOIN movement m ON m.id = w.id
    ORDER BY w.root, w.hop`
}

/** Which of these messages are undone, or are themselves an undo: changes they made were reversed or are the reversal. */
export async function settledBatches(sql: Sql, ids: number[]): Promise<Set<number>> {
  const rows = await sql<{ id: number }[]>`
    SELECT i.id::int AS id FROM inbound_message i
    WHERE i.id = ANY(${ids}::bigint[])
      AND (i.undoes IS NOT NULL OR EXISTS (SELECT 1 FROM inbound_message u WHERE u.undoes = i.id))`
  return new Set(rows.map((r) => r.id))
}

/**
 * Inserts a new row with the values of `from` (the row an undo brings back), dated as it was first logged.
 * `restoresIt` links it to a deleted row it replaces; a correction's restore instead supersedes the row it
 * undoes (`replaces`). The source row is never touched, and the new row is live.
 */
export async function copyVersion(
  sql: Sql,
  o: {
    accountId: number
    inboundId: number
    position: number
    from: number
    restoresIt?: boolean
    replaces?: number
  },
): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency,
      occurred_on, description, category, payment, confidence, created_at, restores)
    SELECT account_id, ${o.inboundId}, ${o.position}, direction, amount, currency, occurred_on,
      description, category, payment, confidence, created_at, ${o.restoresIt ? sql`id` : sql`NULL::bigint`}
    FROM movement WHERE id = ${o.from} AND account_id = ${o.accountId}
    RETURNING id::int AS id`
  const id = row?.id
  if (id === undefined) throw new Error(`undo: movement ${o.from} is not the account's`)
  if (o.replaces !== undefined) {
    await sql`UPDATE movement SET superseded_by = ${id} WHERE id = ${o.replaces}`
  }
  return id
}

/** Marks the message as the undo of `batch`. One undo per batch: the unique index refuses a second. */
export async function markUndone(sql: Sql, inboundId: number, batch: number): Promise<void> {
  await sql`UPDATE inbound_message SET undoes = ${batch} WHERE id = ${inboundId}`
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

/** One total of a summary: a direction, a currency and, when grouped, one group of it. Currencies and directions are never mixed. */
export interface GroupTotal extends QueryTotal {
  /** The group: a category, a folded payment ('' for none), a day (yyyy-mm-dd), the Monday of a week or a month (yyyy-mm). '' when not grouped. */
  key: string
  /** A payment as it was written; null for every other group. */
  label: string | null
}

/**
 * The SQL expression of each group. A payment is grouped without regard to case or accents ("Visa", "visa" and
 * "VISA" are one) and shown as written; a week is its Monday. Dates are cast to `timestamp` first: `date_trunc`
 * on a `date` would go through the session time zone.
 */
const GROUP_SQL: Record<Exclude<GroupBy, 'none'>, string> = {
  category: 'category',
  payment: folded("btrim(coalesce(payment, ''))"),
  day: `to_char(occurred_on, 'YYYY-MM-DD')`,
  week: `to_char(date_trunc('week', occurred_on::timestamp), 'YYYY-MM-DD')`,
  month: `to_char(date_trunc('month', occurred_on::timestamp), 'YYYY-MM')`,
}

/** The movements of a summary: live ones of the account, in the range, that pass every filter. */
function matching(sql: Sql, accountId: number, f: QueryFilter) {
  const needle = f.payment ? normalizeText(f.payment) : ''
  const words = normalizeText(f.description ?? '')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  const like = (w: string) => `%${w.replace(/[\\%_]/g, '\\$&')}%`
  return sql`
    account_id = ${accountId} AND ${sql.unsafe(LIVE)}
      AND occurred_on BETWEEN ${f.range.from}::date AND ${f.range.to}::date
      ${f.direction ? sql`AND direction = ${f.direction}` : sql``}
      ${f.category ? sql`AND category = ${f.category}` : sql``}
      ${
        words.length > 0
          ? sql`AND ${sql.unsafe(folded('description'))} LIKE ALL (${words.map(like)}::text[])`
          : sql``
      }
      ${needle ? sql`AND position(${needle}::text IN ${sql.unsafe(folded('payment'))}) > 0` : sql``}`
}

/** Totals per direction and currency, summed by the database. Currencies are never converted. */
export async function queryTotals(
  sql: Sql,
  accountId: number,
  f: QueryFilter,
): Promise<QueryTotal[]> {
  return sql<QueryTotal[]>`
    SELECT direction, currency, sum(amount)::text AS total, count(*)::int AS count
    FROM movement WHERE ${matching(sql, accountId, f)}
    GROUP BY direction, currency
    ORDER BY direction DESC, currency`
}

/**
 * Totals per direction and currency and, when `by` is not `none`, per group within them. Out before in, a
 * currency at a time; the groups of what was bought or paid come biggest first, the groups of time oldest first.
 */
export async function queryGroups(
  sql: Sql,
  accountId: number,
  f: QueryFilter,
  by: Exclude<GroupBy, 'none'>,
): Promise<GroupTotal[]> {
  const key = sql.unsafe(GROUP_SQL[by])
  return sql<GroupTotal[]>`
    SELECT direction, currency, ${key} AS key,
      ${by === 'payment' ? sql`coalesce(min(nullif(btrim(payment), '')), '')` : sql`NULL::text`} AS label,
      sum(amount)::text AS total, count(*)::int AS count
    FROM movement WHERE ${matching(sql, accountId, f)}
    GROUP BY direction, currency, ${key}
    ORDER BY direction DESC, currency, ${isTimeGroup(by) ? sql`${key}` : sql`sum(amount) DESC, ${key}`}`
}

/** What a summary shows of one range: the totals of each direction and currency and, when grouped, the groups under them. */
export interface SummaryRows {
  totals: QueryTotal[]
  groups: GroupTotal[]
}

/** The totals and the groups of one range, both summed by the database over the same filter. */
export async function summaryRows(
  sql: Sql,
  accountId: number,
  f: QueryFilter,
  by: GroupBy,
): Promise<SummaryRows> {
  return {
    totals: await queryTotals(sql, accountId, f),
    groups: by === 'none' ? [] : await queryGroups(sql, accountId, f, by),
  }
}
