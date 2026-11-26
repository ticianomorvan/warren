import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTestDatabase, sql, useDatabase } from '../test/db'
import { type Auth, createAuth } from './auth/config'
import { type AuthRoutes, createAuthRoutes } from './auth/routes'
import type { Sql } from './core/db'
import { createDoor } from './mcp/door'
import { createMcpEndpoint } from './mcp/endpoint'
import { argentinaToday } from './time'
import { createWarren } from './warren'
import { createSite, type Site } from './web/site'

/**
 * The harness of the HTTP tests: the whole app on a database `useDatabase` made, listening on a port of its own. The pieces live in
 * `test/` (db, until); this file starts Warren the way `server.ts` does, with the OAuth server's issuer being the test server's own
 * origin (known only once it listens), and Google and the client's metadata document faked by the caller.
 */
export { createTestDatabase, sql, useDatabase }

export const AUTH_SECRET = 'test-secret-for-better-auth-0123456789abcdef'

/** The clock of the MCP tests unless one is given: a fixed instant in the past, so what a test logs is never "in the future". */
export const NOW = new Date(1760000000 * 1000)
export const TODAY = argentinaToday(NOW)

export async function setup(
  opts: {
    /** A database other than the one `useDatabase` set. */
    sql?: Sql
    /** How a client's metadata document is fetched (a fake claude.ai). */
    fetchClient?: Parameters<typeof createAuth>[0]['fetchClientMetadataResource']
    /** The clock of MCP writes and of the door's rate limit window. */
    clock?: () => Date
    /** The clock the account page judges "a fresh sign-in" by. */
    accountNow?: () => Date
    callsPerMinute?: number
    /** What makes the account of a new user: a test makes it fail. */
    makeAccount?: Parameters<typeof createAuth>[0]['makeAccount']
  } = {},
) {
  const db = opts.sql ?? sql
  let routes: AuthRoutes | undefined
  let site: Site | undefined
  let mcp: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const { server } = createWarren({
    sql: db,
    config: {},
    publicHost: () => new URL(base).host,
    authRoutes: (req, res, url) => routes?.(req, res, url) ?? Promise.resolve(false),
    site: (req, res, url) => site?.(req, res, url) ?? false,
    mcp: (req, res) => mcp?.(req, res) ?? Promise.resolve(),
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const auth: Auth = createAuth({
    sql: db,
    publicUrl: base,
    secret: AUTH_SECRET,
    google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' },
    fetchClientMetadataResource: opts.fetchClient,
    ...(opts.makeAccount ? { makeAccount: opts.makeAccount } : {}),
  })
  routes = createAuthRoutes({
    auth,
    sql: db,
    publicUrl: base,
    ...(opts.accountNow ? { now: opts.accountNow } : {}),
  })
  site = createSite(base)
  const clock = opts.clock ?? (() => NOW)
  mcp = createMcpEndpoint({
    door: createDoor({
      auth,
      sql: db,
      publicUrl: base,
      ...(opts.callsPerMinute ? { callsPerMinute: opts.callsPerMinute } : {}),
      now: () => clock().getTime(),
    }),
    sql: db,
    publicUrl: base,
    now: clock,
  })
  return { auth, base, port, close: () => server.close() }
}

export const count = async (table: 'account' | 'turn' | 'movement' | 'fact' | 'auth_user') =>
  Number((await sql.unsafe(`SELECT count(*) AS n FROM ${table}`))[0]?.n)
