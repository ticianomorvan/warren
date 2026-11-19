import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import {
  oauthProviderAuthServerMetadata,
  verifyOAuthQueryParams,
} from '@better-auth/oauth-provider'
import { eraseUser } from '@warren/db'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { LEDGER_READ_SCOPE, mcpResourceUrl } from '../lib/auth-config'
import {
  api,
  asOwner,
  auth,
  authorizeAndConsent,
  BASE,
  b64url,
  CLAIMS_CLIENT,
  CLAUDE_CALLBACK,
  callMcp,
  claimsOf,
  connect,
  consent,
  DOCUMENTS,
  document,
  fetched,
  PASSWORD,
  RESOURCE,
  setup,
  signedInUser,
  type Tokens,
  t,
  token,
} from './harness'

beforeAll(() => setup())

describe('discovery documents', () => {
  it('the authorization server advertises CIMD, public clients, PKCE S256 and no registration', async () => {
    const res = await oauthProviderAuthServerMetadata(auth)(
      new Request(`${BASE}/.well-known/oauth-authorization-server`),
    )
    expect(res.status).toBe(200)
    const doc = await res.json()
    expect(doc).toMatchObject({
      issuer: `${BASE}/api/auth`,
      authorization_endpoint: `${BASE}/api/auth/oauth2/authorize`,
      token_endpoint: `${BASE}/api/auth/oauth2/token`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
    })
    expect(doc.token_endpoint_auth_methods_supported).toContain('none')
    expect(doc.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(doc.scopes_supported).toEqual(
      expect.arrayContaining([LEDGER_READ_SCOPE, 'offline_access']),
    )
    expect(doc.registration_endpoint).toBeUndefined()
  })

  it.each([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp',
  ])('the protected resource document at %s names the MCP URL exactly', async (path) => {
    const res = await auth.handler(new Request(`${BASE}${path}`))
    expect(res.status).toBe(200)
    const doc = await res.json()
    expect(doc.resource).toBe('http://localhost:3000/api/mcp')
    expect(doc.authorization_servers).toEqual([`${BASE}/api/auth`])
    expect(doc.scopes_supported).toEqual([LEDGER_READ_SCOPE])
  })

  it('builds the resource from the base URL, so a preview gets its own', () => {
    expect(mcpResourceUrl('https://heywarren.app')).toBe('https://heywarren.app/api/mcp')
    expect(mcpResourceUrl('https://warren-git-x.vercel.app/')).toBe(
      'https://warren-git-x.vercel.app/api/mcp',
    )
  })
})

describe('authorize, consent, token', () => {
  it('runs the whole flow for a metadata-document client, with PKCE, and the JWT opens /api/mcp', async () => {
    const user = await signedInUser()
    fetched.length = 0

    const { first, location, verifier } = await authorizeAndConsent(user.cookie)
    // The client has never been seen: its document is fetched, then the person is asked.
    expect(fetched).toEqual([CLAIMS_CLIENT])
    expect(first.status).toBe(302)
    expect(location.pathname).toBe('/oauth/consent')
    expect(location.searchParams.get('client_id')).toBe(CLAIMS_CLIENT)
    expect(location.searchParams.get('redirect_uri')).toBe(CLAUDE_CALLBACK)
    expect(location.searchParams.get('scope')).toBe(`${LEDGER_READ_SCOPE} offline_access`)

    const done = await consent(user.cookie, location)
    expect(done.redirect).toBe(true)
    const back = new URL(done.url ?? 'http://none.invalid/')
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK)
    expect(back.searchParams.get('state')).toBe('st4te')
    const code = back.searchParams.get('code') ?? ''

    // PKCE: the wrong verifier gets nothing, even with a good code.
    const wrong = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: CLAIMS_CLIENT,
      code_verifier: b64url(randomBytes(32)),
      resource: RESOURCE,
    })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' })

    // (The failed attempt may have spent the code; run the flow again for the good one.)
    const tokens = await connect(user)
    expect(tokens.scope).toBe(`${LEDGER_READ_SCOPE} offline_access`)
    expect(tokens.refresh_token).toBeTruthy()
    expect(tokens.expires_in).toBe(15 * 60)
    expect(verifier).toBeTruthy()

    const claims = claimsOf(tokens.access_token)
    expect(claims).toMatchObject({
      iss: `${BASE}/api/auth`,
      aud: RESOURCE,
      sub: user.id,
      azp: CLAIMS_CLIENT,
    })
    expect(String(claims.scope).split(' ')).toContain(LEDGER_READ_SCOPE)
    expect(Number(claims.exp) - Number(claims.iat)).toBe(15 * 60)

    // The route verifies the real JWT and answers an MCP initialize and a ping.
    const init = await callMcp(tokens.access_token)
    expect(init.status).toBe(200)
    expect(await init.text()).toContain('"serverInfo":{"name":"warren"')
    const ping = await callMcp(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'ping' })
    expect(ping.status).toBe(200)
    expect(await ping.text()).toContain('"id":2')
  })

  it('does not ask again once the person consented', async () => {
    const user = await signedInUser()
    await connect(user)
    const again = await authorizeAndConsent(user.cookie)
    expect(again.first.status).toBe(302)
    // Straight back to the client with a code, not to the consent page.
    expect(again.location.origin + again.location.pathname).toBe(CLAUDE_CALLBACK)
    expect(again.location.searchParams.get('code')).toBeTruthy()
  })

  it('answers Cancelar by sending the person back with access_denied', async () => {
    const user = await signedInUser()
    const { location } = await authorizeAndConsent(user.cookie)
    const done = await consent(user.cookie, location, false)
    const back = new URL(done.url ?? 'http://none.invalid/')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('code')).toBeNull()
  })

  it('sends a signed-out person to /sign-in with the signed query, which a sign-in then resumes', async () => {
    const user = await signedInUser()
    const first = await authorizeAndConsent('')
    expect(first.first.status).toBe(302)
    expect(first.location.pathname).toBe('/sign-in')
    expect(first.location.searchParams.get('sig')).toBeTruthy()

    // The sign-in form sends that query back; the response says where to go next.
    const res = await api('/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        email: user.email,
        password: PASSWORD,
        oauth_query: first.location.search.slice(1),
      }),
    })
    const body = (await res.json()) as { redirect?: boolean; url?: string }
    expect(body.redirect).toBe(true)
    expect(new URL(body.url ?? 'http://none.invalid/', BASE).pathname).toBe('/oauth/consent')
  })

  it('refuses an authorization request without PKCE, or with the plain method', async () => {
    const user = await signedInUser()
    for (const o of [{ challenge: null }, { challengeMethod: 'plain' }]) {
      const { first, location } = await authorizeAndConsent(user.cookie, o)
      expect(location.pathname).not.toBe('/oauth/consent')
      expect(location.searchParams.get('code')).toBeNull()
      expect(first.status).toBeLessThan(500)
    }
  })

  it('refuses a scope the server does not offer', async () => {
    const user = await signedInUser()
    const { location } = await authorizeAndConsent(user.cookie, { scope: 'ledger:write' })
    expect(location.pathname).not.toBe('/oauth/consent')
    expect(location.searchParams.get('code')).toBeNull()
  })

  it('refuses a resource that is not the MCP URL', async () => {
    const user = await signedInUser()
    const { location } = await authorizeAndConsent(user.cookie, {
      resource: 'https://other.example/mcp',
    })
    expect(location.searchParams.get('code')).toBeNull()
    expect(location.pathname).not.toBe('/oauth/consent')
  })
})

