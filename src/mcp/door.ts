import type { IncomingMessage } from 'node:http'
import { requireMcpAuth } from '@better-auth/mcp'
import { createResourceServerChallenge } from '@better-auth/oauth-provider'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { APIError } from 'better-auth/api'
import { fromNodeHeaders } from 'better-auth/node'
import { type Auth, mcpUrl, SCOPES } from '../auth/config'
import type { Sql } from '../db'
import { log } from '../log'
import { isAllowed } from '../process'
import { READ_SCOPE } from './tools'

/** What the door says about a request: who it is, or the answer to send instead. */
export type Admitted =
  | { ok: true; authInfo: AuthInfo & { extra: { accountId: number } } }
  | { ok: false; response: Response }

export type Door = (req: IncomingMessage) => Promise<Admitted>

export interface DoorOptions {
  auth: Auth
  sql: Sql
  /** `https://heywarren.app`: the issuer; the audience of a token is `${publicUrl}/mcp`. */
  publicUrl: string
  /** Normalized WhatsApp ids that may use Warren (`ALLOWED_WA_IDS`): the same list WhatsApp answers by. */
  allowed: string[]
}

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
 * The door of `/mcp` (docs/mcp-spec.md, Design 5), run on every request before anything else: the token's signature, issuer,
 * audience (`${publicUrl}/mcp`), expiry, `azp` and `ledger:read` are checked in-process by better-auth's `requireMcpAuth`; then
 * its type (`at+jwt`: a session JWT or an ID token is not an access token), and that its `sub` is a user that stands for an
 * account whose WhatsApp id is still allowed. Anything else is the same 401 with the `WWW-Authenticate` challenge, whatever
 * the reason, so a token teaches nothing; a database that cannot answer is a 503, not a reason to sign in again. The account
 * id leaves here, in `authInfo.extra`, and nowhere else: no tool takes it from its input. Tokens are never logged.
 */
export function createDoor(o: DoorOptions): Door {
  const resource = mcpUrl(o.publicUrl)
  const challengeScopes = [...SCOPES]

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
    let person: { id: string; wa_id: string } | undefined
    try {
      ;[person] = await o.sql<{ id: string; wa_id: string }[]>`
        SELECT a.id, a.wa_id FROM auth_user u JOIN account a ON a.id = u.warren_account_id
        WHERE u.id = ${sub}::uuid`
    } catch (error) {
      // The database is down, which is not the client's fault: it must not be sent to sign in.
      log(
        'mcp_door_unavailable',
        { error: error instanceof Error ? error.name : 'unknown' },
        'error',
      )
      return {
        ok: false,
        response: Response.json(
          { error: 'unavailable' },
          { status: 503, headers: { 'retry-after': '5' } },
        ),
      }
    }
    if (!person) return refused(request, 'unknown user')
    if (!isAllowed(o.allowed, person.wa_id)) return refused(request, 'not allowed')
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
    return {
      ok: true,
      authInfo: {
        // Never the token itself: nothing past the door has a use for it.
        token: '',
        clientId: String(claims.azp ?? ''),
        scopes,
        extra: { accountId: Number(person.id) },
      },
    }
  }

  return async (req) => {
    const request = new Request(resource, {
      method: req.method,
      headers: fromNodeHeaders(req.headers),
    })
    let admitted: Admitted | undefined
    // The cast: `requireMcpAuth`'s parameter type is a weak shape that a renamed `verification` model does not satisfy.
    const response = await requireMcpAuth(
      o.auth as unknown as Parameters<typeof requireMcpAuth>[0],
      async (verified, claims) => {
        admitted = await admit(verified, claims)
        return new Response(null, { status: 204 })
      },
      {
        resource,
        issuer: o.publicUrl,
        requiredScopes: [READ_SCOPE],
        challengeScopes,
      },
    )(request)
    return admitted ?? { ok: false, response }
  }
}
