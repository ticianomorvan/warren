import type { IncomingMessage, ServerResponse } from 'node:http'
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import type { Sql } from '../core/db'
import { sendHtml, sendJson } from '../web/send'
import {
  disconnectAgents,
  ensureAccount,
  eraseAccount,
  exportAccount,
  FRESH_SIGN_IN_MS,
  isFreshSignIn,
} from './account'
import type { Auth } from './config'
import { accountPage, consentPage, messagePage, signInPage } from './pages'

/** How a client is shown to the person. */
export interface ClientLabel {
  name: string
  /** Where it comes from: its metadata document's host, or for a self-registered client the host it sends the person back to. */
  host: string
  verified: boolean
  redirectHost: string
}

/** One line for a page that has no room for more: "Name (host)", and "no verificado" when the client registered itself. */
export const clientText = (c: ClientLabel): string =>
  `${c.name}${c.host && c.host !== c.name ? ` (${c.host})` : ''}${c.verified ? '' : ' (no verificado)'}`

export interface AuthRoutesOptions {
  auth: Auth
  sql: Sql
  /** `https://heywarren.app`: the only host these routes answer on. */
  publicUrl: string
  /** The clock of the fresh-sign-in check; a test moves it. */
  now?: () => Date
}

/** Serves what the authorization server needs besides better-auth's own endpoints; false when the path is not one of its. */
export type AuthRoutes = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>

