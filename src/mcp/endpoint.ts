import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import type { Sql } from '../core/db'
import { log } from '../log'
import { allowedOrigins } from './clients'
import type { Door } from './door'
import { registerTools } from './tools'

const INSTRUCTIONS =
  "Warren keeps a person's personal-finance ledger for Argentina: spending and income logged from WhatsApp, in ARS and USD, and their reminders. " +
  'Use warren_summarize for any total, count or comparison, and warren_find_movements to look at individual movements. ' +
  'Every amount is computed by Warren: quote it as given and never add, convert or round amounts yourself.'

/** The most a request body may hold: a tool call is a few hundred bytes. */
const MAX_BODY = 256 * 1024

/** The origin an `Origin` header spells, or the header as it is when it is no URL (`null`), which no allowed origin equals. */
const originOf = (origin: string) => {
  try {
    return new URL(origin).origin
  } catch {
    return origin
  }
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown')

/**
 * `/mcp` (docs/history/mcp-spec.md, Design 5) as one web handler, mounted on node by the SDK's own adapter: the origin first,
 * then the door, then a stateless MCP server, a new one for each request, whose tools can only reach the account the door named
 * (it travels in `authInfo`, which the door makes and the handler passes on: nothing of the request is mutated). A failure
 * inside answers 500 and is logged by name; none reaches the process.
 */
export function createMcpEndpoint(o: {
  door: Door
  sql: Sql
  /** `https://heywarren.app`: ours is one of the origins a page may call from (`app.ts` answers on its host only). */
  publicUrl: string
  now?: () => Date
}) {
  const origins = allowedOrigins(o.publicUrl)
  const handler = createMcpHandler(
    (ctx) => {
      const accountId = (ctx.authInfo?.extra as { accountId?: unknown } | undefined)?.accountId
      if (typeof accountId !== 'number') throw new Error('no account from the door')
      const server = new McpServer(
        { name: 'warren', version: '0.1.0' },
        { instructions: INSTRUCTIONS },
      )
      registerTools(server, { sql: o.sql, accountId, now: o.now ?? (() => new Date()) })
      return server
    },
    {
      maxRequestBodySize: MAX_BODY,
      onerror: (error) => log('mcp_error', { error: errorName(error) }, 'error'),
    },
  )
  return toNodeHandler(
    {
      fetch: async (request) => {
        // A browser page of anyone else's site must not reach this with a token it holds: only ours and the clients' exact origins
        // (the SDK's `originValidationResponse` compares hostnames, so `http://claude.ai` and `:8443` would pass it).
        const origin = request.headers.get('origin')
        if (origin !== null && !origins.has(originOf(origin)))
          return Response.json({ error: 'origin_not_allowed' }, { status: 403 })
        const admitted = await o.door(request)
        if (!admitted.ok) return admitted.response
        return handler.fetch(request, { authInfo: admitted.authInfo })
      },
    },
    {
      maxRequestBodySize: MAX_BODY,
      onerror: (error) => log('mcp_adapter_error', { error: errorName(error) }, 'error'),
    },
  )
}