describe('redirects', () => {
  it.each(['localhost', '127.0.0.1'])(
    'accepts a loopback redirect on a random port (%s)',
    async (host) => {
      const user = await signedInUser()
      const port = 20000 + Math.floor(Math.random() * 40000)
      const redirectUri = `http://${host}:${port}/callback`
      const tokens = await connect(user, { redirectUri })
      expect(claimsOf(tokens.access_token).aud).toBe(RESOURCE)
    },
  )

  it('refuses a loopback redirect on a path the client did not register', async () => {
    const user = await signedInUser()
    const { location } = await authorizeAndConsent(user.cookie, {
      redirectUri: 'http://localhost:4545/somewhere-else',
    })
    expect(location.pathname).not.toBe('/oauth/consent')
    expect(location.searchParams.get('code')).toBeNull()
  })

  it('refuses a redirect to any other host', async () => {
    const user = await signedInUser()
    const { location } = await authorizeAndConsent(user.cookie, {
      redirectUri: 'https://evil.example/api/mcp/auth_callback',
    })
    expect(location.pathname).not.toBe('/oauth/consent')
    expect(location.host).not.toBe('evil.example')
  })
})

describe('refresh tokens', () => {
  it('rotate: the new one works and the old one is rejected', async () => {
    const user = await signedInUser()
    const first = await connect(user)
    const refresh = (value: string) =>
      token({
        grant_type: 'refresh_token',
        refresh_token: value,
        client_id: CLAIMS_CLIENT,
        resource: RESOURCE,
      })

    const res = await refresh(first.refresh_token ?? '')
    expect(res.status).toBe(200)
    const second = (await res.json()) as Tokens
    expect(second.refresh_token).toBeTruthy()
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(claimsOf(second.access_token)).toMatchObject({ aud: RESOURCE, sub: user.id })
    expect((await callMcp(second.access_token)).status).toBe(200)

    const replay = await refresh(first.refresh_token ?? '')
    expect(replay.status).toBe(400)
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' })
  })
})

