import { CATEGORIES, FACT_KINDS, type FactKind } from '../core/commands'
import { hasForeignDigit, unwritten } from '../core/numbers'
import { looksContact, looksSecret, sensitive } from '../core/secrets'
import { normalizeText } from '../core/values'

/** The most live facts one account holds. A person who reaches it is told, and forgets one to make room. */
export const MAX_FACTS = 100
/** The most facts the model is shown per message (the newest). Code lists them all on request. */
export const CONTEXT_FACTS = 30
export const MAX_KEY = 40
export const MAX_VALUE = 100
/** The most facts shown beyond the newest ones because the message says their key. */
export const MAX_MATCHED_FACTS = 20

/** The sent text of a fact: whitespace squashed, and the characters that could close a tag or a quote swapped for a space. */
export const tidy = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[<>"“”\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** How a key is compared and stored: lowercase, no accents, no punctuation, single spaces ("¡El Chino!" is "el chino"). */
export const normalizeKey = (key: string) =>
  normalizeText(tidy(key))
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Two values are the same fact when they only differ in case, accents or spacing. */
export const sameValue = (a: string, b: string) => normalizeText(tidy(a)) === normalizeText(tidy(b))

export interface FactInput {
  kind: FactKind
  key: string
  value: string
}

export type FactCheck =
  | { ok: true; fact: FactInput }
  /** What the model is told, to send it again. */
  | { ok: false; message: string }
  /** A secret or contact data: nothing is stored and the person is told so (the model is not asked to fix it). */
  | { ok: false; refused: 'secret' | 'contact' }

/**
 * The value rules of a fact, whoever sends it: a secret (a card or CBU number, a password, a DNI) or contact data (an email,
 * a phone) is refused and the sender told so; the key is 1 to 4 short words, the value fits, a `category` value is one of the
 * categories. `messageHasSecret`: the message the fact came with held a secret (a conversation's). Nothing about whose words they are.
 */
export function checkFactValues(input: FactInput, messageHasSecret = false): FactCheck {
  const key = normalizeKey(input.key)
  const value = tidy(input.value)
  const stored = `${key} ${value}`
  // What the model would store, as it wrote it (a key loses its punctuation and a card number its separators).
  const raw = `${tidy(input.key)} ${value}`
  // A phone number with its country code is as long as a card number: it is contact data, not a secret.
  const contact = looksContact(raw)
  if (contact && /\+\d/.test(raw)) return { ok: false, refused: 'contact' }
  if (looksSecret(raw) || messageHasSecret) return { ok: false, refused: 'secret' }
  if (contact) return { ok: false, refused: 'contact' }
  const why = (message: string): FactCheck => ({ ok: false, message })

  if (!(FACT_KINDS as readonly string[]).includes(input.kind)) return why('unknown kind')
  if (hasForeignDigit(stored)) return why('digits that are not 0-9')
  if (key === '') return why('key is empty: it is the words the person used')
  if (key.length > MAX_KEY || key.split(' ').length > 4) {
    return why(`key is too long: at most 4 words and ${MAX_KEY} characters`)
  }
  if (value === '') return why('value is empty')
  if (value.length > MAX_VALUE) return why(`value is too long: at most ${MAX_VALUE} characters`)
  if (input.kind === 'category' && !(CATEGORIES as readonly string[]).includes(value)) {
    return why(`for a category fact the value is exactly one of: ${CATEGORIES.join(', ')}`)
  }
  return { ok: true, fact: { kind: input.kind, key, value } }
}

/**
 * The rules of a fact before it is stored, none of them the model's to waive:
 * - it is a secret (a card or CBU number, a password, a DNI) or contact data (an email, a phone): refused, and the person is told so;
 * - the key is 1 to 4 short words and the value fits, and a `category` value is one of the categories;
 * - the person said it: the key (an alias also accepts the value) are words of their message, so a model
 *   cannot remember something it only inferred;
 * - every number in it is a number the person wrote (`cobro el 5` keeps its 5; a model's 4509 is refused).
 * `message` is the person's own message, or what was heard in a voice note.
 */
export function checkFact(input: FactInput, message: string): FactCheck {
  const checked = checkFactValues(input, sensitive(message))
  if (!checked.ok) return checked
  const { key, value } = checked.fact
  const stored = `${key} ${value}`
  const why = (message: string): FactCheck => ({ ok: false, message })
  // The person's own words: the key, or for an alias either side (the other may be in your terms: "la visa" is "crédito visa").
  const said = normalizeKey(message)
  const inMessage = (words: string) => words !== '' && said.includes(words)
  const traced =
    input.kind === 'alias' ? inMessage(key) || inMessage(normalizeKey(value)) : inMessage(key)
  if (!traced) {
    return why(
      'the key must be words the person wrote in this message; remember only what they state, never what you inferred (if unsure, ask with reply)',
    )
  }
  const made = unwritten(stored, message)
  if (made.length > 0) {
    return why(
      `numbers the person did not write: ${[...new Set(made)].join(', ')}. A fact holds only numbers they wrote; leave them out`,
    )
  }
  return { ok: true, fact: { kind: input.kind, key, value } }
}

// ---- The facts as stored (the new schema): versions of an entity, live while `ended_at IS NULL`. `id` is the entity id, the
// ---- same across every version, and the one the model and MCP clients see.

import type { Sql } from '../core/db'

/** A live fact as the model, the record and the list see it. `version` is the row of the version, which only the history reads. */
export interface FactRow {
  id: number
  version: number
  kind: FactKind
  /** Normalized: lowercase, no accents, single spaces. */
  key: string
  value: string
  loggedAt: Date
}

const columns = (sql: Sql) =>
  sql`entity_id::int AS id, id::int AS version, kind, key, value, logged_at AS "loggedAt"`

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
    WHERE account_id = ${accountId} AND ended_at IS NULL
    ORDER BY id DESC LIMIT ${limit}`
  const total = newest[0]?.total ?? 0
  const said = normalizeKey(message)
  if (said === '' || total <= newest.length) return { facts: newest, total }
  // A key counts when the message has it from the start of a word ("cafe" in "cafes").
  const named = await sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE account_id = ${accountId} AND ended_at IS NULL AND id <> ALL(${newest.map((f) => f.version)}::bigint[])
      AND strpos(${` ${said}`}, ' ' || key) > 0
    ORDER BY id DESC LIMIT ${MAX_MATCHED_FACTS}`
  return { facts: [...newest, ...named].sort((a, b) => b.version - a.version), total }
}

