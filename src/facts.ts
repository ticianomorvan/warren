import {
  CONTEXT_FACTS,
  MAX_FACTS,
  MAX_MATCHED_FACTS,
  normalizeKey,
  sameValue,
} from './agent/memory'
import type { FactKind } from './agent/schema'
import type { Sql } from './db'

/** A live fact as the model, the record and the list see it. */
export interface FactRow {
  id: number
  kind: FactKind
  /** Normalized: lowercase, no accents, single spaces. */
  key: string
  value: string
}

/**
 * Everything on the `fact` table. Append-only like the ledger: a fact is stored, replaced by a new row (`superseded_by`),
 * or forgotten (`forgotten_at`, `forgotten_by`); no row's key or value is ever edited, and no row is removed or
 * un-forgotten (an undo inserts a new row that `restores` the forgotten one).
 */

/** Neither replaced by a newer value nor forgotten: the only facts that count. */
const LIVE = `superseded_by IS NULL AND forgotten_at IS NULL`

const columns = (sql: Sql) => sql`id::int AS id, kind, key, value`

/**
 * The facts the model is shown with a message: the newest `limit`, and, so that an old alias still works, every other live
 * fact whose key the message says (at most `MAX_MATCHED_FACTS`), newest first; and how many live facts the account has in all.
 */
export async function liveFacts(
  sql: Sql,
  accountId: number,
  message = '',
  limit = CONTEXT_FACTS,
): Promise<{ facts: FactRow[]; total: number }> {
  const newest = await sql<(FactRow & { total: number })[]>`
    SELECT ${columns(sql)}, count(*) OVER ()::int AS total FROM fact
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    ORDER BY id DESC LIMIT ${limit}`
  const total = newest[0]?.total ?? 0
  const said = normalizeKey(message)
  if (said === '' || total <= newest.length) return { facts: newest, total }
  // A key counts when the message has it from the start of a word ("cafe" in "cafes").
  const named = await sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)} AND id <> ALL(${newest.map((f) => f.id)}::bigint[])
      AND strpos(${` ${said}`}, ' ' || key) > 0
    ORDER BY id DESC LIMIT ${MAX_MATCHED_FACTS}`
  return { facts: [...newest, ...named].sort((a, b) => b.id - a.id), total }
}

/** Every live fact of the account, by kind and key: what "¿qué sabés de mí?" lists. */
export function allLiveFacts(sql: Sql, accountId: number) {
  return sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    ORDER BY kind, key`
}

/**
 * One writer at a time per account over its facts: the cap and the one-live-fact-per-key rule are checked after
 * this, so two messages cannot both pass them (the unique index is the second layer).
 */
export async function lockFacts(sql: Sql, accountId: number): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(7203003, ${accountId}::int)`
}

/** Which live facts of the account to find: by id, by kind and key, or by key alone. */
export interface LiveFilter {
  id?: number
  kind?: FactKind
  key?: string
}

/**
 * The account's live facts that match the filter, oldest first, only ever the account's. `lock` takes a row lock on
 * them, so a message that changes one waits for this one's commit. The one query behind every lookup of a live fact.
 */
export function findLive(sql: Sql, accountId: number, f: LiveFilter, o: { lock?: boolean } = {}) {
  return sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
      ${f.id === undefined ? sql`` : sql`AND id = ${f.id}`}
      ${f.kind === undefined ? sql`` : sql`AND kind = ${f.kind}`}
      ${f.key === undefined ? sql`` : sql`AND key = ${f.key}`}
    ORDER BY id ${o.lock ? sql`FOR UPDATE` : sql``}`
}

