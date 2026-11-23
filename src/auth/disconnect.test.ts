import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type App,
  browser,
  CLIENT_ID,
  type Connected,
  claims,
  connect,
  mint,
  pkce,
  REDIRECT,
  token,
  WA_A,
  WA_B,
  whatsapp,
  withClaude,
} from '../auth-test-kit'
import { call, ok, rpc } from '../mcp-test-kit'
import { sql, useDatabase } from '../test-harness'
import { REPLY_DISCONNECT } from './answer'

/**
 * "desconectar" (`disconnect.ts`) end to end. It deletes better-auth's rows with SQL, one of them by a `LIKE` on the JSON value of a
 * pending authorization code (better-auth's adapter has no "delete where the JSON holds"): the test of the code issued just before
 * the cut pins that fragment, so a better-auth change of how it stores the code fails here and not silently in production.
 */
useDatabase({ max: 12 })

const WA_C = '5491100000003'

let app: App
let a: Connected
let b: Connected

beforeEach(async () => {
  ;({ app } = await withClaude({ allowed: [WA_A, WA_B, WA_C] }))
  a = await mint(app, WA_A)
  b = await mint(app, WA_B)
})
afterEach(() => app.close())

describe('"desconectar"', () => {
  it('cuts the connection: a live token dies on its next call, the refresh token fails, consents and sessions go', async () => {
    expect((await rpc(app, a.access_token, 'tools/list')).status).toBe(200)
    expect(ok(await call(app, a.access_token, 'warren_list_facts'), 'list_facts').total).toBe(0)
    const modelBefore = app.model.n

    expect((await whatsapp(app, WA_A, 'desconectar'))[0]).toBe(REPLY_DISCONNECT.done(1))
    expect(app.model.n).toBe(modelBefore)

    const dead = await rpc(app, a.access_token, 'tools/list')
    expect(dead.status).toBe(401)
    expect(dead.headers.get('www-authenticate')).toContain('resource_metadata=')
    const refreshed = await token(a.b, {
      grant_type: 'refresh_token',
      refresh_token: a.refresh_token,
      client_id: CLIENT_ID,
    })
    expect(refreshed.status).toBe(400)
    expect(((await refreshed.json()) as { error: string }).error).toBe('invalid_grant')
    const [after] = await sql`
      SELECT (SELECT count(*) FROM auth_oauth_consent WHERE "userId" = ${a.userId}::uuid)::int AS consents,
             (SELECT count(*) FROM auth_session WHERE "userId" = ${a.userId}::uuid)::int AS sessions,
             (SELECT count(*) FROM auth_oauth_refresh_token WHERE "userId" = ${a.userId}::uuid AND revoked IS NULL)::int AS refresh,
             (SELECT mcp_revoked_at IS NOT NULL FROM account WHERE id = (SELECT warren_account_id FROM auth_user WHERE id = ${a.userId}::uuid)) AS stamped`
    expect(after).toEqual({ consents: 0, sessions: 0, refresh: 0, stamped: true })
    // Nobody else's connection was touched.
    expect((await rpc(app, b.access_token, 'tools/list')).status).toBe(200)
  })

  it('an authorization code issued just before the cut cannot be exchanged after it (pins the LIKE on better-auth’s stored value)', async () => {
    const c = browser(app.base)
    const { verifier, challenge } = pkce()
    // The consent was given and the client holds a code, not yet exchanged.
    const back = await connect(app, c, { challenge, from: WA_C })
    const code = back.searchParams.get('code') ?? ''
    expect(code).not.toBe('')
    const pending = () =>
      sql`SELECT 1 FROM auth_verification WHERE value LIKE '%authorization_code%'`
    expect(await pending()).toHaveLength(1)
    expect((await whatsapp(app, WA_C, 'desconectar'))[0]).toBe(REPLY_DISCONNECT.done(1))
    expect(await pending()).toHaveLength(0)
    const exchanged = await token(c, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: `${app.base}/mcp`,
    })
    expect(exchanged.status).toBe(400)
    expect(((await exchanged.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('also by "desconectá a Claude", and says when there was nothing to cut', async () => {
    expect((await whatsapp(app, WA_A, 'desconectá a Claude'))[0]).toBe(REPLY_DISCONNECT.done(1))
    expect((await whatsapp(app, WA_A, 'Desconectar.'))[0]).toBe(REPLY_DISCONNECT.none)
  })

  it('the person can connect again: a new sign-in gives tokens newer than the cut, and the old one stays dead', async () => {
    await whatsapp(app, WA_A, 'desconectar')
    await new Promise((r) => setTimeout(r, 1100)) // tokens are stamped in whole seconds
    const again = await mint(app, WA_A)
    expect(claims(again.access_token).iat).toBeGreaterThan(claims(a.access_token).iat)
    expect(ok(await call(app, again.access_token, 'warren_list_facts'), 'list_facts').total).toBe(0)
    expect((await rpc(app, a.access_token, 'tools/list')).status).toBe(401)
  })
})
