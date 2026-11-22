import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { requireMcpAuth } from '@better-auth/mcp'
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import type { Sql } from '../db'
import { type Auth, mcpUrl, SCOPES } from './config'
import { LINK_TTL_MINUTES, type Links } from './link'
import { consentPage, messagePage, signInPage } from './pages'
import { LINK_COOKIE } from './plugin'

export interface AuthRoutesOptions {
  auth: Auth
  sql: Sql
  links: Links
  /** `https://heywarren.app`: the only host these routes answer on. */
  publicUrl: string
  /** The WhatsApp number as a person reads it; its digits make the `wa.me` link. */
  displayNumber: string
}

/** Serves what the authorization server needs besides better-auth's own endpoints; false when the path is not one of its. */
export type AuthRoutes = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

const csp = (nonce: string) =>
  `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; ` +
  `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

/** What a client calls itself, safe to show and to put in a WhatsApp text: no control or formatting characters, short. */
export function cleanName(s: string): string {
  const name = s
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[\p{Cf}*_~`<>]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return name.length > 40 ? `${name.slice(0, 39).trimEnd()}…` : name
}

/** The `Cookie` header's value for `name`. */
function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
}

function sendHtml(res: ServerResponse, status: number, html: string, nonce: string, extra = {}) {
  res.writeHead(status, { ...PAGE_HEADERS, 'content-security-policy': csp(nonce), ...extra })
  res.end(html)
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function sendWeb(res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) headers['set-cookie'] = cookies
  res.writeHead(response.status, headers)
  res.end(Buffer.from(await response.arrayBuffer()))
}

const OAUTH_PATH = /^\/(?:api\/auth(?:\/|$)|\.well-known\/)/

/**
 * The browser-facing half of the authorization server (docs/mcp-spec.md, Design 2 and 3): better-auth's own
 * endpoints and `.well-known` documents, the sign-in page and its status, the consent page, and `/mcp` (which
 * in this slice only answers the 401 challenge). All of it answers on `publicUrl`'s host and nowhere else, so
 * tokens and metadata name one issuer; the webhook is not here and answers on any host.
 */
export function createAuthRoutes(o: AuthRoutesOptions): AuthRoutes {
  const { auth, sql, links, publicUrl } = o
  const publicHost = new URL(publicUrl).host
  const secureCookie = publicUrl.startsWith('https:')
  const betterAuth = toNodeHandler(auth)
  const waNumber = o.displayNumber.replace(/\D/g, '')
  const resource = mcpUrl(publicUrl)

  /** The MCP endpoint's door. Slice 2 puts the tools behind it; for now a good token meets "not implemented". */
  // The cast: `requireMcpAuth`'s parameter type is a weak shape that a renamed `verification` model does not satisfy.
  const mcpDoor = requireMcpAuth(
    auth as unknown as Parameters<typeof requireMcpAuth>[0],
    () => Response.json({ error: 'not_implemented' }, { status: 501 }),
    {
      resource,
      issuer: publicUrl,
      requiredScopes: ['ledger:read'],
      challengeScopes: [...SCOPES],
    },
  )

  async function verified(query: string): Promise<URLSearchParams | null> {
    if (!query || !(await verifyOAuthQueryParams(query, (await auth.$context).secret))) return null
    return new URLSearchParams(query)
  }

  /** What to call the client in the page and in the question on WhatsApp: its own name, and the host its id lives on. */
  async function clientLabel(clientId: string): Promise<string> {
    let host = ''
    try {
      host = new URL(clientId).hostname
    } catch {}
    const [row] = await sql<{ name: string | null }[]>`
      SELECT name FROM auth_oauth_client WHERE "clientId" = ${clientId}`
    const name = cleanName(row?.name ?? '') || host
    return host && name !== host ? `${name} (${host})` : name
  }

  async function signIn(req: IncomingMessage, res: ServerResponse, url: URL) {
    const nonce = randomBytes(16).toString('base64')
    const params = await verified(url.search.slice(1))
    const clientId = params?.get('client_id')
    if (!params || !clientId) {
      return sendHtml(
        res,
        400,
        messagePage(nonce, 'Esta página se abre desde Claude', 'Volvé a Claude y tocá conectar.'),
        nonce,
      )
    }
    const client = await clientLabel(clientId)
    const secret = cookie(req, LINK_COOKIE)
    const link = (secret && (await links.current(secret, client))) || (await links.open(client))
    if (!link) {
      return sendHtml(
        res,
        429,
        messagePage(nonce, 'Hay muchas conexiones en curso', 'Probá de nuevo en unos minutos.'),
        nonce,
      )
    }
    const seconds = Math.max(1, Math.floor((link.expiresAt.getTime() - Date.now()) / 1000))
    const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${secureCookie ? '; Secure' : ''}`
    sendHtml(
      res,
      200,
      signInPage({
        nonce,
        client,
        code: link.code,
        displayNumber: o.displayNumber,
        waLink: `https://wa.me/${waNumber}?text=${encodeURIComponent(`vincular ${link.code}`)}`,
        minutes: LINK_TTL_MINUTES,
      }),
      nonce,
      { 'set-cookie': `${LINK_COOKIE}=${link.secret}; ${flags}` },
    )
  }

  async function signInStatus(req: IncomingMessage, res: ServerResponse) {
    const secret = cookie(req, LINK_COOKIE)
    sendJson(res, 200, { state: secret ? await links.state(secret) : 'closed' })
  }

  async function consent(req: IncomingMessage, res: ServerResponse, url: URL) {
    const nonce = randomBytes(16).toString('base64')
    const params = await verified(url.search.slice(1))
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    const clientId = params?.get('client_id')
    if (!params || !clientId || !session) {
      return sendHtml(
        res,
        401,
        messagePage(nonce, 'La conexión venció', 'Volvé a Claude y tocá conectar de nuevo.'),
        nonce,
      )
    }
    let redirectHost = ''
    try {
      redirectHost = new URL(params.get('redirect_uri') ?? '').host
    } catch {}
    sendHtml(
      res,
      200,
      consentPage({
        nonce,
        client: await clientLabel(clientId),
        redirectHost,
        scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
      }),
      nonce,
    )
  }

  async function mcpRoute(req: IncomingMessage, res: ServerResponse) {
    // No tools yet, so the body is never read: only the token and the challenge matter.
    const request = new Request(resource, {
      method: req.method,
      headers: fromNodeHeaders(req.headers),
    })
    await sendWeb(res, await mcpDoor(request))
  }

  return async (req, res, url) => {
    const path = url.pathname
    const isPage = path === '/sign-in' || path === '/sign-in/status' || path === '/oauth/consent'
    if (!isPage && path !== '/mcp' && !OAUTH_PATH.test(path)) return false
    if (req.headers.host !== publicHost) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end()
      return true
    }
    if (path === '/sign-in' && req.method === 'GET') await signIn(req, res, url)
    else if (path === '/sign-in/status' && req.method === 'GET') await signInStatus(req, res)
    else if (path === '/oauth/consent' && req.method === 'GET') await consent(req, res, url)
    else if (path === '/mcp') await mcpRoute(req, res)
    else if (OAUTH_PATH.test(path)) await betterAuth(req, res)
    else res.writeHead(405, { allow: 'GET' }).end()
    return true
  }
}