const countLive = async (sql: Sql, accountId: number): Promise<number> => {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM fact WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}`
  return row?.n ?? 0
}

interface NewFact {
  accountId: number
  inboundId: number
  kind: FactKind
  key: string
  value: string
}

async function insertFact(
  sql: Sql,
  o: NewFact & { id?: number; restores?: number },
): Promise<FactRow> {
  const [row] = await sql<FactRow[]>`
    INSERT INTO fact (id, account_id, kind, key, value, inbound_message_id, restores)
    VALUES (${o.id === undefined ? sql`DEFAULT` : o.id}, ${o.accountId}, ${o.kind}, ${o.key}, ${o.value}, ${o.inboundId}, ${o.restores ?? null})
    RETURNING ${columns(sql)}`
  return row as FactRow
}

/**
 * Replaces a live fact with a new row holding another value. The old row is pointed at the new one first (its id
 * is taken from the sequence beforehand, and the key is deferred), so at no statement do two rows of one key stand live.
 */
export async function supersedeFact(sql: Sql, o: NewFact & { old: FactRow }): Promise<FactRow> {
  const [next] = await sql<{ id: number }[]>`
    SELECT nextval(pg_get_serial_sequence('fact', 'id'))::int AS id`
  const id = next?.id as number
  const replaced = await sql`
    UPDATE fact SET superseded_by = ${id} WHERE id = ${o.old.id} AND ${sql.unsafe(LIVE)} RETURNING id`
  if (replaced.length === 0) throw new Error(`fact ${o.old.id} is not live: it cannot be replaced`)
  return insertFact(sql, { ...o, id })
}

/** What storing a fact came to. */
export type Remembered =
  | { kind: 'new'; fact: FactRow }
  | { kind: 'updated'; fact: FactRow; before: string }
  /** The same value was already stored: nothing was written. */
  | { kind: 'unchanged'; fact: FactRow }
  /** The account holds `MAX_FACTS` already: nothing was written. */
  | { kind: 'full' }

/** Stores a fact, or replaces the live one of the same kind and key. Runs inside the commit transaction. */
export async function rememberFact(sql: Sql, o: NewFact): Promise<Remembered> {
  await lockFacts(sql, o.accountId)
  const [current] = await findLive(sql, o.accountId, { kind: o.kind, key: o.key }, { lock: true })
  if (current) {
    if (sameValue(current.value, o.value)) return { kind: 'unchanged', fact: current }
    const fact = await supersedeFact(sql, { ...o, old: current })
    return { kind: 'updated', fact, before: current.value }
  }
  if ((await countLive(sql, o.accountId)) >= MAX_FACTS) return { kind: 'full' }
  return { kind: 'new', fact: await insertFact(sql, o) }
}

/** Stamps a live fact as forgotten, by the message that asked. Never removes the row. False when it was not live: nothing was written. */
export async function forgetFact(sql: Sql, id: number, inboundId: number): Promise<boolean> {
  const stamped = await sql`
    UPDATE fact SET forgotten_at = now(), forgotten_by = ${inboundId}
    WHERE id = ${id} AND ${sql.unsafe(LIVE)} RETURNING id`
  return stamped.length > 0
}

/** Forgets every live fact of the account; returns them as they were. */
export async function forgetAll(
  sql: Sql,
  accountId: number,
  inboundId: number,
): Promise<FactRow[]> {
  await lockFacts(sql, accountId)
  return sql<FactRow[]>`
    UPDATE fact SET forgotten_at = now(), forgotten_by = ${inboundId}
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    RETURNING ${columns(sql)}`
}

// ---- Undo. A write batch is the inbound message that made the changes (see undo.ts).

/** A fact row a batch inserted or forgot, in any state. */
export interface BatchFact extends FactRow {
  /** The message that inserted the row. */
  inbound: number
  /** The message that forgot it, if one did. */
  forgottenBy: number | null
  /** The value of the row an update of this batch replaced; null when the row is new. */
  before: string | null
  /** The id of that row. */
  beforeId: number | null
}

/** Every fact row the batch inserted or forgot, of this account, oldest first. */
export function batchFacts(sql: Sql, accountId: number, batch: number) {
  return sql<BatchFact[]>`
    SELECT f.id::int AS id, f.kind, f.key, f.value, f.inbound_message_id::int AS inbound,
      f.forgotten_by::int AS "forgottenBy", p.value AS before, p.id::int AS "beforeId"
    FROM fact f LEFT JOIN fact p ON p.superseded_by = f.id
    WHERE f.account_id = ${accountId} AND (f.inbound_message_id = ${batch} OR f.forgotten_by = ${batch})
    ORDER BY f.id`
}

/** An undo brings a forgotten fact back as a new row (`restores` names the forgotten one). The forgotten row stays forgotten. */
export function restoreFact(
  sql: Sql,
  o: { accountId: number; inboundId: number; fact: FactRow },
): Promise<FactRow> {
  return insertFact(sql, {
    accountId: o.accountId,
    inboundId: o.inboundId,
    kind: o.fact.kind,
    key: o.fact.key,
    value: o.fact.value,
    restores: o.fact.id,
  })
}
