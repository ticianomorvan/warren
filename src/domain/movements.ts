import type { Category, Changes } from '../core/commands'
import type { Sql } from '../core/db'
import { tokens } from '../core/numbers'
import { canonicalAmount, normalizeText } from '../core/values'

/** How many live movements the model is shown. 10 is the most one message can log, so a whole message can always be addressed. */
export const RECENT_LIMIT = 10

/**
 * A live movement as the parser and the reply see it. `id` is the entity id: the same across every version of the movement,
 * and the one the model and MCP clients see. `version` is the row of the version, which only the history reads.
 */
export interface MovementRow {
  id: number
  version: number
  direction: 'in' | 'out'
  /** A decimal string. */
  amount: string
  currency: 'ARS' | 'USD'
  /** yyyy-mm-dd, the Argentine day. */
  date: string
  description: string
  category: Category
  payment: string | null
  confidence: 'high' | 'low'
  /** When the entity was first logged, Argentine HH:MM: tells apart movements of the same day. */
  time: string
  /** When the entity was first logged. A correction passes it on to the new version. */
  loggedAt: Date
}

const columns = (sql: Sql) => sql`
  entity_id::int AS id, id::int AS version, direction, amount::text AS amount, currency,
  to_char(occurred_on, 'YYYY-MM-DD') AS date, description, category, payment, confidence,
  to_char(logged_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI') AS time,
  logged_at AS "loggedAt"`

/** The account's newest live movements, newest first. A corrected movement counts as new again (its version is the newest row). */
export function recentMovements(sql: Sql, accountId: number, limit = RECENT_LIMIT) {
  return sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE account_id = ${accountId} AND ended_at IS NULL
    ORDER BY movement.id DESC LIMIT ${limit}`
}

/** The entity id of the account's newest live movement, or null when it has none. */
export async function newestLiveId(sql: Sql, accountId: number): Promise<number | null> {
  const [row] = await sql<{ id: number | null }[]>`
    SELECT entity_id::int AS id FROM movement
    WHERE account_id = ${accountId} AND ended_at IS NULL ORDER BY movement.id DESC LIMIT 1`
  return row?.id ?? null
}

/** The movements of a turn as new entities (a log), or as the next version of one (`entityId`, a correction or a restore). */
export async function insertMovements(
  sql: Sql,
  o: {
    accountId: number
    turnId: number
    /** The instant of the message: when a new entity is first logged. */
    now: Date
    movements: NewMovement[]
    /** Set for a new version of an entity: it keeps the entity's id and the time it was first logged. */
    version?: { entityId: number; loggedAt: Date }
  },
): Promise<MovementRow[]> {
  const rows = o.movements.map((x) => ({
    account_id: o.accountId,
    made_in: o.turnId,
    ...(o.version ? { entity_id: o.version.entityId } : {}),
    logged_at: o.version?.loggedAt ?? o.now,
    direction: x.direction,
    amount: x.amount,
    currency: x.currency,
    occurred_on: x.date,
    description: x.description.trim(),
    category: x.category,
    payment: x.payment?.trim() || null,
    confidence: x.confidence,
  }))
  return sql<MovementRow[]>`INSERT INTO movement ${sql(rows)} RETURNING ${columns(sql)}`
}

/**
 * A row lock on the account's live movement of this entity. Null when it is not: another turn corrected or deleted it, and a
 * second change must not apply to it. (A write transaction holds the account lock already; the row lock is the second layer.)
 */
export async function lockLive(
  sql: Sql,
  accountId: number,
  entityId: number,
): Promise<MovementRow | null> {
  const [row] = await sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE entity_id = ${entityId} AND account_id = ${accountId} AND ended_at IS NULL
    FOR UPDATE`
  return row ?? null
}

