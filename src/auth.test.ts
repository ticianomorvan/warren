import { createHash, randomBytes, randomInt } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { getMigrations } from 'better-auth/db/migration'
import { describe, expect, it } from 'vitest'
import { ipKey } from './auth/ip'
import { cleanName, maskNumber } from './auth/routes'
import { forgetAll, replyCall, script } from './command-fixtures'
import { loadConfig } from './config'
import { REPLY_LINK } from './render'
import {
  bodies,
  cafe,
  DISPLAY_NUMBER,
  fakeModel,
  gate,
  messageBody,
  movements,
  post,
  row,
  settle,
  setup,
  sql,
  until,
  useDatabase,
  VERIFY,
} from './test-harness'

/**
 * The authorization server of slice 5.1 end to end: a fake claude.ai (its client metadata document, PKCE, a
 * cookie jar) walks authorize -> sign-in page -> WhatsApp "vincular" and "sí" -> consent -> code -> token ->
 * refresh. On PGlite; with PG_TEST_URL set, on a real Postgres in its own schema.
 */
const url = process.env.PG_TEST_URL
// PGlite shares one session between connections, so its tests keep to one (as the other test files do).
useDatabase(url ? { url, max: 12, schema: 'auth_test' } : undefined)

const WA_A = '5491100000001'
const WA_B = '5491100000002'
const CLIENT_ID = 'https://claude.ai/oauth/warren-test.json'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const SCOPE = 'ledger:read ledger:write offline_access'
const CLIENT = 'Claude (claude.ai)'

