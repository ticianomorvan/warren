import { signupPolicy } from '@warren/core'
import { asUser, authSchema, eraseUser, provisionUser } from '@warren/db'
import { testDatabase } from '@warren/db/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { createAuth } from '../lib/auth-config'

let t: Awaited<ReturnType<typeof testDatabase>>
let auth: ReturnType<typeof createAuth>
const provisioned: string[] = []

const ALLOWED = 'ana@example.com'
const PASSWORD = 'a long enough password'
const ALL_ALLOWED = [ALLOWED, 'dan@example.com', 'eve@example.com', 'fay@example.com'].join(',')
const signUp = (email: string, password = PASSWORD) =>
  auth.api.signUpEmail({ body: { name: 'Ana', email, password } })

/** What Better Auth logged at warn level or above, which is all it is let to say. */
const logs: string[] = []

/** A request as a browser makes it, through the router (rate limiting lives there). */
const post = (path: string, body: unknown, ip: string) =>
  auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify(body),
    }),
  )

/** Reads as the owner: Better Auth's connection below is warren_auth, who may not read it. */
async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await t.pg.exec('reset role')
  try {
    return await fn()
  } finally {
    await t.pg.exec('set role warren_auth')
  }
}

beforeAll(async () => {
  t = await testDatabase()
  // From here every statement of Better Auth runs as warren_auth, so a missing grant fails
  // the test. Transactions of `t.app` still switch to warren_app for themselves.
  await t.pg.exec('set role warren_auth')
  auth = createAuth({
    db: drizzle(t.pg, { schema: authSchema }),
    secret: 'test-secret-test-secret-test-secret-0',
    baseURL: 'http://localhost:3000',
    signup: signupPolicy(ALL_ALLOWED),
    onUserCreated: async (id) => {
      provisioned.push(id)
      await provisionUser(t.app, id)
    },
    log: (level, message, ...args) => void logs.push([level, message, ...args].join(' ')),
  })
})

const keyRows = (id: string) =>
  asOwner(async () => (await t.pg.query('select 1 from user_key where user_id = $1', [id])).rows)

describe('sign-up gate', () => {
  it('lets an allow-listed email sign up, and sign in with its password only', async () => {
    const { user } = await signUp('ANA@example.com')
    expect(user.email).toBe(ALLOWED)
    expect(
      await auth.api.signInEmail({ body: { email: ALLOWED, password: PASSWORD } }),
    ).toMatchObject({
      user: { id: user.id },
    })
    await expect(
      auth.api.signInEmail({ body: { email: ALLOWED, password: 'not the password' } }),
    ).rejects.toMatchObject({ status: 'UNAUTHORIZED' })
  })

  it('refuses any other email, and writes no user, account or key', async () => {
    await expect(signUp('mallory@example.com')).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { message: 'signup_closed' },
    })
    const { rows } = await asOwner(() =>
      t.pg.query<{ n: number }>(
        `select (select count(*) from "user" where email = 'mallory@example.com')::int
              + (select count(*) from auth_account a join "user" u on u.id = a.user_id
                 where u.email = 'mallory@example.com')::int as n`,
      ),
    )
    expect(rows[0]?.n).toBe(0)
  })

  it('refuses a short password', async () => {
    await expect(signUp(ALLOWED, 'short')).rejects.toBeTruthy()
  })
})

describe('data key hook', () => {
  it('makes the new user a data key as soon as the user exists', async () => {
    const { rows } = await asOwner(() =>
      t.pg.query<{ id: string }>(`select id from "user" where email = $1`, [ALLOWED]),
    )
    const id = rows[0]?.id ?? ''
    expect(provisioned).toEqual([id])
    expect(await keyRows(id)).toHaveLength(1)
  })

  it('is idempotent: provisioning again, or the lazy backstop, keeps the one key', async () => {
    const id = provisioned[0] ?? ''
    await provisionUser(t.app, id)
    await asUser(t.app, id, async () => {})
    expect(await keyRows(id)).toHaveLength(1)
  })

  it('does not fail the sign-up when the key cannot be made; asUser makes it later', async () => {
    const lenient = createAuth({
      db: drizzle(t.pg, { schema: authSchema }),
      secret: 'test-secret-test-secret-test-secret-0',
      baseURL: 'http://localhost:3000',
      signup: signupPolicy('bob@example.com'),
      onUserCreated: async () => {
        throw new Error('database unavailable')
      },
    })
    const { user } = await lenient.api.signUpEmail({
      body: { name: 'Bob', email: 'bob@example.com', password: PASSWORD },
    })
    expect(await keyRows(user.id)).toHaveLength(0)
    await asUser(t.app, user.id, async () => {})
    expect(await keyRows(user.id)).toHaveLength(1)
  })
})

