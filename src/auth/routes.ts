import type { IncomingMessage, ServerResponse } from 'node:http'
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import type { Sql } from '../core/db'
import { newNonce, sendHtml, sendJson } from '../web/send'
import {
  disconnectAgents,
  eraseAccount,
  exportAccount,
  FRESH_SIGN_IN_MS,
  isFreshSignIn,
} from './account'
import type { Auth } from './config'
import { accountPage, consentPage, messagePage, signInPage } from './pages'

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

  /** What to call the client in the page: its own name, and the host its id lives on. */
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

  /** The signed-in person: their account and sign-in time, or null. */
  async function whoIs(req: IncomingMessage) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    const accountId = Number(
      (session?.user as { warrenAccountId?: unknown } | undefined)?.warrenAccountId,
    )
    if (!session || !Number.isSafeInteger(accountId) || accountId < 1) return null
    return {
      accountId,
      email: session.user.email,
      signedInAt: new Date(session.session.createdAt),
    }
  }

  async function signIn(res: ServerResponse, url: URL) {
    const nonce = newNonce()
    const query = url.search.slice(1)
    if (!query) {
      // Opened by hand, not by an agent: it leads to the account page.
      return sendHtml(res, 200, signInPage({ nonce, client: '', next: '/account' }), nonce)
    }
    const params = await verified(query)
    const clientId = params?.get('client_id')
    if (!params || !clientId) {
      return sendHtml(
        res,
        400,
        messagePage(
          nonce,
          'Esta página se abre desde tu agente',
          'Volvé a tu agente y tocá conectar.',
        ),
        nonce,
      )
    }
    // The agent's authorization continues after Google (better-auth resumes it from the signed query); `next` is only the fallback.
    sendHtml(
      res,
      200,
      signInPage({ nonce, client: await clientLabel(clientId), next: '/account' }),
      nonce,
    )
  }

  async function consent(req: IncomingMessage, res: ServerResponse, url: URL) {
    const nonce = newNonce()
    const params = await verified(url.search.slice(1))
    const who = await whoIs(req)
    const clientId = params?.get('client_id')
    if (!params || !clientId || !who) {
      return sendHtml(
        res,
        401,
        messagePage(nonce, 'La conexión venció', 'Volvé a tu agente y tocá conectar de nuevo.'),
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
        account: who.email,
        redirectHost,
        scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
      }),
      nonce,
    )
  }

  async function account(req: IncomingMessage, res: ServerResponse) {
    const nonce = newNonce()
    const who = await whoIs(req)
    if (!who) {
      return sendHtml(res, 200, signInPage({ nonce, client: '', next: '/account' }), nonce)
    }
    sendHtml(
      res,
      200,
      accountPage({ nonce, email: who.email, fresh: isFreshSignIn(who.signedInAt, now()) }),
      nonce,
    )
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
        'set-cookie': `${(await auth.$context).authCookies.sessionToken.name}=; Max-Age=0; Path=/`,
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
