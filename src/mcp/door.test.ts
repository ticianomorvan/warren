import { createPrivateKey, sign } from 'node:crypto'
import { symmetricDecrypt } from 'better-auth/crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpUrl } from '../auth/config'
import {
  type App,
  CLIENT_ID,
  type Connected,
  claims,
  mint,
  WA_A,
  WA_B,
  withClaude,
} from '../auth-test-kit'
import { sql, useDatabase } from '../test-harness'

/**
 * The door of `/mcp` end to end: a real token minted through the real sign-in flow (a fake claude.ai, WhatsApp, consent, PKCE) is the
 * bearer of JSON-RPC calls over HTTP, and tokens forged with the real signing key change one claim or header each. The tools come
 * from the registry in R6; here the door is what is measured (an authenticated `tools/list` answers 200).
 */
useDatabase({ max: 12 })

const WA_C = '5491100000003'

let app: App
const rpc = (
  bearer: string | null,
  method: string,
  params: unknown = {},
  extra: Record<string, string> = {},
) => rpcOf(app, bearer, method, params, extra)
let a: Connected
let b: Connected
const forge = (over: Parameters<typeof forgeOf>[2] = {}) => forgeOf(app, a.userId, over)
/** The allow-list, one array shared by WhatsApp and the door: a test may take someone off it. */
let allowed: string[]

beforeEach(async () => {
  allowed = [WA_A, WA_B, WA_C]
  ;({ app } = await withClaude({ allowed }))
  a = await mint(app, WA_A)
  b = await mint(app, WA_B)
})
afterEach(() => app.close())

describe('the door', () => {
  it('a real token passes; a forged one signed with the same key and the same claims passes too (so the variants below test one thing each)', async () => {
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
    expect(claims(a.access_token).sub).toBe(a.userId)
    expect((await rpc(await forge(), 'tools/list')).status).toBe(200)
  })

  it('no token: 401 with the RFC 9728 challenge naming the metadata and the scopes', async () => {
    const r = await rpc(null, 'tools/list')
    expect(r.status).toBe(401)
    const challenge = r.headers.get('www-authenticate') ?? ''
    expect(challenge).toContain(
      `resource_metadata="${app.base}/.well-known/oauth-protected-resource/mcp"`,
    )
    expect(challenge).toContain('scope="ledger:read')
    expect(JSON.stringify(r.body)).not.toContain('Bearer')
  })

  const refused: [string, () => Promise<string>][] = [
    [
      'an audience that is not the MCP URL',
      () => forge({ claims: { aud: 'https://evil.example/mcp' } }),
    ],
    ['no audience', () => forge({ dropClaims: ['aud'] })],
    [
      'a token type that is not at+jwt (a session or ID token)',
      () => forge({ header: { typ: 'JWT' } }),
    ],
    ['no token type', () => forge({ header: { typ: undefined } })],
    ['no azp', () => forge({ dropClaims: ['azp'] })],
    ['another issuer', () => forge({ claims: { iss: 'https://evil.example' } })],
    ['an expired token', () => forge({ claims: { iat: 1_000, exp: 1_900 } })],
    ['a subject that is no user', () => forge({ sub: '00000000-0000-4000-8000-000000000000' })],
    ['a subject that is not a uuid', () => forge({ sub: "x'; drop table account; --" })],
    ['no subject', () => forge({ dropClaims: ['sub'] })],
    ['a bad signature', async () => `${(await forge()).slice(0, -6)}AAAAAA`],
    [
      'an unsigned token',
      async () =>
        `${Buffer.from('{"alg":"none"}').toString('base64url')}.${(await forge()).split('.')[1]}.`,
    ],
    ['garbage', async () => 'not-a-token'],
  ]
  it.each(refused)('401 with the challenge for %s', async (_name, make) => {
    const r = await rpc(await make(), 'tools/list')
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=')
    // Always the same answer: a token teaches nothing about which check it failed.
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: expect.any(String) },
      id: null,
    })
  })

  it('the session JWT of the person is not an access token', async () => {
    const session = await (app.auth as NonNullable<typeof app.auth>).api.getToken({
      headers: new Headers({ cookie: [...a.b.jar].map(([k, v]) => `${k}=${v}`).join('; ') }),
    })
    expect(session.token.split('.')).toHaveLength(3)
    expect((await rpc(session.token, 'tools/list')).status).toBe(401)
  })

  it('an account whose WhatsApp id is no longer allowed is refused, the others are not', async () => {
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
    allowed.splice(0, allowed.length, WA_B) // A was taken off the list
    const r = await rpc(a.access_token, 'tools/list')
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=')
    expect((await rpc(b.access_token, 'tools/list')).status).toBe(200)
    allowed.splice(0, allowed.length, '*')
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
  })

  it('a user whose account mapping is gone is refused', async () => {
    await sql`UPDATE auth_user SET warren_account_id = NULL WHERE id = ${a.userId}`
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(401)
  })

  it('a database that cannot answer is a 503, not a reason to sign in again', async () => {
    await sql`ALTER TABLE auth_user RENAME TO auth_user_away`
    try {
      const r = await rpc(a.access_token, 'tools/list')
      expect(r.status).toBe(503)
      expect(r.headers.get('www-authenticate')).toBeNull()
    } finally {
      await sql`ALTER TABLE auth_user_away RENAME TO auth_user`
    }
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
  })

  it('the signing keys unreadable (auth_jwks) is a 503 too, not a 500 and not a 401', async () => {
    await sql`ALTER TABLE auth_jwks RENAME TO auth_jwks_away`
    try {
      const r = await rpc(a.access_token, 'tools/list')
      expect(r.status).toBe(503)
      expect(r.headers.get('retry-after')).toBe('5')
      expect(r.headers.get('www-authenticate')).toBeNull()
    } finally {
      await sql`ALTER TABLE auth_jwks_away RENAME TO auth_jwks`
    }
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
  })

  it('a browser page of another site cannot call it, even with a token; ours and claude.ai/claude.com can', async () => {
    const withOrigin = (origin: string) => rpc(a.access_token, 'tools/list', {}, { origin })
    expect((await withOrigin('https://evil.example')).status).toBe(403)
    expect((await withOrigin('null')).status).toBe(403)
    expect((await withOrigin('http://localhost:3000')).status).toBe(403)
    for (const ok of [app.base, 'https://claude.ai', 'https://claude.com']) {
      expect((await withOrigin(ok)).status, ok).toBe(200)
    }
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200) // no Origin: not a browser
  })

  it('a malformed body is an answer, not a crash', async () => {
    const res = await fetch(`${app.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${a.access_token}`,
      },
      body: '{"jsonrpc":"2.0","id":1,"method":',
    })
    expect(res.status).toBeLessThan(500)
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
  })
})

