import type { IncomingMessage, ServerResponse } from 'node:http'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { sendWeb } from '../auth/http'
import { log } from '../log'
import type { Door } from './door'

const INSTRUCTIONS =
  "Warren keeps a person's personal-finance ledger for Argentina: spending and income logged from WhatsApp, in ARS and USD. " +
  'Use warren_summarize for any total, count or comparison, and warren_find_movements to look at individual movements. ' +
  'Every amount is computed by Warren: quote it as given and never add, convert or round amounts yourself.'

/** The most a request body may hold: a tool call is a few hundred bytes. */
const MAX_BODY = 256 * 1024

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown')

/**
 * `POST /mcp` (docs/mcp-spec.md, Design 5): the door first, then a stateless MCP server, a new one for each request, whose
 * tools can only reach the account the door named. A failure anywhere answers 500 and is logged by name; none reaches the process.
 */
export function createMcpEndpoint(o: {
  door: Door
  /** The origins a browser page may call from (an `Origin` header, when there is one): ours, and the clients'. */
  origins: string[]
}) {
  const handler = createMcpHandler(
    (ctx) => {
      const info = ctx.authInfo
      const extra = info?.extra as { accountId?: unknown; waId?: unknown } | undefined
      const { accountId, waId } = extra ?? {}
      if (typeof accountId !== 'number' || typeof waId !== 'string') {
        throw new Error('no account from the door')
      }
      const server = new McpServer(
        { name: 'warren', version: '0.1.0' },
        { instructions: INSTRUCTIONS },
      )
      // The tools come from the registry in R6 (reminders included); until then the door and the protocol are what this serves.
      return server
    },
    {
      maxRequestBodySize: MAX_BODY,
      onerror: (error) => log('mcp_error', { error: errorName(error) }, 'error'),
    },
  )
  const node = toNodeHandler(handler, {
    maxRequestBodySize: MAX_BODY,
    onerror: (error) => log('mcp_adapter_error', { error: errorName(error) }, 'error'),
  })

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // A browser page of anyone else's site must not reach this with a token it holds: only ours and the known clients' origins.
      const origin = req.headers.origin
      if (origin !== undefined && !o.origins.includes(origin)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ error: 'origin_not_allowed' }))
      }
      const admitted = await o.door(req)
      if (!admitted.ok) return await sendWeb(res, admitted.response)
      ;(req as IncomingMessage & { auth?: unknown }).auth = admitted.authInfo
      await node(req, res)
    } catch (error) {
      log('mcp_failed', { error: errorName(error) }, 'error')
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal error' },
            id: null,
          }),
        )
      }
    }
  }
}
