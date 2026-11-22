import { createHash, randomBytes, randomInt } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { expect } from 'vitest'
import { bodies, messageBody, post, row, setup, until } from './test-harness'
import { REPLY_LINK } from './whatsapp/replies'

/** Shared by the auth and MCP tests: a fake claude.ai (its client metadata document, PKCE, a cookie jar) and the sign-in by WhatsApp. */

export const WA_A = '5491100000001'
export const WA_B = '5491100000002'
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

export const withClaude = (o: Parameters<typeof setup>[0] = {}) => {
  const claude = fakeClaude()
  return setup({ ...o, auth: { fetchClient: claude.fetchClient } }).then((app) => ({ app, claude }))
}

/**
 * What WhatsApp sends when `from` writes `text`; waits until the message is settled (`done` or `ignored`: a message that
 * fails is a test that should say so, unless it opts in with `allowFailed`). Returns Warren's replies.
 */
export async function whatsapp(
  app: App,
  from: string,
  text: string,
  o: { allowFailed?: boolean } = {},
) {
  const wamid = `wamid.AUTH${Math.random().toString(36).slice(2)}`
  const before = app.calls.sent.length
  await post(app.base, messageBody(wamid, from, { text: { body: text } }))
  const settled = o.allowFailed ? ['done', 'ignored', 'failed'] : ['done', 'ignored']
  await until(async () => settled.includes(String((await row(wamid))?.status))).catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await row(wamid))}`)
  })
  return bodies(app.calls).slice(before)
}

/** The first leg: authorize, and the sign-in page it sends the browser to. */
export async function openSignIn(b: Browser, base: string, challenge: string) {
  const authorize = await b.go(authorizeUrl(base, { challenge }))
  expect(authorize.status).toBe(302)
  const to = location(authorize)
  expect(to.pathname).toBe('/sign-in')
  const page = await b.go(to.pathname + to.search)
  const html = await page.text()
  return { page, html, search: to.search, code: /<b>([A-Z0-9]{6})<\/b>/.exec(html)?.[1] ?? '' }
}

export const status = async (b: Browser) =>
  ((await (await b.go('/sign-in/status')).json()) as { state: string }).state

export const complete = (b: Browser, search: string) =>
  b.json('/api/auth/warren/link/complete', { oauth_query: search.slice(1) })

/** Sends the code, answers "sí", finishes the sign-in and the consent. Returns the redirect back to the client. */
export async function connect(app: App, b: Browser, p: { challenge: string; from?: string }) {
  const { code, search } = await openSignIn(b, app.base, p.challenge)
  const from = p.from ?? WA_A
  expect((await whatsapp(app, from, `vincular ${code}`))[0]).toBe(REPLY_LINK.ask(CLIENT))
  expect((await whatsapp(app, from, 'sí'))[0]).toBe(REPLY_LINK.done(CLIENT))
  const done = await complete(b, search)
  expect(done.status).toBe(200)
  const consent = new URL(((await done.json()) as { url: string }).url, app.base)
  expect(consent.pathname).toBe('/oauth/consent')
  const granted = await b.json('/api/auth/oauth2/consent', {
    accept: true,
    oauth_query: consent.search.slice(1),
  })
  return new URL(((await granted.json()) as { url: string }).url)
}

export const token = (b: Browser, form: Record<string, string>) =>
  b.go('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })

export const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString())

/** What a connected client holds: the browser that signed in (its session cookie) and the tokens. */
export interface Connected {
  b: Browser
  access_token: string
  refresh_token: string
  /** The `auth_user` this person is. */
  userId: string
}

/** The whole real flow for `from` (sign-in on WhatsApp, consent, code, token): a real access token. */
export async function mint(app: App, from = WA_A): Promise<Connected> {
  const b = browser(app.base)
  const { verifier, challenge } = pkce()
  const back = await connect(app, b, { challenge, from })
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
