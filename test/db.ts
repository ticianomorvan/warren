import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { connect, migrate, type Sql, schemaDir } from '../src/core/db'

/** The real Postgres the suite runs on when set (CI's `postgres:17` service job, or `docker run` locally); PGlite otherwise. */
export const PG_TEST_URL = process.env.PG_TEST_URL || undefined

/** True on a real Postgres: the tests that need one (pools, races) run only then. */
export const realPostgres = PG_TEST_URL !== undefined

export interface TestDatabase {
  sql: Sql
  close: () => Promise<void>
}

/**
 * A migrated database of its own. On PGlite (default) an in-process server behind a socket. With
 * PG_TEST_URL set, a fresh schema on that Postgres (dropped on close), so test files running in
 * parallel never see each other's rows. `max` is the connection pool: PGlite shares one session
 * between connections, so only a real Postgres gets more than one. `migrations` picks the folder (v1's by default,
 * `schemaDir` for the new schema) or `false` for an empty database.
 */
export async function createTestDatabase(
  o: { max?: number; migrations?: URL | false } = {},
): Promise<TestDatabase> {
  const up = async (sql: Sql) => {
    if (o.migrations === false) return
    await migrate(sql, o.migrations)
    await migrate(sql, o.migrations) // idempotent
  }
  if (PG_TEST_URL) {
    const schema = `t_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const admin = connect(PG_TEST_URL, { max: 1 })
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const sql = connect(PG_TEST_URL, { max: o.max ?? 1, connection: { search_path: schema } })
    await up(sql)
    return {
      sql,
      close: async () => {
        await sql.end({ timeout: 1 })
        await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
        await admin.end({ timeout: 1 })
      },
    }
  }
  const pg = await PGlite.create()
  const socket = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 10 })
  await socket.start()
  const port = (socket as unknown as { server: { address(): AddressInfo } }).server.address().port
  const sql = connect(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 })
  await up(sql)
  return {
    sql,
    close: async () => {
      await sql.end({ timeout: 1 })
      await socket.stop()
      await pg.close()
    },
  }
}

/** The test file's database, set by `useDatabase`. */
export let sql: Sql

/**
 * Gives the test file its own migrated database (see `createTestDatabase`) and empties the tables
 * between tests. Call it once at the top of the file and import `sql` from here.
 */
export function useDatabase(o: { max?: number; migrations?: URL } = {}): void {
  let db: TestDatabase | undefined
  beforeAll(async () => {
    db = await createTestDatabase(o)
    sql = db.sql
  })
  afterAll(async () => {
    await db?.close()
  })
  beforeEach(async () => {
    if (o.migrations === schemaDir) {
      await sql`TRUNCATE mcp_request, reminder_send, reminder, fact, movement, reply, wa_message, turn,
        account_address, account RESTART IDENTITY CASCADE`
      return
    }
    await sql`TRUNCATE link_request, auth_oauth_access_token, auth_oauth_refresh_token, auth_oauth_consent,
      auth_oauth_client_resource, auth_oauth_client_assertion, auth_oauth_resource, auth_oauth_client, auth_session,
      auth_account, auth_verification, auth_jwks, auth_user,
      reminder_send, reminder, fact, movement, reply, inbound_message, account RESTART IDENTITY CASCADE`
  })
}
