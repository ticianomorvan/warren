import {
  canonicalUserId,
  type MasterKeys,
  newDataKey,
  type Sealer,
  sealerFor,
  UserErasedError,
  unwrapDataKey,
  wrapDataKey,
} from '@warren/core'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'
import * as schema from './schema'

/** The user-id spelling and the erased-user error live in core, so intake can use them too. */
export { canonicalUserId, UserErasedError }

/** Driver-independent handle: node-postgres in production, PGlite in tests. Never exported. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

declare const opaque: unique symbol

/**
 * A connection to the database, and nothing more. There is no way to run a query on it:
 * `asUser` is the only door to a user's rows, and the `system` module holds the few calls
 * that exist to find a user. A query without a user cannot be written.
 */
export interface Database {
  readonly [opaque]: true
}

type Internals = { db: Db; masters: MasterKeys; role: string | null }
const internals = new WeakMap<Database, Internals>()

export function createPool(connectionString: string, max = 5): Pool {
  // Short idle timeout: serverless instances are suspended between requests.
  return new Pool({ connectionString, max, idleTimeoutMillis: 5000 })
}

/**
 * Wraps a driver handle. `role` is for tests only: it makes every transaction run as that
 * role (`set local role`), because PGlite connects as a superuser, who ignores row-level
 * security. A real connection logs in as the role instead.
 */
export function openDatabase(
  db: Db,
  masters: MasterKeys,
  options: { role?: string } = {},
): Database {
  const handle = Object.freeze({}) as Database
  internals.set(handle, { db, masters, role: options.role ?? null })
  return handle
}

export function createDatabase(pool: Pool, masters: MasterKeys): Database {
  return openDatabase(drizzle(pool, { schema }) as unknown as Db, masters)
}

/** Holds no master key, so nothing wrapped with one can be made or opened through it. */
const NO_MASTER_KEYS: MasterKeys = { current: 1, keys: new Map() }

/**
 * A connection for operator commands that never seal or open anything (setting a password,
 * erasing a user): they need no `WARREN_MASTER_KEY`, and `asUser` on it fails at the key.
 */
export function createKeylessDatabase(pool: Pool): Database {
  return createDatabase(pool, NO_MASTER_KEYS)
}

function internalsOf(database: Database): Internals {
  const found = internals.get(database)
  if (!found) throw new Error('not a Database from @warren/db')
  return found
}

/**
 * A transaction as one user, without that user's key. Sets `app.user_id` with a bound
 * parameter and `is_local = true`: it lasts until this transaction ends and is gone before the
 * pooled connection serves anyone else. Never `SET`, never `set_config(..., false)`: the Neon
 * pooler would carry them to another client.
 */
export async function inUserContext<T>(
  database: Database,
  id: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const userId = canonicalUserId(id)
  const { db, role } = internalsOf(database)
  return db.transaction(async (tx) => {
    if (role) await tx.execute(sql`select set_config('role', ${role}, true)`)
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return fn(tx)
  })
}

/** A transaction with no user: only for the calls that find one, and for operators. */
export async function inSystemContext<T>(
  database: Database,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const { db, role } = internalsOf(database)
  return db.transaction(async (tx) => {
    if (role) await tx.execute(sql`select set_config('role', ${role}, true)`)
    return fn(tx)
  })
}

/**
 * What a callback gets for one user: the transaction, and that user's key to seal and open
 * personal data. The associated data of every sealed value names the user and the row.
 * `seal` and `open` work on bytes (and strings: `open(...).toString('utf8')` reads one back);
 * `json` is the one codec for structured values.
 */
export type Scope = {
  tx: Tx
  userId: string
  seal(plaintext: Uint8Array | string, aad: string): Buffer
  open(sealed: Uint8Array, aad: string): Buffer
  json: {
    seal(value: unknown, aad: string): Buffer
    open<T>(sealed: Uint8Array, aad: string): T
  }
  mailId(raw: Uint8Array): string
}

function scopeOf(tx: Tx, userId: string, sealer: Sealer): Scope {
  const seal: Scope['seal'] = (plaintext, aad) =>
    sealer.seal(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext, aad)
  const open: Scope['open'] = (sealed, aad) => sealer.open(sealed, aad)
  return {
    tx,
    userId,
    seal,
    open,
    json: {
      seal: (value, aad) => seal(JSON.stringify(value), aad),
      open: <T>(sealed: Uint8Array, aad: string) =>
        JSON.parse(open(sealed, aad).toString('utf8')) as T,
    },
    mailId: sealer.mailId,
  }
}

/** The user's data key, made on first use. A user that was erased never gets another. */
async function dataKeyFor(tx: Tx, userId: string, masters: MasterKeys): Promise<Buffer> {
  const read = () =>
    tx
      .select({ wrapped: schema.userKey.wrappedKey, version: schema.userKey.wrapVersion })
      .from(schema.userKey)
      .where(eq(schema.userKey.userId, userId))
  let row = (await read())[0]
  if (!row) {
    const erased = await tx
      .select({ userId: schema.erasure.userId })
      .from(schema.erasure)
      .where(eq(schema.erasure.userId, userId))
    if (erased[0]) throw new UserErasedError()
    const { wrapped, version } = wrapDataKey(masters, userId, newDataKey())
    await tx
      .insert(schema.userKey)
      .values({ userId, wrappedKey: wrapped, wrapVersion: version })
      .onConflictDoNothing()
    row = (await read())[0]
    if (!row) throw new Error('user key could not be created')
  }
  return unwrapDataKey(masters, userId, row.wrapped, row.version)
}

/**
 * The advisory-lock purpose that orders erasure against everything else a user does. Every
 * `asUser` holds it shared until its transaction ends; `eraseUser` holds it exclusively. So
 * erasure waits for work in flight, and work that starts after it sees the tombstone.
 */
export const ERASURE_LOCK = 4200

/**
 * The one door to a user's data. Opens a transaction as the user, takes the erasure lock
 * shared, loads and unwraps the user's key (making it the first time), and runs `fn`.
 * Row-level security then shows `fn` only that user's rows, whatever it asks for. For a user
 * who was erased it throws `UserErasedError`; it never makes them a new key.
 */
export async function asUser<T>(
  database: Database,
  id: string,
  fn: (scope: Scope) => Promise<T>,
): Promise<T> {
  const userId = canonicalUserId(id)
  const { masters } = internalsOf(database)
  return inUserContext(database, userId, async (tx) => {
    await lockUserShared(tx, userId, ERASURE_LOCK)
    const dataKey = await dataKeyFor(tx, userId, masters)
    return fn(scopeOf(tx, userId, sealerFor(userId, dataKey)))
  })
}

/** Makes the user's key now, so it exists before their first mail. A no-op when it does. */
export async function provisionUser(database: Database, userId: string): Promise<void> {
  await asUser(database, userId, async () => {})
}

/*
 * One advisory lock per user and purpose, held until the transaction ends. `userId` must be
 * canonical (it is hashed as text). Shared locks do not block each other, only an exclusive one.
 */

/** Waits for every holder of the lock, shared or exclusive, and blocks everyone until commit. */
export async function lockUserExclusive(tx: Tx, userId: string, purpose: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}::text, ${purpose}))`)
}

/** Waits only for an exclusive holder; any number of shared holders run together. */
export async function lockUserShared(tx: Tx, userId: string, purpose: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${userId}::text, ${purpose}))`,
  )
}

/** Rows of a raw `tx.execute` result, whichever driver made it (node-postgres and PGlite differ in type, not shape). */
export function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[]
  return Array.isArray(r) ? r : (r.rows ?? [])
}
