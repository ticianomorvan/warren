import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cafe } from '../../test/core'
import {
  type App,
  browser,
  type Connected,
  EMAIL_A,
  EMAIL_B,
  mint,
  signInWithGoogle,
  withClaude,
} from '../auth-test-kit'
import { call, ok, rpc } from '../mcp-test-kit'
import { sql, TODAY, useDatabase } from '../test-harness'

/** The account page: disconnect every agent, download everything, delete it all behind a fresh sign-in. */
useDatabase({ max: 12 })

let app: App
let now = Date.now()
let a: Connected
let b: Connected

beforeEach(async () => {
  now = Date.now()
  ;({ app } = await withClaude({ accountNow: () => new Date(now) }))
  a = await mint(app, EMAIL_A)
  b = await mint(app, EMAIL_B)
})
afterEach(() => app.close())

const log = (who: Connected, description: string) =>
  call(app, who.access_token, 'warren_log_movements', {
    movements: [{ ...cafe({ date: TODAY }), description }],
  })
const post = (who: Connected, path: string) =>
  who.b.go(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const rowsOf = (email: string) => sql`
  SELECT
    (SELECT count(*)::int FROM account WHERE id = u.warren_account_id) AS account,
    (SELECT count(*)::int FROM turn WHERE account_id = u.warren_account_id) AS turns,
    (SELECT count(*)::int FROM movement WHERE account_id = u.warren_account_id) AS movements,
    (SELECT count(*)::int FROM fact WHERE account_id = u.warren_account_id) AS facts,
    (SELECT count(*)::int FROM auth_session WHERE "userId" = u.id) AS sessions,
    (SELECT count(*)::int FROM auth_oauth_refresh_token WHERE "userId" = u.id) AS refresh_tokens
  FROM auth_user u WHERE u.email = ${email}`

describe('the account page', () => {
  it('without a session shows the sign-in, with one shows who is in and the three actions', async () => {
    const out = await browser(app.base).go('/account')
    expect(out.status).toBe(200)
    expect(await out.text()).toContain('Continuar con Google')
    const page = await a.b.go('/account')
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain(EMAIL_A)
    expect(html).toContain('Desconectar todos los agentes')
    expect(html).toContain('Descargar mis datos')
    expect(html).toContain('Borrar mi cuenta')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('cache-control')).toBe('no-store')
  })

  it('every action needs the session, and the writes only from our own page', async () => {
    const anon = browser(app.base)
    expect((await post({ ...a, b: anon }, '/account/disconnect')).status).toBe(401)
    expect((await anon.go('/account/export')).status).toBe(401)
    expect((await post({ ...a, b: anon }, '/account/delete')).status).toBe(401)
    const cross = await fetch(`${app.base}/account/disconnect`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        cookie: [...a.b.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
    })
    expect(cross.status).toBe(403)
    // A GET does not change anything: the actions that write are POSTs.
    expect((await a.b.go('/account/disconnect')).status).toBe(405)
    expect((await a.b.go('/account/delete')).status).toBe(405)
  })
})

describe('disconnect all agents', () => {
  it('cuts the access tokens issued so far, only of this person, and a new sign-in works again', async () => {
    expect((await rpc(app, a.access_token, 'tools/list')).status).toBe(200)
    const res = await post(a, '/account/disconnect')
    expect(res.status).toBe(200)
    expect(
      (await sql`SELECT mcp_revoked_at FROM account ORDER BY id`)[0]?.mcp_revoked_at,
    ).toBeInstanceOf(Date)
    expect((await rpc(app, a.access_token, 'tools/list')).status).toBe(401)
    expect((await rpc(app, b.access_token, 'tools/list')).status).toBe(200)
    // The data is untouched, and a token issued after the disconnect is let in.
    expect((await rowsOf(EMAIL_A))[0]?.account).toBe(1)
    await new Promise((r) => setTimeout(r, 1100)) // a token's `iat` is in whole seconds
    const again = await mint(app, EMAIL_A)
    expect((await rpc(app, again.access_token, 'tools/list')).status).toBe(200)
  })
})

describe('download all data', () => {
  it('is a JSON file of this account’s rows, every version, and nothing of another account', async () => {
    ok(await log(a, 'café de a'), 'log_movements')
    ok(await log(b, 'café de b'), 'log_movements')
    await call(app, a.access_token, 'warren_remember_fact', {
      kind: 'note',
      key: 'cobro',
      value: 'el 5',
    })
    const res = await a.b.go('/account/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const data = (await res.json()) as {
      account: { email: string }
      turns: unknown[]
      movements: { description: string; amount: string }[]
      facts: { key: string }[]
    }
    expect(data.account.email).toBe(EMAIL_A)
    expect(data.movements.map((m) => [m.description, m.amount])).toEqual([['café de a', '3500']])
    expect(data.facts.map((f) => f.key)).toEqual(['cobro'])
    expect(data.turns).toHaveLength(2)
    expect(JSON.stringify(data)).not.toContain('café de b')
  })
})

