import { request as httpRequest } from 'node:http'
import { getMigrations } from 'better-auth/db/migration'
import { describe, expect, it } from 'vitest'
import { cleanName } from './auth/routes'
import {
  authorizeUrl,
  browser,
  CLIENT,
  CLIENT_ID,
  claims,
  connect,
  EMAIL_A,
  EMAIL_B,
  mint,
  openSignIn,
  pkce,
  REDIRECT,
  signInWithGoogle,
  token,
  withClaude,
} from './auth-test-kit'
import { sql, useDatabase } from './test-harness'

/**
 * The authorization server end to end: a fake claude.ai (its client metadata document, PKCE, a cookie jar) and a fake Google walk
 * authorize -> sign-in page -> "Continuar con Google" -> consent -> code -> token -> refresh. On PGlite; with PG_TEST_URL set, on a
 * real Postgres in its own schema.
 */
// PGlite shares one session between connections, so `useDatabase` gives it one; a real Postgres gets a pool.
useDatabase({ max: 12 })

describe('the whole flow', () => {
  it('authorize, Google sign-in, consent, token, refresh rotation, reuse refused', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const { verifier, challenge } = pkce()

    // The sign-in page: one button, the agent named, nothing from outside, a strict CSP.
    const { page, html, search } = await openSignIn(b, app.base, challenge)
    expect(page.status).toBe(200)
    expect(html).toContain(`Conectá ${CLIENT} con Warren`)
    expect(html).toContain('Continuar con Google')
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//)
    expect(html).not.toMatch(/type="password"|type="email"/)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('x-frame-options')).toBe('DENY')

    // Google answers: the callback makes the user and the account, and resumes the authorization at the consent page.
    const back0 = await signInWithGoogle(b, { email: EMAIL_A, search })
    expect(back0.status).toBe(302)
    const consent = new URL(back0.headers.get('location') ?? '', app.base)
    expect(consent.pathname).toBe('/oauth/consent')
    const [user] = await sql`SELECT email, warren_account_id AS account FROM auth_user`
    expect(user).toMatchObject({ email: EMAIL_A, account: expect.any(Number) })
    const [session] = await sql`SELECT "expiresAt", "createdAt" FROM auth_session`
    expect((session?.expiresAt - session?.createdAt) / 1000).toBeCloseTo(3600, -1)

    // The consent page: the client, whose account (the Google email), where it goes next, the scopes in plain Spanish, two buttons.
    const consentPage = await b.go(consent.pathname + consent.search)
    const consentHtml = await consentPage.text()
    expect(consentPage.status).toBe(200)
    expect(consentHtml).toContain(`${CLIENT} quiere acceder a tu Warren`)
    expect(consentHtml).toContain(`<dd>${EMAIL_A}</dd>`)
    expect(consentHtml).toContain('Después te lleva a</dt><dd>claude.ai')
    expect(consentHtml).toContain('Ver tus movimientos')
    expect(consentHtml).toContain('Anotar, corregir y borrar movimientos')
    expect(consentHtml).toContain('Permitir')
    expect(consentHtml).toContain('Cancelar')
    const granted = await b.json('/api/auth/oauth2/consent', {
      accept: true,
      oauth_query: consent.search.slice(1),
    })
    const back = new URL(((await granted.json()) as { url: string }).url)
    expect(back.origin + back.pathname).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe('state-1')
    expect(back.searchParams.get('iss')).toBe(app.base)

    // The token: PKCE S256, the resource the MCP URL.
    const exchange = {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: `${app.base}/mcp`,
    }
    const issued = await token(b, exchange)
    expect(issued.status, await issued.clone().text()).toBe(200)
    const tokens = (await issued.json()) as { access_token: string; refresh_token: string }
    const payload = claims(tokens.access_token)
    expect(payload).toMatchObject({ iss: app.base, azp: CLIENT_ID })
    expect([payload.aud].flat()).toContain(`${app.base}/mcp`)
    expect(payload.exp - payload.iat).toBe(15 * 60)
    expect(payload.scope.split(' ').sort()).toEqual([
      'ledger:read',
      'ledger:write',
      'offline_access',
    ])
    expect(payload.sub).toBe((await sql`SELECT id FROM auth_user`)[0]?.id)
    expect(tokens.refresh_token).toBeTruthy()

    // The door: no token, the challenge; a good token passes it.
    const door = await fetch(`${app.base}/mcp`, { method: 'POST' })
    expect(door.status).toBe(401)
    expect(door.headers.get('www-authenticate')).toContain(
      `resource_metadata="${app.base}/.well-known/oauth-protected-resource/mcp"`,
    )
    expect(door.headers.get('www-authenticate')).toContain('scope="ledger:read')
    const bearer = (t: string) => ({ method: 'POST', headers: { authorization: `Bearer ${t}` } })
    expect((await fetch(`${app.base}/mcp`, bearer(tokens.access_token))).status).not.toBe(401)
    expect(
      (await fetch(`${app.base}/mcp`, bearer(`${tokens.access_token.slice(0, -4)}AAAA`))).status,
    ).toBe(401)

    // Refresh rotates: the new refresh token works, the old one never again.
    const refresh = (t: string) =>
      token(b, { grant_type: 'refresh_token', refresh_token: t, client_id: CLIENT_ID })
    const rotated = await refresh(tokens.refresh_token)
    expect(rotated.status, await rotated.clone().text()).toBe(200)
    const next = (await rotated.json()) as { access_token: string; refresh_token: string }
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect([claims(next.access_token).aud].flat()).toContain(`${app.base}/mcp`)
    const reused = await refresh(tokens.refresh_token)
    expect(reused.status).toBe(400)
    expect(((await reused.json()) as { error: string }).error).toBe('invalid_grant')
    // The reuse is a replay: the family is revoked, the rotated token with it.
    expect((await refresh(next.refresh_token)).status).toBe(400)
    // The authorization code works once.
    expect((await token(b, exchange)).status).toBe(400)
    app.close()
  })

  it('refuses a wrong PKCE verifier', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const back = await connect(app, b, { challenge: pkce().challenge })
    const wrong = await token(b, {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: pkce().verifier,
      resource: `${app.base}/mcp`,
    })
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant')
    app.close()
  })

  it('refuses a client id that is not an https document URL, without fetching it', async () => {
    const { app, claude } = await withClaude()
    for (const clientId of [
      'http://agent.example/client.json',
      'https://agent.example',
      'https://agent.example:8443/client.json',
      'https://user:pass@agent.example/client.json',
    ]) {
      const res = await browser(app.base).go(
        authorizeUrl(app.base, { challenge: pkce().challenge, clientId }),
      )
      expect(res.headers.get('location') ?? '', clientId).not.toContain('/sign-in')
      expect(res.status, clientId).toBeGreaterThanOrEqual(300)
    }
    expect(claude.fetched).toEqual([])
    expect(await sql`SELECT 1 FROM auth_oauth_client`).toHaveLength(0)
    app.close()
  })

  it('accepts a metadata document from any https host: bring your own agent', async () => {
    const { app, claude } = await withClaude()
    const clientId = 'https://agent.example/client.json'
    await browser(app.base).go(authorizeUrl(app.base, { challenge: pkce().challenge, clientId }))
    expect(claude.fetched).toEqual([clientId])
    app.close()
  })

  it('lets a client without a document register itself (DCR), as a public client, rate limited', async () => {
    const { app } = await withClaude()
    const register = () =>
      fetch(`${app.base}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Some agent',
          redirect_uris: ['https://agent.example/oauth/callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      })
    const first = await register()
    expect(first.status).toBeLessThan(300)
    const body = (await first.json()) as { client_id?: string; client_secret?: string }
    expect(body.client_id).toEqual(expect.any(String))
    expect(body.client_secret).toBeUndefined()
    const later = []
    for (let i = 0; i < 6; i++) later.push((await register()).status)
    expect(later).toContain(429)
    app.close()
  })
})

describe('Google sign-in is the only way in, and it is open', () => {
  it('a first sign-in makes the user and its account row; the same person again makes nothing new', async () => {
    const { app } = await withClaude()
    await connect(app, browser(app.base), { challenge: pkce().challenge, email: EMAIL_A })
    const [first] = await sql`SELECT u.id, u.warren_account_id AS account, a.created_at
      FROM auth_user u JOIN account a ON a.id = u.warren_account_id`
    expect(first?.account).toEqual(expect.any(Number))
    // The same Google account on another device: the same user, the same account.
    await connect(app, browser(app.base), { challenge: pkce().challenge, email: EMAIL_A })
    expect(await sql`SELECT 1 FROM auth_user`).toHaveLength(1)
    expect(await sql`SELECT 1 FROM account`).toHaveLength(1)
    // Anyone with a Google account may sign up: another person gets their own user and account, with no list to be on.
    await connect(app, browser(app.base), { challenge: pkce().challenge, email: EMAIL_B })
    const users =
      await sql`SELECT u.email, u.warren_account_id AS account FROM auth_user u ORDER BY u.email`
    expect(users.map((u) => u.email)).toEqual([EMAIL_A, EMAIL_B])
    expect(new Set(users.map((u) => u.account)).size).toBe(2)
    app.close()
  })

  it('keeps nothing of Google but who signed in: no access, refresh or ID token', async () => {
    const { app, google } = await withClaude()
    await connect(app, browser(app.base), { challenge: pkce().challenge })
    expect(google.traded).toEqual([EMAIL_A]) // Google did hand tokens over...
    const rows =
      await sql`SELECT "providerId", "accessToken", "refreshToken", "idToken", scope FROM auth_account`
    expect(rows).toEqual([
      { providerId: 'google', accessToken: null, refreshToken: null, idToken: null, scope: null },
    ])
    app.close()
  })

  it('no other route makes a user: not email sign-up, not email sign-in, not an ID token, not a user made outside the callback', async () => {
    const { app } = await withClaude()
    const post = (path: string, body: unknown) =>
      fetch(`${app.base}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: app.base },
        body: JSON.stringify(body),
      })
    const email = { email: 'intruso@example.test', password: 'a-long-password-123', name: 'x' }
    expect((await post('/sign-up/email', email)).status).toBe(404)
    expect((await post('/sign-in/email', email)).status).toBe(404)
    // An ID token for a person who is not a user yet: social sign-in by ID token would make one, and may not.
    const forged = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: 'google-client-id',
        sub: 'g1',
        email: email.email,
      }),
    ).toString('base64url')}.`
    const byIdToken = await post('/sign-in/social', {
      provider: 'google',
      idToken: { token: forged },
    })
    expect(byIdToken.ok).toBe(false)
    // better-auth's own adapter, outside Google's callback: the hook refuses the user.
    const context = await app.auth.$context
    await context.internalAdapter
      .createUser({ email: 'otro@example.test', name: 'x', emailVerified: true }, {
        method: 'oauth',
      } as never)
      .catch(() => null)
    expect(await sql`SELECT 1 FROM auth_user`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM account`).toHaveLength(0)
    app.close()
  })

  it('a user can stand only for a real account', async () => {
    await expect(
      sql`INSERT INTO auth_user (name, email, "emailVerified", warren_account_id)
        VALUES ('x', 'x@example.test', true, 999)`,
    ).rejects.toThrow()
  })
})

