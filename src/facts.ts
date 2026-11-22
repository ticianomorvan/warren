import { CONTEXT_FACTS, MAX_FACTS, sameValue } from './agent/memory'
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

/** The newest live facts, for the model's context, and how many live facts the account has in all. */
export async function liveFacts(
  sql: Sql,
  accountId: number,
  limit = CONTEXT_FACTS,
): Promise<{ facts: FactRow[]; total: number }> {
  const rows = await sql<(FactRow & { total: number })[]>`
    SELECT ${columns(sql)}, count(*) OVER ()::int AS total FROM fact
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    ORDER BY id DESC LIMIT ${limit}`
  return { facts: rows, total: rows[0]?.total ?? 0 }
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

/** The account's live fact for a kind and key, row-locked. Null when there is none. */
export async function lockLiveByKey(
  sql: Sql,
  accountId: number,
  kind: FactKind,
  key: string,
): Promise<FactRow | null> {
  const [row] = await sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE account_id = ${accountId} AND kind = ${kind} AND key = ${key} AND ${sql.unsafe(LIVE)}
    FOR UPDATE`
  return row ?? null
}

/** The account's live facts with this key, of any kind, row-locked. */
export function lockLiveWithKey(sql: Sql, accountId: number, key: string) {
  return sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE account_id = ${accountId} AND key = ${key} AND ${sql.unsafe(LIVE)}
    ORDER BY id FOR UPDATE`
}

/** One live fact by id, row-locked, only if it is the account's. Null when it is not: someone else's, or gone already. */
export async function lockLiveFact(
  sql: Sql,
  accountId: number,
  id: number,
): Promise<FactRow | null> {
  const [row] = await sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE id = ${id} AND account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    FOR UPDATE`
  return row ?? null
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
  await sql`UPDATE fact SET superseded_by = ${id} WHERE id = ${o.old.id}`
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
  const current = await lockLiveByKey(sql, o.accountId, o.kind, o.key)
  if (current) {
    if (sameValue(current.value, o.value)) return { kind: 'unchanged', fact: current }
    const fact = await supersedeFact(sql, { ...o, old: current })
    return { kind: 'updated', fact, before: current.value }
  }
  if ((await countLive(sql, o.accountId)) >= MAX_FACTS) return { kind: 'full' }
  return { kind: 'new', fact: await insertFact(sql, o) }
}

/** Stamps a live fact as forgotten, by the message that asked. Never removes the row. */
export async function forgetFact(sql: Sql, id: number, inboundId: number): Promise<void> {
  await sql`UPDATE fact SET forgotten_at = now(), forgotten_by = ${inboundId} WHERE id = ${id}`
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
}

/** Every fact row the batch inserted or forgot, of this account, oldest first. */
export function batchFacts(sql: Sql, accountId: number, batch: number) {
  return sql<BatchFact[]>`
    SELECT f.id::int AS id, f.kind, f.key, f.value, f.inbound_message_id::int AS inbound,
      f.forgotten_by::int AS "forgottenBy", p.value AS before
    FROM fact f LEFT JOIN fact p ON p.superseded_by = f.id
    WHERE f.account_id = ${accountId} AND (f.inbound_message_id = ${batch} OR f.forgotten_by = ${batch})
    ORDER BY f.id`
}

/** The account's live fact for this kind and key. Undo reads it under the facts lock. */
export async function liveFactByKey(
  sql: Sql,
  accountId: number,
  kind: FactKind,
  key: string,
): Promise<FactRow | null> {
  const [row] = await sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE account_id = ${accountId} AND kind = ${kind} AND key = ${key} AND ${sql.unsafe(LIVE)}`
  return row ?? null
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