describe('which clients may connect', () => {
  it.each([
    'https://evil.example/oauth/client.json',
    'https://claude.ai.evil.example/oauth/client.json',
    'https://evilclaude.ai/oauth/client.json',
    'http://claude.ai/oauth/client.json',
    'https://claude.ai@evil.example/oauth/client.json',
    'https://169.254.169.254/latest/meta-data',
  ])('rejects %s before any fetch', async (clientId) => {
    DOCUMENTS[clientId] = document(clientId, [CLAUDE_CALLBACK])
    const user = await signedInUser()
    fetched.length = 0
    const { location } = await authorizeAndConsent(user.cookie, { clientId })
    expect(fetched).toEqual([])
    expect(location.pathname).not.toBe('/oauth/consent')
    expect(location.searchParams.get('code')).toBeNull()
  })

  it('accepts claude.com, which is on the list', async () => {
    const clientId = 'https://claude.com/oauth/client.json'
    DOCUMENTS[clientId] = document(clientId, ['https://claude.com/callback'])
    const user = await signedInUser()
    fetched.length = 0
    const { location } = await authorizeAndConsent(user.cookie, {
      clientId,
      redirectUri: 'https://claude.com/callback',
    })
    expect(fetched).toEqual([clientId])
    expect(location.pathname).toBe('/oauth/consent')
  })

  it('has no dynamic client registration', async () => {
    const res = await api('/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://evil.example/cb'],
        token_endpoint_auth_method: 'none',
      }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('/api/mcp', () => {
  const metadata = `${BASE}/.well-known/oauth-protected-resource/api/mcp`

  it('answers 401 with the resource metadata challenge when there is no token', async () => {
    const res = await callMcp(null)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${metadata}"`)
  })

  it('answers 401 to a token that is not a JWT of this server', async () => {
    const res = await callMcp('not.a.jwt')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${metadata}"`)
  })

  const signed = (payload: Record<string, unknown>, audience: string) =>
    auth.api
      .signJWT({
        body: {
          payload,
          overrideOptions: { jwt: { issuer: `${BASE}/api/auth`, audience, expirationTime: '5m' } },
        },
      })
      .then((r) => r.token)

  it('lets a hand-signed token with the right issuer, audience and scope in (the control for the next ones)', async () => {
    const user = await signedInUser()
    const jwt = await signed(
      { sub: user.id, azp: CLAIMS_CLIENT, scope: LEDGER_READ_SCOPE },
      RESOURCE,
    )
    expect((await callMcp(jwt)).status).toBe(200)
  })

  it('answers 401 to a valid token minted for another audience', async () => {
    const user = await signedInUser()
    const jwt = await signed(
      { sub: user.id, azp: CLAIMS_CLIENT, scope: LEDGER_READ_SCOPE },
      'https://other.example/mcp',
    )
    const res = await callMcp(jwt)
    expect(res.status).toBe(401)
  })

  it('answers 403 to a token for this resource that lacks the scope', async () => {
    const user = await signedInUser()
    const jwt = await signed(
      { sub: user.id, azp: CLAIMS_CLIENT, scope: 'offline_access' },
      RESOURCE,
    )
    const res = await callMcp(jwt)
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope')
  })

  it('answers 401 to an expired token', async () => {
    const user = await signedInUser()
    const jwt = await auth.api
      .signJWT({
        body: {
          payload: {
            sub: user.id,
            azp: CLAIMS_CLIENT,
            scope: LEDGER_READ_SCOPE,
            exp: Math.floor(Date.now() / 1000) - 60,
          },
          overrideOptions: { jwt: { issuer: `${BASE}/api/auth`, audience: RESOURCE } },
        },
      })
      .then((r) => r.token)
    expect((await callMcp(jwt)).status).toBe(401)
  })

  it('answers 401 to a token whose sub is not a user', async () => {
    const jwt = await signed(
      { sub: '00000000-0000-4000-8000-000000000000', azp: CLAIMS_CLIENT, scope: LEDGER_READ_SCOPE },
      RESOURCE,
    )
    expect((await callMcp(jwt)).status).toBe(401)
  })

  it('answers 401 to a still-valid token of an erased user, and erasure deletes their tokens and consents', async () => {
    const user = await signedInUser()
    const tokens = await connect(user)
    expect((await callMcp(tokens.access_token)).status).toBe(200)

    const count = (table: string) =>
      asOwner(
        async () =>
          (
            await t.pg.query<{ n: number }>(
              `select count(*)::int as n from ${table} where user_id = $1`,
              [user.id],
            )
          ).rows[0]?.n,
      )
    expect(await count('oauth_refresh_token')).toBeGreaterThan(0)
    expect(await count('oauth_consent')).toBeGreaterThan(0)

    await eraseUser({ eraser: t.eraser, auth: t.auth }, user.id, { deletePrefix: async () => 0 })

    const res = await callMcp(tokens.access_token)
    expect(res.status).toBe(401)
    const challenge = res.headers.get('www-authenticate') ?? ''
    expect(challenge).toContain('error="invalid_token"')
    expect(challenge).toContain(`resource_metadata="${metadata}"`)
    expect(await count('oauth_refresh_token')).toBe(0)
    expect(await count('oauth_consent')).toBe(0)
    // And the refresh token is gone with the rest: nothing can renew it.
    const renewed = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token ?? '',
      client_id: CLAIMS_CLIENT,
      resource: RESOURCE,
    })
    expect(renewed.status).toBe(400)
  })

  it('keeps the signing key private: jwks serves the public half only, and the table holds it sealed', async () => {
    const res = await api('/jwks')
    const body = (await res.json()) as { keys: Record<string, unknown>[] }
    expect(body.keys.length).toBeGreaterThan(0)
    for (const key of body.keys) expect(key.d).toBeUndefined()
    const { rows } = await asOwner(() =>
      t.pg.query<{ private_key: string }>('select private_key from jwks'),
    )
    for (const row of rows) expect(row.private_key).not.toContain('"d"')
  })
})

describe('what a signed-in user cannot do', () => {
  it('cannot register, edit, list, rotate or delete a client, over HTTP or the API', async () => {
    const user = await signedInUser()
    const json = { 'content-type': 'application/json' }
    const calls: [string, string, unknown][] = [
      [
        'POST',
        '/oauth2/create-client',
        { redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' },
      ],
      [
        'POST',
        '/oauth2/update-client',
        { client_id: CLAIMS_CLIENT, update: { redirect_uris: ['https://evil.example/cb'] } },
      ],
      ['POST', '/oauth2/delete-client', { client_id: CLAIMS_CLIENT }],
      ['GET', '/oauth2/get-clients', undefined],
      ['POST', '/oauth2/client/rotate-secret', { client_id: CLAIMS_CLIENT }],
      ['POST', '/oauth2/register', { redirect_uris: ['https://evil.example/cb'] }],
      ['POST', '/oauth2/update-consent', { id: 'x', update: { scopes: ['ledger:read'] } }],
      ['POST', '/oauth2/delete-consent', { id: 'x' }],
    ]
    for (const [method, path, body] of calls) {
      const res = await api(path, {
        method,
        cookie: user.cookie,
        headers: json,
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      expect([401, 403, 404], `${method} ${path}`).toContain(res.status)
    }
    // Past the HTTP block, the plugin's own check refuses too.
    const headers = new Headers({ cookie: user.cookie, origin: BASE })
    await expect(
      auth.api.createOAuthClient({
        headers,
        body: { redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' },
      }),
    ).rejects.toBeTruthy()
    const { rows } = await asOwner(() =>
      t.pg.query<{ n: number }>(
        `select count(*)::int as n from oauth_client where client_id not like 'https://claude.%'`,
      ),
    )
    expect(rows[0]?.n).toBe(0)
  })

  it('gives a metadata-document client no owner, so erasure has no client row to delete', async () => {
    const user = await signedInUser()
    await connect(user)
    const { rows } = await asOwner(() =>
      t.pg.query<{ user_id: string | null }>('select user_id from oauth_client'),
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.user_id).toBeNull()
  })

  it('has no session JWT: /token is 404 and get-session sets no set-auth-jwt header', async () => {
    const user = await signedInUser()
    expect((await api('/token', { cookie: user.cookie })).status).toBe(404)
    const session = await api('/get-session', { cookie: user.cookie })
    expect(session.status).toBe(200)
    expect(session.headers.get('set-auth-jwt')).toBeNull()
  })

  it('serves the authorization server document at the issuer-path URL too', async () => {
    const res = await auth.handler(
      new Request(`${BASE}/.well-known/oauth-authorization-server/api/auth`),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).client_id_metadata_document_supported).toBe(true)
  })
})

describe('the consent page verifies its link', () => {
  const secret = 'test-secret-test-secret-test-secret-0'
  afterEach(() => vi.useRealTimers())

  const link = async () => {
    const user = await signedInUser()
    const { location } = await authorizeAndConsent(user.cookie)
    expect(location.pathname).toBe('/oauth/consent')
    return location.searchParams
  }

  it('accepts the link as the server made it', async () => {
    expect(await verifyOAuthQueryParams((await link()).toString(), secret)).toBe(true)
  })

  it('refuses a changed client_id, a changed redirect_uri, an added parameter and a wrong secret', async () => {
    const original = await link()
    const changed = (edit: (q: URLSearchParams) => void) => {
      const q = new URLSearchParams(original)
      edit(q)
      return q.toString()
    }
    for (const query of [
      changed((q) => q.set('client_id', 'https://claude.ai/oauth/other.json')),
      changed((q) => q.set('redirect_uri', 'https://evil.example/cb')),
      changed((q) => q.append('extra', 'x')),
      changed((q) => q.set('scope', 'ledger:read ledger:write')),
      changed((q) => q.set('exp', String(Number(q.get('exp')) + 3600))),
    ]) {
      expect(await verifyOAuthQueryParams(query, secret)).toBe(false)
    }
    expect(await verifyOAuthQueryParams(original.toString(), `${secret}x`)).toBe(false)
  })

  it('refuses a link past its expiry', async () => {
    const original = (await link()).toString()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    expect(await verifyOAuthQueryParams(original, secret)).toBe(false)
  })
})

describe('tokens that are not ours', () => {
  it('answers 401 to a token with the right audience from another issuer', async () => {
    const user = await signedInUser()
    const jwt = await auth.api
      .signJWT({
        body: {
          payload: { sub: user.id, azp: CLAIMS_CLIENT, scope: LEDGER_READ_SCOPE },
          overrideOptions: {
            jwt: { issuer: 'https://evil.example', audience: RESOURCE, expirationTime: '5m' },
          },
        },
      })
      .then((r) => r.token)
    expect((await callMcp(jwt)).status).toBe(401)
  })

  it('answers 401 to a token signed with another key, under the real key id', async () => {
    const user = await signedInUser()
    const real = await auth.api.signJWT({
      body: {
        payload: { sub: user.id, azp: CLAIMS_CLIENT, scope: LEDGER_READ_SCOPE },
        overrideOptions: {
          jwt: { issuer: `${BASE}/api/auth`, audience: RESOURCE, expirationTime: '5m' },
        },
      },
    })
    const [head, body] = real.token.split('.')
    const header = JSON.parse(Buffer.from(head ?? '', 'base64url').toString()) as { alg: string }
    const { privateKey } = generateKeyPairSync('ed25519')
    const forged = `${head}.${body}`
    const signature = sign(null, Buffer.from(forged), privateKey).toString('base64url')
    expect(header.alg).toBe('EdDSA')
    expect((await callMcp(real.token)).status).toBe(200)
    expect((await callMcp(`${forged}.${signature}`)).status).toBe(401)
  })
})