/** claude.ai's client metadata document, and a record of what was fetched. */
function fakeClaude() {
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
const pkce = () => {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

/** A browser: a cookie jar, and no redirects followed (each hop is asserted). `ip` is what Railway's edge would write in X-Real-IP. */
function browser(base: string, ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`) {
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
type Browser = ReturnType<typeof browser>
type App = Awaited<ReturnType<typeof setup>>

const authorizeUrl = (base: string, p: { challenge: string; clientId?: string }) =>
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

const location = (res: Response) => {
  const to = res.headers.get('location')
  if (!to) throw new Error(`no redirect: ${res.status}`)
  return new URL(to, 'http://x')
}

const withClaude = (o: Parameters<typeof setup>[0] = {}) => {
  const claude = fakeClaude()
  return setup({ ...o, auth: { fetchClient: claude.fetchClient } }).then((app) => ({ app, claude }))
}

/** What WhatsApp sends when `from` writes `text`; waits until the message is settled. Returns Warren's replies. */
async function whatsapp(app: App, from: string, text: string) {
  const wamid = `wamid.AUTH${Math.random().toString(36).slice(2)}`
  const before = app.calls.sent.length
  await post(app.base, messageBody(wamid, from, { text: { body: text } }))
  await until(async () => ['done', 'ignored'].includes(String((await row(wamid))?.status))).catch(
    async (e) => {
      throw new Error(`${e.message}: ${JSON.stringify(await row(wamid))}`)
    },
  )
  return bodies(app.calls).slice(before)
}

/** The first leg: authorize, and the sign-in page it sends the browser to. */
async function openSignIn(b: Browser, base: string, challenge: string) {
  const authorize = await b.go(authorizeUrl(base, { challenge }))
  expect(authorize.status).toBe(302)
  const to = location(authorize)
  expect(to.pathname).toBe('/sign-in')
  const page = await b.go(to.pathname + to.search)
  const html = await page.text()
  return { page, html, search: to.search, code: /<b>([A-Z0-9]{6})<\/b>/.exec(html)?.[1] ?? '' }
}

const status = async (b: Browser) =>
  ((await (await b.go('/sign-in/status')).json()) as { state: string }).state

const complete = (b: Browser, search: string) =>
  b.json('/api/auth/warren/link/complete', { oauth_query: search.slice(1) })

/** Sends the code, answers "sí", finishes the sign-in and the consent. Returns the redirect back to the client. */
async function connect(app: App, b: Browser, p: { challenge: string; from?: string }) {
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

const token = (b: Browser, form: Record<string, string>) =>
  b.go('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })

const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString())

describe('the whole flow', () => {
  it('authorize, sign-in by WhatsApp, consent, token, refresh rotation, reuse refused', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const { verifier, challenge } = pkce()

    // The sign-in page: the code, the number as a person reads it, the wa.me link, nothing from outside.
    const { page, html, code, search } = await openSignIn(b, app.base, challenge)
    expect(page.status).toBe(200)
    expect(html).toContain(`Conectá ${CLIENT} con Warren`)
    expect(html).toContain(DISPLAY_NUMBER)
    expect(html).toContain(`https://wa.me/5491155550000?text=vincular%20${code}`)
    expect(html).not.toMatch(/(?:src|href)="https?:\/\/(?!wa\.me)/)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    // Only the hash of the browser's secret is stored, and the cookie is httpOnly.
    const secret = b.jar.get('warren_link') ?? ''
    expect(secret).not.toBe('')
    expect(page.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    const [stored] = await sql`SELECT * FROM link_request`
    expect(stored?.secret_hash).toBe(createHash('sha256').update(secret).digest('hex'))
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect((stored?.expires_at - stored?.created_at) / 1000).toBeCloseTo(600, -1)
    expect(await status(b)).toBe('waiting')

    // WhatsApp: the code (typed in lower case), then "sí". No model call for either.
    const [asked] = await whatsapp(app, WA_A, `vincular ${code.toLowerCase()}`)
    expect(asked).toBe(REPLY_LINK.ask(CLIENT))
    expect(await status(b)).toBe('asked')
    const [yes] = await whatsapp(app, WA_A, 'Sí')
    expect(yes).toBe(REPLY_LINK.done(CLIENT))
    expect(app.model.n).toBe(0)
    expect(await status(b)).toBe('confirmed')

    // The browser finishes: a session for the person's user, then the consent page.
    const done = await complete(b, search)
    expect(done.status).toBe(200)
    expect(b.jar.has('warren_link')).toBe(false) // the browser secret is spent
    const consent = new URL(((await done.json()) as { url: string }).url, app.base)
    expect(consent.pathname).toBe('/oauth/consent')
    const [user] =
      await sql`SELECT u.email, a.wa_id FROM auth_user u JOIN account a ON a.id = u.warren_account_id`
    expect(user).toMatchObject({
      email: expect.stringMatching(/^a\d+@users\.invalid$/),
      wa_id: WA_A,
    })
    const [session] = await sql`SELECT "expiresAt", "createdAt" FROM auth_session`
    expect((session?.expiresAt - session?.createdAt) / 1000).toBeCloseTo(3600, -1)

    // The consent page: the client, where it goes next, the scopes in plain Spanish, two buttons.
    const consentPage = await b.go(consent.pathname + consent.search)
    const consentHtml = await consentPage.text()
    expect(consentPage.status).toBe(200)
    expect(consentHtml).toContain(`${CLIENT} quiere acceder a tu Warren`)
    expect(consentHtml).toContain('Después te lleva a</dt><dd>claude.ai')
    // Whose account this connects, masked: never the whole number.
    expect(consentHtml).toContain('+54 9 ····0001')
    expect(consentHtml).not.toContain(WA_A)
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

    // The door: no token, the challenge; a good token passes it (the tools come in the next slice).
    const door = await fetch(`${app.base}/mcp`, { method: 'POST' })
    expect(door.status).toBe(401)
    expect(door.headers.get('www-authenticate')).toContain(
      `resource_metadata="${app.base}/.well-known/oauth-protected-resource/mcp"`,
    )
    expect(door.headers.get('www-authenticate')).toContain('scope="ledger:read')
    const bearer = (t: string) => ({ method: 'POST', headers: { authorization: `Bearer ${t}` } })
    expect((await fetch(`${app.base}/mcp`, bearer(tokens.access_token))).status).toBe(501)
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

  it('refuses a client id whose host is not allow-listed, without fetching it', async () => {
    const { app, claude } = await withClaude()
    const res = await browser(app.base).go(
      authorizeUrl(app.base, {
        challenge: pkce().challenge,
        clientId: 'https://evil.example/client.json',
      }),
    )
    expect(res.headers.get('location') ?? '').not.toContain('/sign-in')
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(claude.fetched).toEqual([])
    expect(await sql`SELECT 1 FROM auth_oauth_client`).toHaveLength(0)
    app.close()
  })

  it('a second person gets their own user', async () => {
    const { app } = await withClaude()
    await connect(app, browser(app.base), { challenge: pkce().challenge, from: WA_A })
    await connect(app, browser(app.base), { challenge: pkce().challenge, from: WA_B })
    const users = await sql`SELECT a.wa_id FROM auth_user u
      JOIN account a ON a.id = u.warren_account_id ORDER BY a.wa_id`
    expect(users.map((u) => u.wa_id)).toEqual([WA_A, WA_B])
    app.close()
  })
})

describe('the sign-in refuses', () => {
  it('an expired code, an unknown code and a used one, all with the same single answer', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const { code } = await openSignIn(b, app.base, pkce().challenge)
    await sql`UPDATE link_request SET expires_at = now() - interval '1 minute'`
    expect(await whatsapp(app, WA_A, `vincular ${code}`)).toEqual([REPLY_LINK.refused])
    expect(await status(b)).toBe('closed')
    expect(await whatsapp(app, WA_A, 'vincular ZZZZZZ')).toEqual([REPLY_LINK.refused])
    expect(await sql`SELECT 1 FROM link_request WHERE account_id IS NOT NULL`).toHaveLength(0)

    // A used one: finished, then sent again.
    const back = await connect(app, browser(app.base), { challenge: pkce().challenge })
    expect(back.searchParams.get('code')).toBeTruthy()
    const [used] =
      await sql`SELECT code FROM link_request WHERE used_at IS NOT NULL AND confirmed_at IS NOT NULL`
    expect(await whatsapp(app, WA_A, `vincular ${used?.code}`)).toEqual([REPLY_LINK.refused])
    app.close()
  })

  it('a code someone else already asked about', async () => {
    const { app } = await withClaude()
    const { code } = await openSignIn(browser(app.base), app.base, pkce().challenge)
    expect((await whatsapp(app, WA_A, `vincular ${code}`))[0]).toBe(REPLY_LINK.ask(CLIENT))
    expect(await whatsapp(app, WA_B, `vincular ${code}`)).toEqual([REPLY_LINK.refused])
    // B's "sí" confirms nothing of A's.
    expect((await whatsapp(app, WA_B, 'sí'))[0]).not.toBe(REPLY_LINK.done(CLIENT))
    expect(await sql`SELECT 1 FROM link_request WHERE confirmed_at IS NOT NULL`).toHaveLength(0)
    app.close()
  })

  it('a browser that does not hold the secret: no status, no session', async () => {
    const { app } = await withClaude()
    const mine = browser(app.base)
    const { code, search } = await openSignIn(mine, app.base, pkce().challenge)
    await whatsapp(app, WA_A, `vincular ${code}`)
    await whatsapp(app, WA_A, 'sí')
    expect(await status(mine)).toBe('confirmed')

    const stranger = browser(app.base)
    expect(await status(stranger)).toBe('closed')
    stranger.jar.set('warren_link', randomBytes(32).toString('base64url'))
    expect(await status(stranger)).toBe('closed')
    expect((await complete(stranger, search)).status).toBe(403)
    expect(await sql`SELECT 1 FROM auth_session`).toHaveLength(0)

    // The real browser still can, once.
    expect((await complete(mine, search)).status).toBe(200)
    expect(await status(mine)).toBe('closed')
    app.close()
  })

  it('a browser whose sign-in nobody confirmed', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const { code, search } = await openSignIn(b, app.base, pkce().challenge)
    expect((await complete(b, search)).status).toBe(403)
    await whatsapp(app, WA_A, `vincular ${code}`) // asked, still not confirmed
    expect((await complete(b, search)).status).toBe(403)
    expect(await sql`SELECT 1 FROM auth_session`).toHaveLength(0)
    app.close()
  })

  it('a sender that is not allowed: ignored like any message, and the sign-in stays closed to them', async () => {
    const { app } = await withClaude({ allowed: [WA_A] })
    const b = browser(app.base)
    const { code } = await openSignIn(b, app.base, pkce().challenge)
    expect(await whatsapp(app, WA_B, `vincular ${code}`)).toEqual([])
    expect(await whatsapp(app, WA_B, 'sí')).toEqual([])
    expect(await sql`SELECT 1 FROM inbound_message WHERE status = 'ignored'`).toHaveLength(2)
    expect(await sql`SELECT 1 FROM account WHERE wa_id = ${WA_B}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM link_request WHERE account_id IS NOT NULL`).toHaveLength(0)
    expect(await status(b)).toBe('waiting')
    app.close()
  })

  it('a "no" closes it', async () => {
    const { app } = await withClaude({ model: script(replyCall('Bien.')) })
    const b = browser(app.base)
    const { code } = await openSignIn(b, app.base, pkce().challenge)
    await whatsapp(app, WA_A, `vincular ${code}`)
    expect(await whatsapp(app, WA_A, 'no')).toEqual([REPLY_LINK.declined])
    expect(await status(b)).toBe('closed')
    // And a later "sí" confirms nothing: it goes to the model.
    expect(await whatsapp(app, WA_A, 'sí')).toEqual(['Bien.'])
    expect(await sql`SELECT 1 FROM link_request WHERE confirmed_at IS NOT NULL`).toHaveLength(0)
    app.close()
  })

  it('a sign-in page opened without its signed OAuth query, or with a tampered one', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    expect((await b.go('/sign-in')).status).toBe(400)
    const { search } = await openSignIn(browser(app.base), app.base, pkce().challenge)
    const tampered = search.replace(/scope=[^&]*/, 'scope=ledger%3Aread')
    expect(tampered).not.toBe(search)
    expect((await b.go(`/sign-in${tampered}`)).status).toBe(400)
    expect(await sql`SELECT 1 FROM link_request`).toHaveLength(1) // only the real one
    app.close()
  })

  it('a reload of the page keeps its code', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const first = await openSignIn(b, app.base, pkce().challenge)
    const again = await b.go(`/sign-in${first.search}`)
    expect(await again.text()).toContain(`<b>${first.code}</b>`)
    expect(await sql`SELECT 1 FROM link_request`).toHaveLength(1)
    app.close()
  })

  it('the consent page without a session', async () => {
    const { app } = await withClaude()
    expect((await browser(app.base).go('/oauth/consent?client_id=x')).status).toBe(401)
    app.close()
  })
})

