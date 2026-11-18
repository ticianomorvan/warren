import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { setCredentialPassword } from '../src/auth'
import { inSystemContext } from '../src/client'
import { authAccount, session } from '../src/schema'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user: string

const credentials = () =>
  inSystemContext(t.auth, (tx) => tx.select().from(authAccount).where(eq(authAccount.userId, user)))
const sessions = () =>
  inSystemContext(t.auth, (tx) => tx.select().from(session).where(eq(session.userId, user)))

beforeAll(async () => {
  t = await testDatabase()
  user = await t.newUser('set-password')
})

describe('setCredentialPassword', () => {
  it('gives a user without a password one, as warren_auth', async () => {
    expect(await credentials()).toEqual([])
    expect(await setCredentialPassword(t.auth, user, 'hash-one')).toBe('set')
    expect(await credentials()).toMatchObject([
      { providerId: 'credential', accountId: user, password: 'hash-one' },
    ])
  })

  it('replaces the password rather than adding a second, and ends the sessions', async () => {
    await inSystemContext(t.auth, (tx) =>
      tx.insert(session).values({
        userId: user,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    )
    expect(await sessions()).toHaveLength(1)
    expect(await setCredentialPassword(t.auth, user, 'hash-two')).toBe('set')
    expect(await credentials()).toMatchObject([{ password: 'hash-two' }])
    expect(await sessions()).toEqual([])
  })

  it('says so when the user does not exist, and writes nothing', async () => {
    expect(await setCredentialPassword(t.auth, randomUUID(), 'hash')).toBe('no-user')
  })
})