describe('the pages of the sign-in', () => {
  it('a sign-in page opened with a tampered OAuth query is refused; opened by hand it leads to the account page', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const { search } = await openSignIn(browser(app.base), app.base, pkce().challenge)
    const tampered = search.replace(/scope=[^&]*/, 'scope=ledger%3Aread')
    expect(tampered).not.toBe(search)
    expect((await b.go(`/sign-in${tampered}`)).status).toBe(400)
    const byHand = await b.go('/sign-in')
    expect(byHand.status).toBe(200)
    expect(await byHand.text()).toContain('data-next="/account"')
    app.close()
  })

  it('the consent page without a session', async () => {
    const { app } = await withClaude()
    expect((await browser(app.base).go('/oauth/consent?client_id=x')).status).toBe(401)
    app.close()
  })
})

describe('what is served, and where', () => {
  it('serves both well-known documents', async () => {
    const { app } = await withClaude()
    const meta = (await (
      await fetch(`${app.base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>
    expect(meta).toMatchObject({
      issuer: app.base,
      client_id_metadata_document_supported: true,
      authorization_endpoint: `${app.base}/api/auth/oauth2/authorize`,
      token_endpoint: `${app.base}/api/auth/oauth2/token`,
    })
    expect(meta.token_endpoint_auth_methods_supported).toContain('none')
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(meta.registration_endpoint).toBe(`${app.base}/api/auth/oauth2/register`)
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const prm = (await (await fetch(app.base + path)).json()) as Record<string, unknown>
      expect(prm).toMatchObject({ resource: `${app.base}/mcp`, authorization_servers: [app.base] })
      expect(prm.scopes_supported).toEqual(['ledger:read', 'ledger:write'])
    }
    app.close()
  })

  it('closes client management and the session JWT route', async () => {
    const { app } = await withClaude()
    for (const path of ['/oauth2/create-client', '/oauth2/get-clients', '/token']) {
      const read = path === '/token' || path === '/oauth2/get-clients'
      const res = await fetch(`${app.base}/api/auth${path}`, {
        method: read ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', origin: app.base },
        body: read ? undefined : '{}',
      })
      expect(res.status, path).toBe(404)
    }
    app.close()
  })

  it('answers the OAuth, sign-in, account, web and MCP routes only on the public host', async () => {
    const { app } = await withClaude()
    const get = (path: string, host: string) =>
      new Promise<number>((resolve, reject) => {
        httpRequest({ host: '127.0.0.1', port: app.port, path, headers: { host } }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        })
          .on('error', reject)
          .end()
      })
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/mcp',
      '/sign-in',
      '/oauth/consent',
      '/account',
      '/',
      '/setup.md',
      '/llms.txt',
      '/privacy',
      '/api/auth/jwks',
    ]) {
      expect(await get(path, 'evil.example'), path).toBe(404)
    }
    expect(await get('/.well-known/oauth-protected-resource', new URL(app.base).host)).toBe(200)
    // /health answers on any host: a platform's check does not know ours.
    expect(await get('/health', 'internal.railway')).toBe(200)
    app.close()
  })
})

describe('the limits on the auth routes', () => {
  it('better-auth refuses a burst of sign-ins from one address, and another address is not counted', async () => {
    const { app } = await withClaude()
    const start = (ip: string) =>
      fetch(`${app.base}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: app.base, 'x-real-ip': ip },
        body: JSON.stringify({ provider: 'google', callbackURL: '/account' }),
      })
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) statuses.push((await start('203.0.113.7')).status)
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
    expect((await start('203.0.113.8')).status).toBe(200)
    app.close()
  })
})

describe('the schema', () => {
  it('002_auth.sql has everything better-auth wants: no table or column is missing', async () => {
    const { app } = await withClaude()
    const plan = await getMigrations(app.auth.options)
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([])
    expect(plan.toBeAdded.map((t) => t.table)).toEqual([])
    expect(plan.schemaProblems).toEqual([])
    app.close()
  })
})

describe("a client's name", () => {
  it('is cut and stripped before it is shown', () => {
    expect(cleanName('Claude')).toBe('Claude')
    expect(cleanName('  *Claude*\n<b>Pro</b> ')).toBe('Claude bPro/b')
    const long = cleanName('Claude para Escritorio con Extensiones de Productividad Personal')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('minting a token for tests', () => {
  it('gives each person a token for their own account', async () => {
    const { app } = await withClaude()
    const a = await mint(app, EMAIL_A)
    const b = await mint(app, EMAIL_B)
    expect(a.userId).not.toBe(b.userId)
    expect(claims(a.access_token).sub).toBe(a.userId)
    app.close()
  })
})