describe('the question of a sign-in belongs to the very next answer', () => {
  /** The browser, its code, and the question Warren asked about it. */
  async function asked(app: App, from = WA_A) {
    const b = browser(app.base)
    const { code, search } = await openSignIn(b, app.base, pkce().challenge)
    expect((await whatsapp(app, from, `vincular ${code}`))[0]).toBe(REPLY_LINK.ask(CLIENT))
    return { b, code, search }
  }
  const confirmed = async () =>
    Number((await sql`SELECT count(*) AS n FROM link_request WHERE confirmed_at IS NOT NULL`)[0]?.n)

  it('a "sí" to something else the agent asked afterwards confirms nothing', async () => {
    const { app } = await withClaude({
      model: script(replyCall('¿Querés que te arme un resumen?'), replyCall('Dale, lo armo.')),
    })
    const { b } = await asked(app)
    expect(await whatsapp(app, WA_A, 'hola')).toEqual(['¿Querés que te arme un resumen?'])
    expect(await whatsapp(app, WA_A, 'sí')).toEqual(['Dale, lo armo.'])
    expect(app.model.n).toBe(2) // both went to the agent
    expect(await status(b)).toBe('asked')
    expect(await confirmed()).toBe(0)
    app.close()
  })

  it.each(['ok', 'dale', 'bueno'])(
    'only a plain "sí" confirms: "%s" goes to the agent, and then nothing is left to answer',
    async (word) => {
      const { app } = await withClaude({
        model: script(replyCall('Seguimos entonces.'), replyCall('Bien.')),
      })
      const { b } = await asked(app)
      expect(await whatsapp(app, WA_A, word)).toEqual(['Seguimos entonces.'])
      expect(await status(b)).toBe('asked')
      // The question was the previous reply's: after the agent's answer, a "sí" is the agent's too.
      expect(await whatsapp(app, WA_A, 'sí')).toEqual(['Bien.'])
      expect(await status(b)).toBe('asked')
      expect(await confirmed()).toBe(0)
      app.close()
    },
  )

  it('"deshacer" right after the sign-in question is the agent\'s to read, and code does not undo an earlier movement', async () => {
    const { app } = await withClaude({
      model: script(cafe, replyCall('Decime qué querés cambiar.')),
    })
    expect((await whatsapp(app, WA_A, 'café 3500'))[0]).toContain('Café')
    await asked(app)
    expect(await whatsapp(app, WA_A, 'deshacer')).toEqual(['Decime qué querés cambiar.'])
    expect(await movements()).toHaveLength(1)
    expect(
      await sql`SELECT 1 FROM movement WHERE deleted_at IS NULL AND superseded_by IS NULL`,
    ).toHaveLength(1)
    app.close()
  })

  it('a "no" declines it, and the browser is closed', async () => {
    const { app } = await withClaude()
    const { b } = await asked(app)
    expect(await whatsapp(app, WA_A, 'no')).toEqual([REPLY_LINK.declined])
    expect(await status(b)).toBe('closed')
    expect(await confirmed()).toBe(0)
    app.close()
  })

  it('a second code replaces the first: only the newest question can be confirmed, and the first is closed', async () => {
    const { app } = await withClaude()
    const first = await asked(app)
    const second = await asked(app)
    expect(await status(first.b)).toBe('closed')
    expect(await whatsapp(app, WA_A, 'sí')).toEqual([REPLY_LINK.done(CLIENT)])
    expect(await status(second.b)).toBe('confirmed')
    expect(await status(first.b)).toBe('closed')
    expect((await complete(first.b, first.search)).status).toBe(403)
    expect(await confirmed()).toBe(1)
    app.close()
  })

  it('a code of someone else\'s account cannot be confirmed by a "sí" from this one', async () => {
    const { app } = await withClaude()
    const { code } = await openSignIn(browser(app.base), app.base, pkce().challenge)
    await whatsapp(app, WA_A, `vincular ${code}`)
    const [row] = await sql`SELECT id::int AS id FROM link_request`
    const [b] = await sql`INSERT INTO account (wa_id) VALUES (${WA_B}) RETURNING id::int AS id`
    // B's own question carries A's sign-in id (a forged pending): the guard is the account, not the id alone.
    await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, reply_text, pending)
      VALUES ('forged', ${WA_B}, 'text', 'x', '{}'::jsonb, 'done', '¿Conectar?', ${sql.json({ action: 'link', link_id: row?.id })})`
    expect(b?.id).toBeGreaterThan(0)
    expect((await whatsapp(app, WA_B, 'sí'))[0]).toBe(REPLY_LINK.refused)
    expect(await confirmed()).toBe(0)
    app.close()
  })

  it('a message processed again after a shutdown confirms once and answers once, and nothing changes before the commit', async () => {
    const entered = gate()
    const hold = gate()
    let armed = false
    const { app } = await withClaude({
      processorStore: (store) => ({
        ...store,
        conversation: async (c) => {
          if (armed) {
            entered.open()
            await hold.promise
          }
          return store.conversation(c)
        },
      }),
    })
    const { b } = await asked(app)
    const sent = app.calls.sent.length
    armed = true
    await post(app.base, messageBody('wamid.SI', WA_A, { text: { body: 'sí' } }))
    await entered.promise
    await app.processor.stop(2000)
    // Handed back with nothing done: not confirmed, no reply, no bare "sí" sent to the agent.
    expect(await row('wamid.SI')).toMatchObject({ status: 'pending', failure_sent_at: null })
    expect(await status(b)).toBe('asked')
    expect(await confirmed()).toBe(0)
    expect(app.calls.sent).toHaveLength(sent)
    expect(app.model.n).toBe(0)

    armed = false
    const successor = app.makeProcessor(app.store, app.model && fakeModel().client)
    await successor.sweep()
    expect(bodies(app.calls).slice(sent)).toEqual([REPLY_LINK.done(CLIENT)])
    expect(await status(b)).toBe('confirmed')
    hold.open() // the old process's read finally returns: nothing more happens
    await settle()
    expect(bodies(app.calls).slice(sent)).toHaveLength(1)
    expect(await confirmed()).toBe(1)
    app.close()
  })
})

describe('"sí" and the newest question', () => {
  const seedFacts = async (n: number) => {
    const [account] = await sql`
      INSERT INTO account (wa_id) VALUES (${WA_A})
      ON CONFLICT (wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id RETURNING id`
    const [inbound] = await sql`
      INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status)
      VALUES ('seed.facts', ${WA_A}, 'text', 'seed', '{}'::jsonb, 'done') RETURNING id`
    await sql`INSERT INTO fact ${sql(
      Array.from({ length: n }, (_, k) => ({
        account_id: account?.id,
        kind: 'note',
        key: `cosa ${k + 1}`,
        value: `valor ${k + 1}`,
        inbound_message_id: inbound?.id,
      })),
    )}`
  }
  const liveFacts = async () =>
    Number((await sql`SELECT count(*) AS n FROM fact WHERE forgotten_at IS NULL`)[0]?.n)

  it('the sign-in code arrives after a forget-all question: the sign-in owns the next "sí"', async () => {
    await seedFacts(2)
    const { app } = await withClaude({ model: script(forgetAll) })
    const { code } = await openSignIn(browser(app.base), app.base, pkce().challenge)
    expect((await whatsapp(app, WA_A, 'olvidate de todo'))[0]).toContain('¿Seguro')
    expect((await whatsapp(app, WA_A, `vincular ${code}`))[0]).toBe(REPLY_LINK.ask(CLIENT))
    expect((await whatsapp(app, WA_A, 'sí'))[0]).toBe(REPLY_LINK.done(CLIENT))
    expect(await liveFacts()).toBe(2)
    expect(await sql`SELECT 1 FROM link_request WHERE confirmed_at IS NOT NULL`).toHaveLength(1)
    app.close()
  })

  it('a forget-all question asked after the sign-in code owns the next "sí": the sign-in is not confirmed', async () => {
    await seedFacts(2)
    const { app } = await withClaude({ model: script(forgetAll) })
    const { code } = await openSignIn(browser(app.base), app.base, pkce().challenge)
    await whatsapp(app, WA_A, `vincular ${code}`)
    expect((await whatsapp(app, WA_A, 'olvidate de todo'))[0]).toContain('¿Seguro')
    expect((await whatsapp(app, WA_A, 'sí'))[0]).toContain('Me olvidé de todo')
    expect(await liveFacts()).toBe(0)
    expect(await sql`SELECT 1 FROM link_request WHERE confirmed_at IS NOT NULL`).toHaveLength(0)
    app.close()
  })

  it('a bare "sí" with no sign-in open goes to the model as before', async () => {
    const { app } = await withClaude({ model: script(replyCall('Hola')) })
    expect(await whatsapp(app, WA_A, 'sí')).toEqual(['Hola'])
    expect(app.model.n).toBe(1)
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
    expect(meta.registration_endpoint).toBeUndefined()
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

  it('closes dynamic registration, client management and the session JWT route', async () => {
    const { app } = await withClaude()
    for (const path of [
      '/oauth2/register',
      '/oauth2/create-client',
      '/oauth2/get-clients',
      '/token',
    ]) {
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

  it('answers the OAuth, sign-in and MCP routes only on the public host; the webhook on any', async () => {
    const { app } = await withClaude()
    const get = (path: string, host: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        httpRequest({ host: '127.0.0.1', port: app.port, path, headers: { host } }, (res) => {
          let body = ''
          res.on('data', (c) => {
            body += c
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
          .on('error', reject)
          .end()
      })
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/mcp',
      '/sign-in',
      '/sign-in/status',
      '/oauth/consent',
      '/api/auth/jwks',
    ]) {
      expect((await get(path, 'evil.example')).status, path).toBe(404)
    }
    expect(
      (await get('/.well-known/oauth-protected-resource', new URL(app.base).host)).status,
    ).toBe(200)
    const hook = `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=abc`
    expect(await get(hook, 'wa.example')).toEqual({ status: 200, body: 'abc' })
    app.close()
  })

  it('has no auth routes at all unless they are turned on', async () => {
    const app = await setup()
    expect((await fetch(`${app.base}/mcp`)).status).toBe(404)
    expect((await fetch(`${app.base}/sign-in`)).status).toBe(404)
    expect((await fetch(`${app.base}/.well-known/oauth-authorization-server`)).status).toBe(404)
    app.close()
  })
})

describe('whose account, before anything is finished', () => {
  const statusBody = async (b: Browser) =>
    (await (await b.go('/sign-in/status')).json()) as { state: string; account?: string }

  it('the status names the account only once it is confirmed, and masked', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const { code } = await openSignIn(b, app.base, pkce().challenge)
    expect(await statusBody(b)).toEqual({ state: 'waiting' })
    await whatsapp(app, WA_A, `vincular ${code}`)
    expect(await statusBody(b)).toEqual({ state: 'asked' })
    await whatsapp(app, WA_A, 'sí')
    expect(await statusBody(b)).toEqual({ state: 'confirmed', account: '+54 9 ····0001' })
    expect(JSON.stringify(await statusBody(b))).not.toContain(WA_A)
    // A browser that does not hold the secret is told nothing.
    expect(await statusBody(browser(app.base))).toEqual({ state: 'closed' })
    app.close()
  })

  it('a person who consented before skips the consent page, so the sign-in page is where they see whose account it is', async () => {
    const { app } = await withClaude()
    // B has connected their own Claude once: consent for this client and these scopes exists.
    await connect(app, browser(app.base), { challenge: pkce().challenge, from: WA_B })
    const sessions = async () => Number((await sql`SELECT count(*) AS n FROM auth_session`)[0]?.n)
    expect(await sessions()).toBe(1)

    // The victim's browser opens a sign-in; B sends its code from B's own phone and answers "sí".
    const victim = browser(app.base)
    const { code, search, html } = await openSignIn(victim, app.base, pkce().challenge)
    await whatsapp(app, WA_B, `vincular ${code}`)
    await whatsapp(app, WA_B, 'sí')
    // Nothing finishes by itself: the page is told whose account this is and no session was made.
    expect(await statusBody(victim)).toEqual({ state: 'confirmed', account: '+54 9 ····0002' })
    expect(await sessions()).toBe(1)
    // The page calls the finishing endpoint only from the click on "Sí, continuar", never from its polling.
    expect(html).toContain('Sí, continuar')
    expect(html).toContain('No es mía')
    expect(html.match(/link\/complete/g)).toHaveLength(1)
    expect(html).toContain("yes.addEventListener('click', complete)")
    const poll = /async function poll\(\) \{[\s\S]*?\n {2}\}\n/.exec(html)?.[0] ?? ''
    expect(poll).toContain('/sign-in/status')
    expect(poll).not.toContain('complete')
    // And this is why the page asks: for B the consent page would be skipped, straight back to the client.
    const done = await complete(victim, search)
    const next = new URL(((await done.json()) as { url: string }).url, app.base)
    expect(next.origin + next.pathname).toBe(REDIRECT)
    app.close()
  })

  it('"No es mía" closes the sign-in; only the browser that holds it, from our own origin, can', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const { code, search } = await openSignIn(b, app.base, pkce().challenge)
    await whatsapp(app, WA_A, `vincular ${code}`)
    await whatsapp(app, WA_A, 'sí')
    expect((await browser(app.base).json('/sign-in/cancel', {})).status).toBe(200) // no cookie: nothing happens
    expect(await status(b)).toBe('confirmed')
    const cross = await b.go('/sign-in/cancel', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    expect(cross.status).toBe(403)
    expect(await status(b)).toBe('confirmed')
    expect((await b.json('/sign-in/cancel', {})).status).toBe(200)
    expect(await status(b)).toBe('closed')
    expect((await complete(b, search)).status).toBe(403)
    expect(await sql`SELECT 1 FROM auth_session`).toHaveLength(0)
    app.close()
  })
})

describe('abuse limits and the origin check', () => {
  it('refuses a cross-origin POST to finish a sign-in, even with the right cookie', async () => {
    const { app } = await withClaude()
    const b = browser(app.base)
    const { code, search } = await openSignIn(b, app.base, pkce().challenge)
    await whatsapp(app, WA_A, `vincular ${code}`)
    await whatsapp(app, WA_A, 'sí')
    const evil = await b.go('/api/auth/warren/link/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ oauth_query: search.slice(1) }),
    })
    expect(evil.status).toBe(403)
    expect(await sql`SELECT 1 FROM auth_session`).toHaveLength(0)
    expect(await status(b)).toBe('confirmed') // not spent by the refused call
    expect((await complete(b, search)).status).toBe(200)
    app.close()
  })

  it('one address may open only so many sign-in pages; its reloads and other addresses are not counted', async () => {
    const { app } = await withClaude()
    const ip = '203.0.113.7'
    const mine = browser(app.base, ip)
    const first = await openSignIn(mine, app.base, pkce().challenge)
    for (let k = 0; k < 15; k++) await mine.go(`/sign-in${first.search}`) // reloads keep the one row
    expect(await sql`SELECT 1 FROM link_request`).toHaveLength(1)
    // Nine more, each a browser with no cookie, fill the allowance; the next is refused.
    for (let k = 0; k < 9; k++) {
      expect(
        (await openSignIn(browser(app.base, ip), app.base, pkce().challenge)).page.status,
      ).toBe(200)
    }
    const blocked = await openSignIn(browser(app.base, ip), app.base, pkce().challenge)
    expect(blocked.page.status).toBe(429)
    expect(blocked.code).toBe('')
    expect(await sql`SELECT 1 FROM link_request`).toHaveLength(10)
    // Another address is not held back by it, and the first one's browser still reaches its own page.
    expect(
      (await openSignIn(browser(app.base, '203.0.113.8'), app.base, pkce().challenge)).page.status,
    ).toBe(200)
    expect((await mine.go(`/sign-in${first.search}`)).status).toBe(200)
    // The address is stored as a hash.
    expect(JSON.stringify(await sql`SELECT * FROM link_request`)).not.toContain(ip)
    app.close()
  })

  it('an IPv6 /64 is one address for the limit', async () => {
    const { app } = await withClaude()
    for (let k = 0; k < 10; k++) {
      const ip = `2001:db8:1:2:${k.toString(16)}::${k + 1}`
      expect(
        (await openSignIn(browser(app.base, ip), app.base, pkce().challenge)).page.status,
      ).toBe(200)
    }
    const same = await openSignIn(
      browser(app.base, '2001:db8:1:2:ffff::9'),
      app.base,
      pkce().challenge,
    )
    expect(same.page.status).toBe(429)
    expect(
      (await openSignIn(browser(app.base, '2001:db8:1:3::1'), app.base, pkce().challenge)).page
        .status,
    ).toBe(200)
    app.close()
  })

  it('a burst from one address cannot pass the limit together', async () => {
    const { app } = await withClaude()
    const opened = await Promise.all(
      Array.from({ length: 25 }, () =>
        (app.links as NonNullable<typeof app.links>).open('Claude (claude.ai)', '203.0.113.50'),
      ),
    )
    expect(opened.filter(Boolean)).toHaveLength(10)
    expect(await sql`SELECT 1 FROM link_request`).toHaveLength(10)
    app.close()
  })

  it('better-auth limits finishing a sign-in per address, under the address Railway writes', async () => {
    const { app } = await withClaude()
    const b = browser(app.base, '198.51.100.9')
    const { search } = await openSignIn(b, app.base, pkce().challenge)
    const statuses: number[] = []
    for (let k = 0; k < 12; k++) statuses.push((await complete(b, search)).status)
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(403)) // not confirmed, but allowed to try
    expect(statuses.slice(10)).toEqual([429, 429])
    // Another address is not held back by it.
    const other = browser(app.base, '198.51.100.10')
    const open = await openSignIn(other, app.base, pkce().challenge)
    expect((await complete(other, open.search)).status).toBe(403)
    app.close()
  })
})

describe('the schema', () => {
  it('012_auth.sql has everything better-auth wants: no table or column is missing', async () => {
    const { app } = await withClaude()
    const plan = await getMigrations((app.auth as NonNullable<typeof app.auth>).options)
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([])
    expect(plan.toBeAdded.map((t) => t.table)).toEqual([])
    expect(plan.schemaProblems).toEqual([])
    app.close()
  })

  it('a user can stand only for a real account', async () => {
    await expect(
      sql`INSERT INTO auth_user (name, email, "emailVerified", warren_account_id)
        VALUES ('x', 'x@users.invalid', true, 999)`,
    ).rejects.toThrow()
  })
})

describe('ipKey', () => {
  it('keeps IPv4, turns an IPv4-mapped IPv6 into IPv4 and an IPv6 into its /64', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7')
    expect(ipKey(' 203.0.113.7 ')).toBe('203.0.113.7')
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(ipKey('::ffff:cb00:7107')).toBe('203.0.113.7')
    expect(ipKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(ipKey('2001:0DB8:0001:0002:ffff::9')).toBe('2001:db8:1:2::/64')
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(ipKey('[2001:db8:1:2::1]')).toBe('2001:db8:1:2::/64')
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(ipKey('::1')).toBe('0:0:0:0::/64')
    expect(ipKey('unknown')).toBe('unknown')
  })
})

describe('what the pages show', () => {
  it('masks the number, never showing it whole', () => {
    expect(maskNumber('5491155550000')).toBe('+54 9 ····0000')
    expect(maskNumber('5215512345678')).toBe('+52 ····5678')
  })
})

describe("a client's name", () => {
  it('is cut and stripped before it is shown or sent on WhatsApp', () => {
    expect(cleanName('Claude')).toBe('Claude')
    expect(cleanName('  *Claude*\n<b>Pro</b> ')).toBe('Claude bPro/b')
    const long = cleanName('Claude para Escritorio con Extensiones de Productividad Personal')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('config', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    WHATSAPP_VERIFY_TOKEN: 'verify-token',
    META_APP_SECRET: 'm',
    WHATSAPP_PHONE_NUMBER_ID: '1',
    WHATSAPP_ACCESS_TOKEN: 't',
    GRAPH_API_VERSION: 'v23.0',
    ANTHROPIC_API_KEY: 'k',
  }
  const on = {
    ...env,
    PUBLIC_URL: 'https://heywarren.app',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    WHATSAPP_DISPLAY_NUMBER: '+54 9 11 5555-0000',
  }
  it('starts without the auth variables, and asks for all three once PUBLIC_URL is set', () => {
    expect(loadConfig(env).auth).toBeUndefined()
    const { BETTER_AUTH_SECRET: _a, WHATSAPP_DISPLAY_NUMBER: _b, ...half } = on
    expect(() => loadConfig(half)).toThrow(
      'Invalid environment: BETTER_AUTH_SECRET, WHATSAPP_DISPLAY_NUMBER',
    )
    expect(loadConfig({ ...on, PUBLIC_URL: 'https://heywarren.app/' }).auth).toEqual({
      publicUrl: 'https://heywarren.app',
      secret: 'x'.repeat(32),
      displayNumber: '+54 9 11 5555-0000',
    })
    expect(() => loadConfig({ ...on, PUBLIC_URL: 'http://heywarren.app' })).toThrow('PUBLIC_URL')
    expect(() => loadConfig({ ...on, BETTER_AUTH_SECRET: 'short' })).toThrow('BETTER_AUTH_SECRET')
  })
})
