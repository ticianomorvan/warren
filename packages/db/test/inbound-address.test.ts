import { isInboundToken } from '@warren/core'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, inUserContext } from '../src/client'
import { inboundAddressFor, revokeInboundAddress } from '../src/inbound-address'
import * as system from '../src/system'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let a: string
let b: string
const tokenOf = (user: string) => asUser(t.app, user, (scope) => inboundAddressFor(scope))

beforeAll(async () => {
  t = await testDatabase()
  a = await t.newUser('a')
  b = await t.newUser('b')
})

describe('the inbound address', () => {
  it('is made on the first call, has the token shape, and is the same afterwards', async () => {
    const first = await tokenOf(a)
    expect(isInboundToken(first)).toBe(true)
    expect(await tokenOf(a)).toBe(first)
  })

  it('makes one row however many calls race for it', async () => {
    const racer = await t.newUser('racer')
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => tokenOf(racer)))
    expect(new Set(tokens).size).toBe(1)
    const { rows } = await t.pg.query<{ n: number }>(
      'select count(*)::int n from inbound_address where user_id = $1',
      [racer],
    )
    expect(rows[0]?.n).toBe(1)
  })

  it('gives each user their own, and the lookup finds only the active one', async () => {
    const [ta, tb] = [await tokenOf(a), await tokenOf(b)]
    expect(ta).not.toBe(tb)
    expect(await system.userForInboundAddress(t.app, ta)).toBe(a)
    expect(await system.userForInboundAddress(t.app, tb)).toBe(b)
    expect(await system.userForInboundAddress(t.app, ta.toUpperCase())).toBe(a)
    expect(await system.userForInboundAddress(t.app, 'u-zzzzzzzzzzzzzzzzzzzzzz')).toBeNull()
  })

  it('revokes: the lookup stops, the next call makes a new address, the old row stays', async () => {
    const user = await t.newUser('rev')
    const old = await tokenOf(user)
    expect(await asUser(t.app, user, (s) => revokeInboundAddress(s))).toBe(true)
    expect(await asUser(t.app, user, (s) => revokeInboundAddress(s))).toBe(false)
    expect(await system.userForInboundAddress(t.app, old)).toBeNull()
    const fresh = await tokenOf(user)
    expect(fresh).not.toBe(old)
    expect(await system.userForInboundAddress(t.app, fresh)).toBe(user)
    const { rows } = await t.pg.query<{ n: number }>(
      'select count(*)::int n from inbound_address where user_id = $1',
      [user],
    )
    expect(rows[0]?.n).toBe(2)
  })

  it('refuses a second active address, a token that is not lower case base32, and a reused token', async () => {
    const insert = (user: string, token: string) =>
      inUserContext(t.app, user, (tx) =>
        tx.execute(sql`insert into inbound_address (token) values (${token})`),
      )
    await expect(insert(a, 'u-cccccccccccccccccccccc')).rejects.toThrow()
    const fresh = await t.newUser('fmt')
    await expect(insert(fresh, 'u-CCCCCCCCCCCCCCCCCCCCCC')).rejects.toThrow()
    await expect(insert(fresh, 'u-short')).rejects.toThrow()
    await expect(insert(fresh, await tokenOf(a))).rejects.toThrow()
  })

  it('lets the app change revoked_at and nothing else, and not delete, and hides other users', async () => {
    // Drizzle wraps the driver's error: the "permission denied" is in its cause.
    const run = (user: string, statement: string) =>
      inUserContext(t.app, user, (tx) => tx.execute(sql.raw(statement))).catch((e: unknown) => {
        throw new Error(String((e as { cause?: unknown }).cause ?? e))
      })
    await expect(run(b, 'update inbound_address set token = token')).rejects.toThrow(/permission/)
    await expect(run(b, `update inbound_address set user_id = '${a}'`)).rejects.toThrow(
      /permission/,
    )
    await expect(run(b, 'delete from inbound_address')).rejects.toThrow(/permission/)
    // B's update reaches B's rows only: A's address is still active.
    await run(b, 'update inbound_address set revoked_at = now()')
    expect(await system.userForInboundAddress(t.app, await tokenOf(a))).toBe(a)
  })
})