/** What a client calls itself, safe to show: no control or formatting characters, short. */
export function cleanName(s: string): string {
  const name = s
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[\p{Cf}*_~`<>]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return name.length > 40 ? `${name.slice(0, 39).trimEnd()}…` : name
}

/**
 * The `Set-Cookie` lines that end the browser's session, made by better-auth itself (its own names and attributes: under https the
 * name has the `__Secure-` prefix and the cookie must be `Secure`, or the browser ignores the deletion).
 */
export async function clearedCookies(
  auth: Auth,
  headers: IncomingMessage['headers'],
): Promise<string[]> {
  const out = await auth.api.signOut({ headers: fromNodeHeaders(headers), asResponse: true })
  return out.headers.getSetCookie()
}

const OAUTH_PATH = /^\/(?:api\/auth(?:\/|$)|\.well-known\/)/
const PAGES = new Set(['/sign-in', '/oauth/consent', '/account'])
const ACTIONS = new Set(['/account/disconnect', '/account/delete', '/account/export'])

/**
 * The browser-facing half of the authorization server (docs/design.md, "Auth"): better-auth's own endpoints and `.well-known`
 * documents, the sign-in page ("Continuar con Google"), the consent page and the account page with what it does (disconnect all
 * agents, download all data, delete the account). `app.ts` hands it requests on `publicUrl`'s host only, so tokens and metadata name
 * one issuer.
 */
export function createAuthRoutes(o: AuthRoutesOptions): AuthRoutes {
  const { auth, sql, publicUrl } = o
  const now = o.now ?? (() => new Date())
  const betterAuth = toNodeHandler(auth)
  const origin = new URL(publicUrl).origin

  async function verified(query: string): Promise<URLSearchParams | null> {
    if (!query || !(await verifyOAuthQueryParams(query, (await auth.$context).secret))) return null
    return new URLSearchParams(query)
  }

  /**
   * How a client is shown: its own name, and where it came from. A client with a metadata document (CIMD) has its document's https
   * URL as its id, so its host is that of the document. A client that registered itself (DCR) chose its own name, so it is shown as
   * unverified and with the host it sends the person back to.
   */
  async function clientLabel(clientId: string, redirectUri: string | null): Promise<ClientLabel> {
    let documentHost = ''
    try {
      const url = new URL(clientId)
      if (url.protocol === 'https:') documentHost = url.hostname
    } catch {}
    let redirectHost = ''
    try {
      redirectHost = new URL(redirectUri ?? '').host
    } catch {}
    // Read through better-auth's own adapter, so a change of its table or columns cannot silently break this.
    const found = await (await auth.$context).adapter.findOne<{ name?: string | null }>({
      model: 'oauthClient',
      where: [{ field: 'clientId', value: clientId }],
    })
    const verified = documentHost !== ''
    const host = verified ? documentHost : redirectHost
    const name = cleanName(found?.name ?? '') || host || 'Un agente'
    return { name, host, verified, redirectHost }
  }

  /** The signed-in person: their account and sign-in time, or null. */
  async function whoIs(req: IncomingMessage) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) return null
    let accountId = Number((session.user as { warrenAccountId?: unknown }).warrenAccountId)
    // A user whose account was never made (its create hook failed) is repaired here.
    if (!Number.isSafeInteger(accountId) || accountId < 1) {
      accountId = (await ensureAccount(sql, session.user.id)) ?? 0
    }
    if (accountId < 1) return null
    return {
      accountId,
      email: session.user.email,
      signedInAt: new Date(session.session.createdAt),
    }
  }

  async function signIn(res: ServerResponse, url: URL) {
    const query = url.search.slice(1)
    if (!query) {
      // Opened by hand, not by an agent: it leads to the account page.
      return sendHtml(res, 200, (nonce) => signInPage({ nonce, client: '', next: '/account' }))
    }
    const params = await verified(query)
    const clientId = params?.get('client_id')
    if (!params || !clientId) {
      return sendHtml(res, 400, (nonce) =>
        messagePage(
          nonce,
          'Esta página se abre desde tu agente',
          'Volvé a tu agente y tocá conectar.',
        ),
      )
    }
    // The agent's authorization continues after Google (better-auth resumes it from the signed query); `next` is only the fallback.
    const client = clientText(await clientLabel(clientId, params.get('redirect_uri')))
    sendHtml(res, 200, (nonce) => signInPage({ nonce, client, next: '/account' }))
  }

  async function consent(req: IncomingMessage, res: ServerResponse, url: URL) {
    const params = await verified(url.search.slice(1))
    const who = await whoIs(req)
    const clientId = params?.get('client_id')
    if (!params || !clientId || !who) {
      return sendHtml(res, 401, (nonce) =>
        messagePage(nonce, 'La conexión venció', 'Volvé a tu agente y tocá conectar de nuevo.'),
      )
    }
    const client = await clientLabel(clientId, params.get('redirect_uri'))
    sendHtml(res, 200, (nonce) =>
      consentPage({
        nonce,
        client: client.name,
        clientHost: client.host,
        verified: client.verified,
        account: who.email,
        redirectHost: client.redirectHost,
        scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
      }),
    )
  }

  async function account(req: IncomingMessage, res: ServerResponse) {
    const who = await whoIs(req)
    if (!who) {
      return sendHtml(res, 200, (nonce) => signInPage({ nonce, client: '', next: '/account' }))
    }
    const fresh = isFreshSignIn(who.signedInAt, now())
    sendHtml(res, 200, (nonce) => accountPage({ nonce, email: who.email, fresh }))
  }

  /** The three things the account page does. Each acts on the signed-in session's own account, and the writes only from our own page. */
  async function action(req: IncomingMessage, res: ServerResponse, path: string) {
    const isExport = path === '/account/export'
    if (isExport ? req.method !== 'GET' : req.method !== 'POST') {
      return void res.writeHead(405, { allow: isExport ? 'GET' : 'POST' }).end()
    }
    // A form on another site cannot make these: the browser sends its own origin with a POST.
    if (!isExport && req.headers.origin !== origin) return sendJson(res, 403, { error: 'origin' })
    const who = await whoIs(req)
    if (!who) return sendJson(res, 401, { error: 'sign_in_required' })
    if (path === '/account/export') {
      const data = await exportAccount(sql, who.accountId)
      return sendJson(res, 200, data, {
        'content-disposition': 'attachment; filename="warren.json"',
      })
    }
    if (path === '/account/disconnect') {
      await disconnectAgents(sql, who.accountId)
      return sendJson(res, 200, { ok: true })
    }
    // Delete: only behind a fresh sign-in, so an old session left open cannot erase everything.
    if (!isFreshSignIn(who.signedInAt, now())) {
      return sendJson(res, 403, { error: 'fresh_sign_in_required', within_ms: FRESH_SIGN_IN_MS })
    }
    await eraseAccount(sql, who.accountId)
    return sendJson(
      res,
      200,
      { ok: true },
      {
        // The session rows went with the account; the browser's cookie would only point at nothing.
        'set-cookie': await clearedCookies(auth, req.headers),
      },
    )
  }

  return async (req, res, url) => {
    const path = url.pathname
    const isPage = PAGES.has(path)
    if (!isPage && !ACTIONS.has(path) && !OAUTH_PATH.test(path)) return false
    if (path === '/sign-in' && req.method === 'GET') await signIn(res, url)
    else if (path === '/oauth/consent' && req.method === 'GET') await consent(req, res, url)
    else if (path === '/account' && req.method === 'GET') await account(req, res)
    else if (ACTIONS.has(path)) await action(req, res, path)
    else if (OAUTH_PATH.test(path)) await betterAuth(req, res)
    else res.writeHead(405, { allow: 'GET' }).end()
    return true
  }
}
