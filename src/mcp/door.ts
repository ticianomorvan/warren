import { requireMcpAuth } from '@better-auth/mcp'
import { createResourceServerChallenge } from '@better-auth/oauth-provider'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { APIError } from 'better-auth/api'
import { ensureAccount } from '../auth/account'
import { type Auth, mcpUrl, SCOPES } from '../auth/config'
import type { Sql } from '../core/db'
import { log } from '../log'

/** What the door says about a request: who it is, or the answer to send instead. */
export type Admitted =
  | { ok: true; authInfo: AuthInfo & { extra: { accountId: number } } }
  | { ok: false; response: Response }

export type Door = (request: Request) => Promise<Admitted>

export interface DoorOptions {
  auth: Auth
  sql: Sql
  /** `https://heywarren.app`: the issuer; the audience of a token is `${publicUrl}/mcp`. */
  publicUrl: string
  /** The most calls one account may make in a minute. Default `CALLS_PER_MINUTE`. */
  callsPerMinute?: number
  /** The clock of the rate limit; a test moves it. */
  now?: () => number
}

/** What one account may do at the door in a minute: far more than a person and their agent need, far less than a loop gone wrong. */
export const CALLS_PER_MINUTE = 120

/** Too many calls from one account in a minute: a typed code the client's agent can read, and when to try again. */
const rateLimited = (retryAfter: number): Admitted => ({
  ok: false,
  response: Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'rate_limited' },
      id: null,
      code: 'rate_limited',
    },
    { status: 429, headers: { 'retry-after': String(retryAfter) } },
  ),
})