/** The live movements among these entities that belong to the account, newest first. */
export function liveByIds(sql: Sql, accountId: number, ids: number[]) {
  return sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE account_id = ${accountId} AND entity_id = ANY(${ids}::bigint[]) AND ended_at IS NULL
    ORDER BY movement.id DESC`
}

/** Ends a version in a turn. Never removes the row; false when it was not live. */
export async function endVersion(sql: Sql, version: number, turnId: number): Promise<boolean> {
  const ended = await sql`
    UPDATE movement SET ended_in = ${turnId}, ended_at = now()
    WHERE id = ${version} AND ended_at IS NULL RETURNING id`
  return ended.length > 0
}

/** The next version of an entity: the old one is ended in the turn and a new one with the same entity id takes its place. */
export async function supersede(
  sql: Sql,
  o: { accountId: number; turnId: number; now: Date; old: MovementRow; next: ValuesOf },
): Promise<MovementRow> {
  await endVersion(sql, o.old.version, o.turnId)
  const [row] = await insertMovements(sql, {
    accountId: o.accountId,
    turnId: o.turnId,
    now: o.now,
    movements: [{ ...o.next, confidence: 'high' }],
    version: { entityId: o.old.id, loggedAt: o.old.loggedAt },
  })
  return row as MovementRow
}

/** What a movement holds besides who and when: the values a correction changes. */
export interface ValuesOf {
  direction: 'in' | 'out'
  amount: string
  currency: 'ARS' | 'USD'
  date: string
  description: string
  category: Category
  payment?: string | null | undefined
}
export type NewMovement = ValuesOf & { confidence: 'high' | 'low' }

/** The values a correction leaves unset keep the old row's. Blank values never get here: the value guards reject them. */
export function applyChanges(old: ValuesOf, changes: Changes): ValuesOf {
  return {
    direction: changes.direction ?? old.direction,
    amount: changes.amount ?? old.amount,
    currency: changes.currency ?? old.currency,
    date: changes.date ?? old.date,
    description: changes.description?.trim() ?? old.description,
    category: changes.category ?? old.category,
    payment: changes.payment?.trim() ?? old.payment,
  }
}

export type ChangedField = 'money' | 'date' | 'description' | 'category' | 'payment'

/** Which fields a correction actually changes. Direction, currency and amount count as one: the money. */
export function changedFields(before: ValuesOf, after: ValuesOf): ChangedField[] {
  const changed: ChangedField[] = []
  if (
    before.direction !== after.direction ||
    before.currency !== after.currency ||
    canonicalAmount(before.amount) !== canonicalAmount(after.amount)
  ) {
    changed.push('money')
  }
  if (before.date !== after.date) changed.push('date')
  if (before.description.trim() !== after.description.trim()) changed.push('description')
  if (before.category !== after.category) changed.push('category')
  if ((before.payment?.trim() || null) !== (after.payment?.trim() || null)) changed.push('payment')
  return changed
}

export interface FindFilter {
  /** Words of the description or the category, all of them, accents and case ignored. */
  text: string | null
  from: string | null
  to: string | null
  category: Category | null
  /** Matched loosely: case- and accent-insensitive, contained in the stored payment. */
  payment: string | null
  amount: string | null
  limit: number
}

const ACCENTS = ["'áéíóúüñÁÉÍÓÚÜÑ'", "'aeiouunAEIOUUN'"] as const
/** The fold of the `search` column, for the payment (which has no column of its own). */
const foldedPayment = `lower(translate(coalesce(payment, ''), ${ACCENTS[0]}, ${ACCENTS[1]}))`

/**
 * The account's live movements that match every filter set, newest first, `limit` of them (the caller caps it: the turn check
 * for WhatsApp's model, the page size for MCP) and, for a next page, only those whose version is below `beforeVersion`. The words
 * match the `search` column (description and category, folded); the ranking is v1's: newest first, nothing else.
 */
export function findMovements(
  sql: Sql,
  accountId: number,
  f: FindFilter,
  o: { beforeVersion?: number } = {},
) {
  const words = normalizeText(f.text ?? '')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  const like = (w: string) => `%${w.replace(/[\\%_]/g, '\\$&')}%`
  const payment = f.payment ? normalizeText(f.payment) : ''
  return sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE account_id = ${accountId} AND ended_at IS NULL
      ${o.beforeVersion ? sql`AND id < ${o.beforeVersion}` : sql``}
      ${f.from ? sql`AND occurred_on >= ${f.from}::date` : sql``}
      ${f.to ? sql`AND occurred_on <= ${f.to}::date` : sql``}
      ${f.category ? sql`AND category = ${f.category}` : sql``}
      ${f.amount ? sql`AND amount = ${f.amount}::numeric` : sql``}
      ${payment ? sql`AND position(${payment}::text IN ${sql.unsafe(foldedPayment)}) > 0` : sql``}
      ${words.length > 0 ? sql`AND search LIKE ALL (${words.map(like)}::text[])` : sql``}
    ORDER BY movement.id DESC LIMIT ${Math.max(f.limit, 1)}`
}

/** At most this many older movements are added to the context for a message. */
export const MENTIONED_LIMIT = 8

/**
 * The older live movements a message names: those beyond the `RECENT_LIMIT` newest (the model already sees those) that have a word of
 * 4 or more letters of the message at the start of a word of their `search` column (description and category, folded), or an
 * amount the message writes. Newest first, `limit` of them, as `findMovements` ranks. It only retrieves: the model still picks the id.
 */
export function mentionedMovements(
  sql: Sql,
  accountId: number,
  message: string,
  limit = MENTIONED_LIMIT,
) {
  const folded = normalizeText(message)
  const words = [
    ...new Set(folded.split(/[^a-z0-9]+/).filter((w) => /[a-z]/.test(w) && w.length >= 4)),
  ]
  // The amounts the message writes, read as the numbers check reads them (a full stop or comma after "3500." is not part of it).
  const amounts = [
    ...new Set(tokens(folded).flatMap((t) => (t.needs.startsWith('n:') ? [t.needs.slice(2)] : []))),
  ].filter((n) => /^\d+(\.\d{1,2})?$/.test(n) && Number(n) > 0)
  if (words.length === 0 && amounts.length === 0) return Promise.resolve([] as MovementRow[])
  const like = (w: string) => `% ${w.replace(/[\\%_]/g, '\\$&')}%`
  return sql<MovementRow[]>`
    SELECT ${columns(sql)} FROM movement
    WHERE account_id = ${accountId} AND ended_at IS NULL
      AND entity_id NOT IN (
        SELECT entity_id FROM movement WHERE account_id = ${accountId} AND ended_at IS NULL
        ORDER BY id DESC LIMIT ${RECENT_LIMIT})
      AND (${words.length > 0 ? sql`(' ' || search) LIKE ANY (${words.map(like)}::text[])` : sql`false`}
        OR ${amounts.length > 0 ? sql`amount = ANY (${amounts}::numeric[])` : sql`false`})
    ORDER BY movement.id DESC LIMIT ${limit}`
}