describe('delete the account', () => {
  async function fill() {
    ok(await log(a, 'café de a'), 'log_movements')
    ok(await log(b, 'café de b'), 'log_movements')
    await call(app, a.access_token, 'warren_remember_fact', {
      kind: 'note',
      key: 'cobro',
      value: 'el 5',
    })
    await call(app, b.access_token, 'warren_remember_fact', {
      kind: 'note',
      key: 'luz',
      value: 'el 6',
    })
  }

  it('needs a sign-in younger than five minutes: an older session is told to sign in again, and nothing is deleted', async () => {
    await fill()
    now += 6 * 60 * 1000
    const page = await (await a.b.go('/account')).text()
    expect(page).not.toContain('data-do="delete"')
    expect(page).toContain('Volver a entrar con Google')
    const res = await post(a, '/account/delete')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'fresh_sign_in_required' })
    expect((await rowsOf(EMAIL_A))[0]).toMatchObject({ account: 1, movements: 1, facts: 1 })

    // Signing in with Google again makes the session fresh: now the delete goes through.
    await signInWithGoogle(a.b, { email: EMAIL_A, callbackURL: '/account' })
    now = Date.now()
    expect(await (await a.b.go('/account')).text()).toContain('data-do="delete"')
  })

  it('removes every row of that account and of nobody else, and ends its tokens and sessions', async () => {
    await fill()
    const before = (await rowsOf(EMAIL_B))[0]
    expect((await rowsOf(EMAIL_A))[0]).toMatchObject({
      account: 1,
      turns: 2,
      movements: 1,
      facts: 1,
    })
    const res = await post(a, '/account/delete')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/i)
    expect(await rowsOf(EMAIL_A)).toHaveLength(0) // the user itself is gone
    const left = await sql`
      SELECT (SELECT count(*)::int FROM account) AS accounts, (SELECT count(*)::int FROM movement) AS movements,
        (SELECT count(*)::int FROM fact) AS facts, (SELECT count(*)::int FROM turn) AS turns,
        (SELECT count(*)::int FROM auth_user) AS users,
        (SELECT count(*)::int FROM auth_account) AS logins,
        (SELECT count(*)::int FROM auth_oauth_access_token) AS access_tokens`
    expect(left[0]).toMatchObject({
      accounts: 1,
      movements: 1,
      facts: 1,
      turns: 2,
      users: 1,
      logins: 1,
    })
    expect((await rowsOf(EMAIL_B))[0]).toEqual(before)
    expect((await rpc(app, a.access_token, 'tools/list')).status).toBe(401)
    expect((await rpc(app, b.access_token, 'tools/list')).status).toBe(200)
    expect(
      (
        (await call(app, b.access_token, 'warren_list_facts')).structuredContent as {
          total: number
        }
      ).total,
    ).toBe(1)
  })

  it('a person can sign up again afterwards, with an empty ledger', async () => {
    await fill()
    await post(a, '/account/delete')
    const again = await mint(app, EMAIL_A)
    const found = await call(app, again.access_token, 'warren_find_movements')
    expect((found.structuredContent as { movements: unknown[] }).movements).toEqual([])
  })
})

describe('the one way out', () => {
  /** Every `.ts` and `.sql` file under a folder, with its text. */
  function sources(dir: string): [string, string][] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return sources(path)
      return /\.(ts|sql)$/.test(name)
        ? [[path, readFileSync(path, 'utf8')] as [string, string]]
        : []
    })
  }

  it('no code but the account page’s calls erase_account, and nothing sets the setting that lets a delete through', () => {
    const all = sources(join(import.meta.dirname, '..')).filter(
      ([path]) => !path.endsWith('.test.ts'),
    )
    const calls = all
      .filter(([, text]) => /erase_account\(/.test(text))
      .map(([path]) => path.split('/src/')[1])
    expect(calls.sort()).toEqual(['auth/account.ts', 'core/schema/002_auth.sql'])
    const sets = all
      .filter(([, text]) => text.includes('warren.erasing'))
      .map(([path]) => path.split('/src/')[1])
    expect(sets.sort()).toEqual(['core/schema/001_init.sql', 'core/schema/002_auth.sql'])
    // And no tool of the registry could be one: nothing an agent can call deletes an account.
    expect(readFileSync(join(import.meta.dirname, '../core/commands.ts'), 'utf8')).not.toMatch(
      /erase_account|account_delete|delete_account/,
    )
  })
})