/** The database cannot answer: try again, do not sign in again. */
const unavailable = (): Admitted => ({
  ok: false,
  response: Response.json(
    { error: 'unavailable' },
    { status: 503, headers: { 'retry-after': '5' } },
  ),
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The `typ` of a token's header, lower case, or '' when there is no readable one. */
function tokenType(authorization: string | null): string {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]
  try {
    const header = JSON.parse(
      Buffer.from((token ?? '').split('.')[0] ?? '', 'base64url').toString(),
    )
    return typeof header?.typ === 'string' ? header.typ.toLowerCase() : ''
  } catch {
    return ''
  }
}

/**
 * The door of `/mcp` (docs/design.md, "MCP and auth"), run on every request before anything else, and only authentication: who is
 * asking, never what they may do (each tool asks for its own scope). better-auth's `requireMcpAuth` checks the token's
 * signature, issuer, audience (`${publicUrl}/mcp`), expiry and `azp` in-process; its own DPoP handling stays on and refuses
 * what it cannot prove (this server issues bearer tokens only, so a client has none). Then ours: the token's type is `at+jwt`
 * (a session JWT or an ID token is not an access token; `requireMcpAuth` does not offer jose's `typ` option, so the header is read
 * here), and its `sub` is a user that stands for an account that has not cut its connections since the token was issued
 * (`mcp_revoked_at`, set by "disconnect all agents" on the account page). Then the account's calls this minute are counted: past
 * the limit the answer is a 429 with the typed code `rate_limited`. Our own refusals are one 401 with
 * the `WWW-Authenticate` challenge whatever the reason, so a token teaches nothing; better-auth's carry their own error
 * description, which tells a client what it already knows. A database that cannot answer is a 503, not a reason to sign in again.
 * The account id leaves here, in `authInfo.extra`, and nowhere else: no tool takes it from its input. Tokens are never logged.
 */
export function createDoor(o: DoorOptions): Door {
  const resource = mcpUrl(o.publicUrl)
  const challengeScopes = [...SCOPES]
  const limit = o.callsPerMinute ?? CALLS_PER_MINUTE
  const now = o.now ?? Date.now
  // One process, one replica (AGENTS.md): a fixed one-minute window per account, in memory. A deploy resets it, which only gives a
  // fresh minute.
  const windows = new Map<number, { start: number; calls: number }>()
  const count = (accountId: number): number | null => {
    const t = now()
    const w = windows.get(accountId)
    if (!w || t - w.start >= 60_000) {
      windows.set(accountId, { start: t, calls: 1 })
      // Drop windows that ended: the map holds only accounts active this minute.
      if (windows.size > 10_000)
        for (const [id, x] of windows) if (t - x.start >= 60_000) windows.delete(id)
      return null
    }
    w.calls += 1
    return w.calls > limit ? Math.max(1, Math.ceil((60_000 - (t - w.start)) / 1000)) : null
  }

  const refused = (request: Request, reason: string): Admitted => {
    log('mcp_refused', { reason })
    const challenge = createResourceServerChallenge(
      new APIError('UNAUTHORIZED', { error: 'invalid_token', error_description: 'invalid token' }),
      resource,
      { request, challengeScopes },
    )
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: challenge?.message },
          id: null,
        }),
        {
          status: 401,
          headers: {
            'content-type': 'application/json',
            ...Object.fromEntries(new Headers(challenge?.headers)),
          },
        },
      ),
    }
  }

  async function admit(request: Request, claims: Record<string, unknown>): Promise<Admitted> {
    const typ = tokenType(request.headers.get('authorization'))
    if (typ !== 'at+jwt' && typ !== 'application/at+jwt') return refused(request, 'token type')
    const sub = claims.sub
    if (typeof sub !== 'string' || !UUID.test(sub)) return refused(request, 'subject')
    let person: { id: number; revoked: number | null } | undefined
    try {
      const find = () => o.sql<{ id: number; revoked: number | null }[]>`
        SELECT a.id::int, extract(epoch FROM a.mcp_revoked_at)::float8 AS revoked
        FROM auth_user u
        JOIN account a ON a.id = u.warren_account_id
        WHERE u.id = ${sub}::uuid`
      let [row] = await find()
      // A user whose account was never made (its create hook failed) is repaired here, once; a user that does not exist stays unknown.
      if (!row && (await ensureAccount(o.sql, sub)) !== null) [row] = await find()
      person = row
    } catch (error) {
      // The database is down, which is not the client's fault: it must not be sent to sign in.
      log(
        'mcp_door_unavailable',
        { error: error instanceof Error ? error.name : 'unknown' },
        'error',
      )
      return unavailable()
    }
    if (!person) return refused(request, 'unknown user')
    // "disconnect all agents": a token issued at or before the person cut their connections is dead, though its signature and expiry are good.
    if (
      person.revoked !== null &&
      !(typeof claims.iat === 'number' && claims.iat > Math.floor(person.revoked))
    ) {
      return refused(request, 'disconnected')
    }
    const wait = count(person.id)
    if (wait !== null) {
      log('mcp_rate_limited', {})
      return rateLimited(wait)
    }
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
    return {
      ok: true,
      authInfo: {
        // Never the token itself: nothing past the door has a use for it.
        token: '',
        clientId: String(claims.azp ?? ''),
        scopes,
        extra: { accountId: person.id },
      },
    }
  }

  return async (request) => {
    let admitted: Admitted | undefined
    let response: Response
    try {
      // The cast: `requireMcpAuth`'s parameter type is a weak shape that a renamed `verification` model does not satisfy.
      response = await requireMcpAuth(
        o.auth as unknown as Parameters<typeof requireMcpAuth>[0],
        async (verified, claims) => {
          admitted = await admit(verified, claims)
          return new Response(null, { status: 204 })
        },
        { resource, issuer: o.publicUrl, challengeScopes },
      )(request)
    } catch (error) {
      // A token that fails verification is answered, not thrown: what is thrown here is reading the signing keys (`auth_jwks`)
      // or the replay store, which is the database. Not the client's fault, so not a reason to sign in again.
      log(
        'mcp_door_unavailable',
        { error: error instanceof Error ? error.name : 'unknown' },
        'error',
      )
      return unavailable()
    }
    return admitted ?? { ok: false, response }
  }
}
