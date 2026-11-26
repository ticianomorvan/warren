import { createHash, randomBytes, randomInt } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { expect, vi } from 'vitest'
import { setup } from './test-harness'

/** Shared by the auth and MCP tests: a fake claude.ai (its client metadata document, PKCE, a cookie jar) and a fake Google. */

export const EMAIL_A = 'ana@example.test'
export const EMAIL_B = 'beto@example.test'
export const CLIENT_ID = 'https://claude.ai/oauth/warren-test.json'
export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
export const SCOPE = 'ledger:read ledger:write offline_access'
export const CLIENT = 'Claude (claude.ai)'

/** claude.ai's client metadata document, and a record of what was fetched. */
export function fakeClaude() {
  const fetched: string[] = []
  const fetchClient = async (input: string | URL | Request) => {
    const target = String(input)
    fetched.push(target)
    if (target !== CLIENT_ID) return new Response('not found', { status: 404 })
    return Response.json(
      {
        client_id: CLIENT_ID,
        client_name: 'Claude',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      { headers: { 'cache-control': 'max-age=3600' } },
    )
  }
  return { fetched, fetchClient }
}

const b64url = (b: Buffer) => b.toString('base64url')
export const pkce = () => {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

/** A browser: a cookie jar, and no redirects followed (each hop is asserted). `ip` is what Railway's edge would write in X-Real-IP. */
export function browser(
  base: string,
  ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`,
) {
  // Every browser has an address of its own unless a test says otherwise, as people do behind the edge.
  const edge = { 'x-real-ip': ip }
  const jar = new Map<string, string>()
  const take = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';')
      const [name = '', ...value] = pair.split('=')
      if (/max-age=0/i.test(c) || value.join('=') === '') jar.delete(name)
      else jar.set(name, value.join('='))
    }
    return res
  }
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  // A page load is a navigation (`sec-fetch-mode: navigate`, which fetch cannot send): better-auth then answers
  // with a redirect and not with JSON. Everything else is a script's fetch.
  const navigate = (path: string) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(path.startsWith('http') ? path : base + path)
      httpRequest(
        target,
        {
          headers: {
            accept: 'text/html',
            'sec-fetch-mode': 'navigate',
            ...edge,
            ...(cookie() ? { cookie: cookie() } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const headers = new Headers()
            for (const [k, v] of Object.entries(res.headers)) {
              for (const one of [v].flat()) if (one !== undefined) headers.append(k, one)
            }
            const empty = [204, 205, 304].includes(res.statusCode ?? 0)
            resolve(
              new Response(empty ? null : Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                headers,
              }),
            )
          })
        },
      )
        .on('error', reject)
        .end()
    }).then(take)
  const go = async (path: string, init: RequestInit = {}) =>
    init.method
      ? take(
          await fetch(path.startsWith('http') ? path : base + path, {
            redirect: 'manual',
            ...init,
            headers: {
              origin: base,
              ...edge,
              ...(cookie() ? { cookie: cookie() } : {}),
              ...init.headers,
            },
          }),
        )
      : navigate(path)
  const json = (path: string, body: unknown) =>
    go(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { go, json, jar }
}
export type Browser = ReturnType<typeof browser>
export type App = Awaited<ReturnType<typeof setup>>

export const authorizeUrl = (base: string, p: { challenge: string; clientId?: string }) =>
  `/api/auth/oauth2/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId ?? CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: SCOPE,
    state: 'state-1',
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    resource: `${base}/mcp`,
  })}`

export const location = (res: Response) => {
  const to = res.headers.get('location')
  if (!to) throw new Error(`no redirect: ${res.status}`)
  return new URL(to, 'http://x')
}

/** The app with a fake claude.ai and a fake Google behind it: everything a test needs to sign in for real. */
export const withClaude = (o: Parameters<typeof setup>[0] = {}) => {
  const claude = fakeClaude()
  const google = fakeGoogle()
  return setup({ ...o, fetchClient: claude.fetchClient }).then((app) => ({ app, claude, google }))
}

/**
 * A fake Google. Better-auth sends the browser to Google, which sends it back with a `code`; the server then trades the code at
 * Google's token endpoint for an ID token. Here the code *is* the email, and the token endpoint (the one fetch that leaves for
 * Google) answers with an unsigned ID token for it. Every other fetch goes where it was going.
 */
export function fakeGoogle() {
  const real = globalThis.fetch
  const traded: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input)
    if (!target.startsWith('https://oauth2.googleapis.com/token')) return real(input, init)
    const code = new URLSearchParams(String(init?.body ?? '')).get('code') ?? ''
    traded.push(code)
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const idToken = `${b64({ alg: 'none' })}.${b64({
      iss: 'https://accounts.google.com',
      aud: 'google-client-id',
      sub: `google-${code}`,
      email: code,
      email_verified: true,
      name: code.split('@')[0],
      iat: now,
      exp: now + 3600,
    })}.`
    return Response.json({
      access_token: 'google-access',
      refresh_token: 'google-refresh',
      id_token: idToken,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'openid email profile',
    })
  })
  return { traded, restore: () => vi.unstubAllGlobals() }
}

/**
 * "Continuar con Google": what the sign-in page's button does, then Google answering. `search` is the page's own query (an agent's
 * signed authorization) and continues that authorization; without it the browser lands on `/account`. Returns the callback's answer.
 */
export async function signInWithGoogle(
  b: Browser,
  o: { email: string; search?: string; callbackURL?: string },
) {
  const started = await b.json('/api/auth/sign-in/social', {
    provider: 'google',
    callbackURL: o.callbackURL ?? '/account',
    ...(o.search ? { oauth_query: o.search.slice(1) } : {}),
  })
  expect(started.status).toBe(200)
  const google = new URL(((await started.json()) as { url: string }).url)
  expect(google.origin).toBe('https://accounts.google.com')
  const state = google.searchParams.get('state') ?? ''
  // Google sends the browser back to us with the code (here, the email).
  return b.go(`/api/auth/callback/google?${new URLSearchParams({ code: o.email, state })}`)
}

/** The first leg: authorize, and the sign-in page it sends the browser to. */
export async function openSignIn(b: Browser, base: string, challenge: string) {
  const authorize = await b.go(authorizeUrl(base, { challenge }))
  expect(authorize.status).toBe(302)
  const to = location(authorize)
  expect(to.pathname).toBe('/sign-in')
  const page = await b.go(to.pathname + to.search)
  return { page, html: await page.text(), search: to.search }
}

export const token = (b: Browser, form: Record<string, string>) =>
  b.go('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })

export const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString())

/** Signs in with Google and finishes the consent. Returns the redirect back to the client (with the code). */
export async function connect(app: App, b: Browser, p: { challenge: string; email?: string }) {
  const { search } = await openSignIn(b, app.base, p.challenge)
  const back = await signInWithGoogle(b, { email: p.email ?? EMAIL_A, search })
  // The callback resumes the authorization: it ends at the consent page, or, for a person who consented to this client before,
  // straight back at the client.
  expect(back.status).toBe(302)
  const consent = location(back)
  if (consent.pathname !== '/oauth/consent') return consent
  const granted = await b.json('/api/auth/oauth2/consent', {
    accept: true,
    oauth_query: consent.search.slice(1),
  })
  return new URL(((await granted.json()) as { url: string }).url)
}

/** What a connected client holds: the browser that signed in (its session cookie) and the tokens. */
export interface Connected {
  b: Browser
  access_token: string
  refresh_token: string
  /** The `auth_user` this person is. */
  userId: string
}

/** The whole real flow for `email` (Google sign-in, consent, code, token): a real access token. */
export async function mint(app: App, email = EMAIL_A): Promise<Connected> {
  const b = browser(app.base)
  const { verifier, challenge } = pkce()
  const back = await connect(app, b, { challenge, email })
  const issued = await token(b, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code') ?? '',
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource: `${app.base}/mcp`,
  })
  expect(issued.status).toBe(200)
  const tokens = (await issued.json()) as { access_token: string; refresh_token: string }
  const sub = claims(tokens.access_token).sub as string
  return { b, ...tokens, userId: sub }
}