/** Every live fact of the account, by kind and key: what "¿qué sabés de mí?" lists. */
export function allLiveFacts(sql: Sql, accountId: number) {
  return sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE account_id = ${accountId} AND ended_at IS NULL
    ORDER BY kind, key`
}

/** Which live facts of the account to find: by entity id, by kind and key, or by key alone. */
export interface LiveFilter {
  id?: number
  kind?: FactKind
  key?: string
}

/**
 * The account's live facts that match the filter, oldest first, only ever the account's. `lock` takes a row lock on them. The
 * one query behind every lookup of a live fact.
 */
export function findLive(sql: Sql, accountId: number, f: LiveFilter, o: { lock?: boolean } = {}) {
  return sql<FactRow[]>`
    SELECT ${columns(sql)} FROM fact
    WHERE account_id = ${accountId} AND ended_at IS NULL
      ${f.id === undefined ? sql`` : sql`AND entity_id = ${f.id}`}
      ${f.kind === undefined ? sql`` : sql`AND kind = ${f.kind}`}
      ${f.key === undefined ? sql`` : sql`AND key = ${f.key}`}
    ORDER BY id ${o.lock ? sql`FOR UPDATE` : sql``}`
}

export async function countLiveFacts(sql: Sql, accountId: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM fact WHERE account_id = ${accountId} AND ended_at IS NULL`
  return row?.n ?? 0
}

/** Ends a version in a turn. Never removes the row; false when it was not live. */
export async function endFact(sql: Sql, version: number, turnId: number): Promise<boolean> {
  const ended = await sql`
    UPDATE fact SET ended_in = ${turnId}, ended_at = now()
    WHERE id = ${version} AND ended_at IS NULL RETURNING id`
  return ended.length > 0
}

/** Inserts a version: a new entity, or the next version of one (`entity`: it keeps its id and the time it was first stored). */
export async function insertFact(
  sql: Sql,
  o: {
    accountId: number
    turnId: number
    /** The instant of the message: when a new entity is first stored. */
    now: Date
    kind: FactKind
    key: string
    value: string
    entity?: { id: number; loggedAt: Date }
  },
): Promise<FactRow> {
  const [row] = await sql<FactRow[]>`
    INSERT INTO fact (${o.entity ? sql`entity_id,` : sql``} logged_at, account_id, made_in, kind, key, value)
    VALUES (${o.entity ? sql`${o.entity.id},` : sql``} ${o.entity?.loggedAt ?? o.now}, ${o.accountId}, ${o.turnId}, ${o.kind}, ${o.key}, ${o.value})
    RETURNING ${columns(sql)}`
  return row as FactRow
}

/** What storing a fact came to. */
export type Remembered =
  | { kind: 'new'; fact: FactRow }
  | { kind: 'updated'; fact: FactRow; before: string }
  /** The same value was already stored: nothing was written. */
  | { kind: 'unchanged'; fact: FactRow }
  /** The account holds `MAX_FACTS` already: nothing was written. */
  | { kind: 'full' }

/**
 * Stores a fact, or replaces the live one of the same kind and key with a new version. Runs inside the commit transaction (the
 * account lock is held, so the cap and the one-live-fact-per-key rule are decided one writer at a time).
 */
export async function rememberFact(
  sql: Sql,
  o: { accountId: number; turnId: number; now: Date; kind: FactKind; key: string; value: string },
): Promise<Remembered> {
  const [current] = await findLive(sql, o.accountId, { kind: o.kind, key: o.key }, { lock: true })
  if (current) {
    if (sameValue(current.value, o.value)) return { kind: 'unchanged', fact: current }
    await endFact(sql, current.version, o.turnId)
    const fact = await insertFact(sql, {
      ...o,
      entity: { id: current.id, loggedAt: current.loggedAt },
    })
    return { kind: 'updated', fact, before: current.value }
  }
  if ((await countLiveFacts(sql, o.accountId)) >= MAX_FACTS) return { kind: 'full' }
  return { kind: 'new', fact: await insertFact(sql, o) }
}

/** Forgets every live fact of the account; returns them as they were. */
export function forgetAll(sql: Sql, accountId: number, turnId: number) {
  return sql<FactRow[]>`
    UPDATE fact SET ended_in = ${turnId}, ended_at = now()
    WHERE account_id = ${accountId} AND ended_at IS NULL
    RETURNING ${columns(sql)}`
}
