import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import { whatsappAddress } from '../access'
import type { Sql } from '../core/db'
import type { Auth } from './config'
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

/**
 * The client's address: Railway's `X-Real-IP` (written by its edge, a client's own copy replaced), else the socket's. See
 * the note in `config.ts` on why not `X-Forwarded-For`.
 */
function clientIp(req: IncomingMessage): string {
  const real = req.headers['x-real-ip']
  return (typeof real === 'string' && real.trim()) || req.socket.remoteAddress || 'unknown'
}

/** `+54 9 ····5678`: enough for a person to know whose account it is, never the number. */
export function maskNumber(waId: string): string {
  const digits = waId.replace(/\D/g, '')
  const prefix = digits.startsWith('549') ? '+54 9' : `+${digits.slice(0, 2)}`
  return `${prefix} ····${digits.slice(-4)}`
}

function sendHtml(res: ServerResponse, status: number, html: string, nonce: string, extra = {}) {
  res.writeHead(status, { ...PAGE_HEADERS, 'content-security-policy': csp(nonce), ...extra })
  res.end(html)
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const OAUTH_PATH = /^\/(?:api\/auth(?:\/|$)|\.well-known\/)/

/**
 * The browser-facing half of the authorization server (docs/design.md, "MCP and auth"): better-auth's own
 * endpoints and `.well-known` documents, the sign-in page and its status, and the consent page. `app.ts` hands it requests on `publicUrl`'s host only, so
 * tokens and metadata name one issuer; the webhook is not here and answers on any host.
 */
export function createAuthRoutes(o: AuthRoutesOptions): AuthRoutes {
  const { auth, sql, links, publicUrl } = o
  const secureCookie = publicUrl.startsWith('https:')
  const betterAuth = toNodeHandler(auth)
  const waNumber = o.displayNumber.replace(/\D/g, '')

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
    // Read through better-auth's own adapter, so a change of its table or columns cannot silently break this.
    const found = await (await auth.$context).adapter.findOne<{ name?: string | null }>({
      model: 'oauthClient',
      where: [{ field: 'clientId', value: clientId }],
    })
    const name = cleanName(found?.name ?? '') || host
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
    const link =
      (secret && (await links.current(secret, client))) || (await links.open(client, clientIp(req)))
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
    const { state, waId } = secret ? await links.state(secret) : { state: 'closed' as const }
    // Once confirmed the page asks whose account this is, and only the click on "Sí, continuar" finishes the sign-in:
    // a person who consented before is not asked again on the consent page, so this is where they see it.
    sendJson(res, 200, { state, ...(waId ? { account: maskNumber(waId) } : {}) })
  }

  /** "No es mía": closes this browser's sign-in. */
  async function signInCancel(req: IncomingMessage, res: ServerResponse) {
    const secret = cookie(req, LINK_COOKIE)
    // A page of ours, on our own origin, is the only caller: a form on another site cannot close it.
    if (req.headers.origin && req.headers.origin !== new URL(publicUrl).origin) {
      return sendJson(res, 403, { error: 'origin' })
    }
    if (secret) await links.cancel(secret)
    sendJson(res, 200, { state: 'closed' })
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
    // Who the sign-in is for, so a person whose code was hijacked sees a number that is not theirs.
    const address = await whatsappAddress(
      sql,
      Number((session.user as { warrenAccountId?: unknown }).warrenAccountId),
    )
    sendHtml(
      res,
      200,
      consentPage({
        nonce,
        client: await clientLabel(clientId),
        account: address ? maskNumber(address) : '',
        redirectHost,
        scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
      }),
      nonce,
    )
  }

  return async (req, res, url) => {
    const path = url.pathname
    const isPage =
      path === '/sign-in' ||
      path === '/sign-in/status' ||
      path === '/sign-in/cancel' ||
      path === '/oauth/consent'
    if (!isPage && !OAUTH_PATH.test(path)) return false
    if (path === '/sign-in' && req.method === 'GET') await signIn(req, res, url)
    else if (path === '/sign-in/status' && req.method === 'GET') await signInStatus(req, res)
    else if (path === '/sign-in/cancel' && req.method === 'POST') await signInCancel(req, res)
    else if (path === '/oauth/consent' && req.method === 'GET') await consent(req, res, url)
    else if (OAUTH_PATH.test(path)) await betterAuth(req, res)
    else res.writeHead(405, { allow: 'GET' }).end()
    return true
  }
}