// ---- The protocol

// ---- JSON-RPC and forged tokens

// biome-ignore lint/suspicious/noExplicitAny: a test reads JSON-RPC answers loosely
type Json = any

type Rpc = { status: number; headers: Headers; body: Record<string, Json> | null }

/** The answer is JSON or, for a legacy client, one SSE `message` event: both read the same. */
async function readBody(res: Response): Promise<Record<string, Json> | null> {
  const text = await res.text()
  if (!text) return null
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .at(-1)
    return data ? JSON.parse(data) : null
  }
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

let id = 0

async function rpcOf(
  app: App,
  bearer: string | null,
  method: string,
  params: unknown = {},
  extra: Record<string, string> = {},
) {
  const res = await fetch(`${app.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  return { status: res.status, headers: res.headers, body: await readBody(res) } satisfies Rpc
}

// ---- Tokens

/** A token as better-auth signs it, with any claim or header changed: the real signing key, taken out of the table. */
async function forgeOf(
  app: App,
  sub: string,
  over: {
    claims?: Record<string, unknown>
    header?: Record<string, unknown>
    sub?: string
    dropClaims?: string[]
  } = {},
) {
  const [key] =
    await sql`SELECT id, "privateKey" AS private FROM auth_jwks ORDER BY "createdAt" DESC LIMIT 1`
  const secret = (await (app.auth as NonNullable<typeof app.auth>).$context).secretConfig
  const jwk = JSON.parse(await symmetricDecrypt({ key: secret, data: JSON.parse(key?.private) }))
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    iss: app.base,
    aud: mcpUrl(app.base),
    sub: over.sub ?? sub,
    azp: CLIENT_ID,
    scope: 'ledger:read ledger:write',
    iat: now,
    exp: now + 900,
    ...over.claims,
  }
  for (const k of over.dropClaims ?? []) delete payload[k]
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const input = `${b64({ alg: 'EdDSA', typ: 'at+jwt', kid: key?.id, ...over.header })}.${b64(payload)}`
  const signature = sign(null, Buffer.from(input), createPrivateKey({ key: jwk, format: 'jwk' }))
  return `${input}.${signature.toString('base64url')}`
}
