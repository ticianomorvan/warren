import { signupPolicy } from '@warren/core'
import { asUser, authSchema, provisionUser } from '@warren/db'
import { testDatabase } from '@warren/db/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { createAuth } from '../lib/auth-config'

let t: Awaited<ReturnType<typeof testDatabase>>
let auth: ReturnType<typeof createAuth>
const provisioned: string[] = []

const ALLOWED = 'ana@example.com'
const PASSWORD = 'a long enough password'
const signUp = (email: string, password = PASSWORD) =>
  auth.api.signUpEmail({ body: { name: 'Ana', email, password } })

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
    signup: signupPolicy(ALLOWED),
    onUserCreated: async (id) => {
      provisioned.push(id)
      await provisionUser(t.app, id)
    },
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