describe('sign-up answers the same for every email it will not accept', () => {
  const body = (email: string) => ({ name: 'X', email, password: PASSWORD })

  it('says 403 to an unlisted email, whether or not an account already has it', async () => {
    // An account with an unlisted email exists (made when it was listed), and one does not.
    const earlier = createAuth({
      db: drizzle(t.pg, { schema: authSchema }),
      secret: 'test-secret-test-secret-test-secret-0',
      baseURL: 'http://localhost:3000',
      signup: signupPolicy('known@example.com'),
      onUserCreated: async () => {},
    })
    await earlier.api.signUpEmail({ body: body('known@example.com') })

    const known = await post('/sign-up/email', body('known@example.com'), '198.51.100.1')
    const unknown = await post('/sign-up/email', body('nobody@example.com'), '198.51.100.2')
    expect(known.status).toBe(403)
    expect(unknown.status).toBe(known.status)
    expect(await unknown.text()).toBe(await known.text())
  })

  it('says 403 with the same body to a request with no email at all', async () => {
    const none = await post('/sign-up/email', { name: 'X', password: PASSWORD }, '198.51.100.3')
    const other = await post('/sign-up/email', body('nobody@example.com'), '198.51.100.4')
    expect(none.status).toBe(403)
    expect(await none.text()).toBe(await other.text())
  })

  it('does not log any email, even for an address that already has an account', async () => {
    const again = await post('/sign-up/email', body(ALLOWED), '198.51.100.5')
    expect(again.status).toBe(422)
    await post(
      '/sign-in/email',
      { email: 'nobody@example.com', password: PASSWORD },
      '198.51.100.6',
    )
    await post('/sign-in/email', { email: ALLOWED, password: 'wrong wrong wrong' }, '198.51.100.7')
    expect(logs.join('\n')).not.toMatch(/@example\.com/)
  })

  it('does not let a client set erasedAt', async () => {
    const res = await post(
      '/sign-up/email',
      { ...body('fay@example.com'), erasedAt: new Date().toISOString() },
      '198.51.100.8',
    )
    const rows = await asOwner(() =>
      t.pg.query<{ erased_at: Date | null }>(
        `select erased_at from "user" where email = 'fay@example.com'`,
      ),
    )
    expect(rows.rows.every((r) => r.erased_at === null)).toBe(true)
    expect([200, 400]).toContain(res.status)
  })
})

describe('rate limiting', () => {
  it('refuses a client that keeps trying a password, in the database, not in memory', async () => {
    const attempt = () =>
      post('/sign-in/email', { email: ALLOWED, password: 'not the password!' }, '203.0.113.9')
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await attempt()).status)
    // Five tries per minute; the rest are refused.
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429])
    const rows = await asOwner(() =>
      t.pg.query<{ key: string; count: number }>(`select key, count from rate_limit`),
    )
    expect(rows.rows.find((r) => r.key.includes('203.0.113.9'))?.count).toBeGreaterThanOrEqual(5)
  })

  it('counts each client address on its own', async () => {
    const res = await post(
      '/sign-in/email',
      { email: ALLOWED, password: 'not the password!' },
      '203.0.113.10',
    )
    expect(res.status).toBe(401)
  })

  it('limits sign-up the same way', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (
          await post(
            '/sign-up/email',
            { name: 'X', email: `x${i}@example.org`, password: PASSWORD },
            '203.0.113.11',
          )
        ).status,
      )
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429])
  })
})

describe('creating a user', () => {
  it('writes the user and the credential together or not at all', async () => {
    // The credential insert is refused (the grant is gone), after the user insert succeeded.
    await asOwner(() => t.pg.exec('revoke insert on auth_account from warren_auth'))
    try {
      await expect(signUp('eve@example.com')).rejects.toBeTruthy()
    } finally {
      await asOwner(() => t.pg.exec('grant insert on auth_account to warren_auth'))
    }
    const rows = await asOwner(() =>
      t.pg.query(`select 1 from "user" where email = 'eve@example.com'`),
    )
    expect(rows.rows).toHaveLength(0)
    // And with the grant back, the same sign-up works.
    expect((await signUp('eve@example.com')).user.email).toBe('eve@example.com')
  })
})

describe('an erased user', () => {
  const email = 'dan@example.com'
  let id: string
  let cookie: string

  it('signs up and in, and has a session', async () => {
    id = (await signUp(email)).user.id
    const { headers } = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      returnHeaders: true,
    })
    cookie = (headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toMatchObject({
      user: { id },
    })
  })

  it('cannot sign in, has no session, no credential, and the row holds no email or name', async () => {
    const report = await eraseUser({ eraser: t.eraser, auth: t.auth }, id, {
      deletePrefix: async () => 0,
    })
    expect(report.auth.accounts).toBe(1)
    expect(report.auth.sessions).toBeGreaterThanOrEqual(1)

    await expect(
      auth.api.signInEmail({ body: { email, password: PASSWORD } }),
    ).rejects.toMatchObject({ status: 'UNAUTHORIZED' })
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull()

    const { rows } = await asOwner(() =>
      t.pg.query<{
        sessions: number
        accounts: number
        email: string
        name: string
        erased: boolean
      }>(
        `select (select count(*) from session where user_id = $1)::int as sessions,
                (select count(*) from auth_account where user_id = $1)::int as accounts,
                email, name, erased_at is not null as erased
           from "user" where id = $1`,
        [id],
      ),
    )
    expect(rows[0]).toEqual({
      sessions: 0,
      accounts: 0,
      email: `erased+${id}@invalid`,
      name: 'erased',
      erased: true,
    })
  })

  it('is refused a session by the hook, with the database trigger behind it', async () => {
    const context = await auth.$context
    await expect(context.internalAdapter.createSession(id)).rejects.toMatchObject({
      body: { message: 'account_erased' },
    })
  })

  it('frees the address: it is a new person who signs up with it', async () => {
    const again = await signUp(email)
    expect(again.user.id).not.toBe(id)
  })
})
