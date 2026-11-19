import { requireMcpAuth } from '@better-auth/mcp'
import { createResourceServerChallenge } from '@better-auth/oauth-provider'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { canonicalUserId, errorTag } from '@warren/core'
import { type Database, userIdentity } from '@warren/db'
import { APIError } from 'better-auth'
import { LEDGER_READ_SCOPE } from './auth-config'
import { registerKnowledgeTools } from './mcp-knowledge'
import { registerLedgerTools } from './mcp-ledger'

type McpAuth = Parameters<typeof requireMcpAuth>[0]

/**
 * `/api/mcp`: an MCP server with the ledger tools (`ledger_list_movements`, `ledger_summarize`) and the
 * knowledge tools (`knowledge_list_*`), stateless,
 * behind `requireMcpAuth`. That checks the JWT's signature, issuer, audience, expiry and the
 * `ledger:read` scope, and answers 401 or 403 with the `WWW-Authenticate` challenge itself.
 *
 * A JWT outlives the user's erasure by up to 15 minutes, so the door has one more check: the
 * token's `sub` must be a user that exists and was not erased, read as `warren_auth` (`auth`
 * is that connection). The tool runs through `asUser(database, userId, ...)`, which is why the
 * id is handed on in `authInfo.extra`; it is never an argument. Nothing about the token, its
 * claims or the request is logged.
 */
export function createMcpRoute({
  auth,
  authDatabase,
  database,
  resource,
  now = () => new Date(),
}: {
  auth: McpAuth
  /** `warren_auth`: only the user check. */
  authDatabase: Database
  /** `warren_app`: the ledger, reached through `asUser`. */
  database: Database
  resource: string
  now?: () => Date
}): (request: Request) => Promise<Response> {
  const mcp = createMcpHandler(
    (ctx) => {
      const server = new McpServer({ name: 'warren', version: '0.0.0' })
      const userId = ctx.authInfo?.extra?.userId
      // The route sets it for every request it serves; a missing one is a bug, not a guest.
      if (typeof userId !== 'string') throw new Error('mcp: no user on the request')
      registerLedgerTools(server, { database, userId, now })
      registerKnowledgeTools(server, { now })
      return server
    },
    { onerror: (error) => console.error('mcp:', errorTag(error)) },
  )
  // The plugin's own 401 for a token that failed, so this one reads like the others.
  const refused = (request: Request) => {
    const error = createResourceServerChallenge(
      new APIError('UNAUTHORIZED', { error: 'invalid_token', error_description: 'unknown user' }),
      resource,
      { request },
    )
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: error?.message },
        id: null,
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          ...Object.fromEntries(new Headers(error?.headers)),
        },
      },
    )
  }

  return requireMcpAuth(
    auth,
    async (request, claims) => {
      let userId: string
      try {
        userId = canonicalUserId(String(claims.sub))
      } catch {
        return refused(request)
      }
      try {
        if (!(await userIdentity(authDatabase, userId))) return refused(request)
      } catch (error) {
        // The database is down, which is not the client's fault: it must not be sent to sign in.
        console.error('mcp user check failed:', errorTag(error))
        return Response.json({ error: 'unavailable' }, { status: 503 })
      }
      const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
      return mcp.fetch(request, {
        authInfo: {
          // Never the token itself: handlers have no use for it.
          token: '',
          clientId: String(claims.azp ?? ''),
          scopes,
          extra: { userId },
        },
      })
    },
    // No `scope` in the challenge: it is the bare RFC 9728 pointer to the metadata, where the
    // scopes are.
    { resource, requiredScopes: [LEDGER_READ_SCOPE], challengeScopes: [] },
  )
}
