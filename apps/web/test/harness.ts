import { createHash, randomBytes } from 'node:crypto'
import { signupPolicy } from '@warren/core'
import { authSchema } from '@warren/db'
import { testDatabase } from '@warren/db/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { expect } from 'vitest'
import { createAuth, LEDGER_READ_SCOPE, mcpResourceUrl } from '../lib/auth-config'
import { createMcpRoute } from '../lib/mcp'

export const BASE = 'http://localhost:3000'
export const RESOURCE = mcpResourceUrl(BASE)
export const PASSWORD = 'a long enough password'
export const CLAIMS_CLIENT = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

export let t: Awaited<ReturnType<typeof testDatabase>>
export let auth: ReturnType<typeof createAuth>
export let mcp: (request: Request) => Promise<Response>

/** Every URL the server tried to fetch as a client's metadata document. */
export const fetched: string[] = []

/** A client's metadata document, as claude.ai serves its own (public client, no secret). */
export const document = (clientId: string, redirectUris: string[]) => ({
  client_id: clientId,
  client_name: 'Claude',
  redirect_uris: redirectUris,
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
})
export const DOCUMENTS: Record<string, unknown> = {
  [CLAIMS_CLIENT]: document(CLAIMS_CLIENT, [
    CLAUDE_CALLBACK,
    'http://localhost/callback',
    'http://127.0.0.1/callback',
  ]),
}
const fakeFetch = async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input)
  fetched.push(url)
  const body = DOCUMENTS[url]
  return body
    ? Response.json(body, { headers: { 'cache-control': 'max-age=60' } })
    : new Response('not found', { status: 404 })
}

export const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
  await t.pg.exec('reset role')
  try {
    return await fn()
  } finally {
    await t.pg.exec('set role warren_auth')
  }
}

export const b64url = (b: Buffer) => b.toString('base64url')
export const pkce = () => {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

let users = 0
let requests = 0
/** A new user, signed in: the user id and the cookie a browser would send. */
export async function signedInUser() {
  const email = `user${++users}@example.com`
  const { user } = await auth.api.signUpEmail({ body: { name: 'Ana', email, password: PASSWORD } })
  const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true })
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  return { id: user.id, email, cookie }
}

export const api = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const { cookie, ...rest } = init
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      ...rest,
      headers: {
        origin: BASE,
        'x-forwarded-for': `10.0.${Math.floor(++requests / 250)}.${requests % 250}`,
        ...(cookie ? { cookie } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
      redirect: 'manual',
    }),
  )
}

export type Authorize = {
  clientId?: string
  redirectUri?: string
  challenge?: string | null
  challengeMethod?: string
  scope?: string
  resource?: string
}
export const authorizeUrl = (o: Authorize, challenge: string) => {
  const q = new URLSearchParams({
    client_id: o.clientId ?? CLAIMS_CLIENT,
    redirect_uri: o.redirectUri ?? CLAUDE_CALLBACK,
    response_type: 'code',
    scope: o.scope ?? `${LEDGER_READ_SCOPE} offline_access`,
    state: 'st4te',
    resource: o.resource ?? RESOURCE,
  })
  if (o.challenge !== null) {
    q.set('code_challenge', o.challenge ?? challenge)
    q.set('code_challenge_method', o.challengeMethod ?? 'S256')
  }
  return `/oauth2/authorize?${q}`
}

/** Authorize, then consent, as a browser would: returns the redirect that carries the code. */
export async function authorizeAndConsent(cookie: string, o: Authorize = {}) {
  const { verifier, challenge } = pkce()
  const first = await api(authorizeUrl(o, challenge), { cookie })
  const location = new URL(first.headers.get('location') ?? 'http://none.invalid/', BASE)
  return { first, location, verifier, cookie }
}

export async function consent(cookie: string, location: URL, accept = true) {
  const res = await api('/oauth2/consent', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
  })
  return (await res.json()) as { redirect?: boolean; url?: string; error?: string }
}

export const token = (form: Record<string, string>) =>
  api('/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })

export type Tokens = {
  access_token: string
  refresh_token?: string
  scope?: string
  expires_in?: number
}

/** The whole flow: authorize, consent, redeem the code. */
export async function connect(
  user: { cookie: string },
  o: Authorize & { redirectUri?: string } = {},
): Promise<Tokens & { verifier: string }> {
  const { location, verifier } = await authorizeAndConsent(user.cookie, o)
  // A person who already consented goes straight back to the client with a code.
  const back =
    location.pathname === '/oauth/consent'
      ? (await consent(user.cookie, location)).url
      : location.href
  const code = new URL(back ?? 'http://none.invalid/').searchParams.get('code')
  expect(code).toBeTruthy()
  const res = await token({
    grant_type: 'authorization_code',
    code: code ?? '',
    redirect_uri: o.redirectUri ?? CLAUDE_CALLBACK,
    client_id: o.clientId ?? CLAIMS_CLIENT,
    code_verifier: verifier,
    resource: o.resource ?? RESOURCE,
  })
  expect(res.status).toBe(200)
  return { ...((await res.json()) as Tokens), verifier }
}

export const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
}
export const callMcp = (bearer: string | null, body: unknown = INITIALIZE) =>
  mcp(
    new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  )

/** The in-process database, Better Auth and `/api/mcp` route, as every OAuth test needs them. */
export async function setup(now?: () => Date) {
  t = await testDatabase()
  // Every statement of Better Auth runs as warren_auth, so a missing grant fails a test.
  await t.pg.exec('set role warren_auth')
  auth = createAuth({
    db: drizzle(t.pg, { schema: authSchema }),
    secret: 'test-secret-test-secret-test-secret-0',
    baseURL: BASE,
    signup: signupPolicy(
      Array.from({ length: 80 }, (_, i) => `user${i + 1}@example.com`).join(','),
    ),
    onUserCreated: async () => {},
    fetchClientMetadataResource: fakeFetch,
  })
  mcp = createMcpRoute({
    auth,
    authDatabase: t.auth,
    database: t.app,
    resource: RESOURCE,
    ...(now ? { now } : {}),
  })
}
