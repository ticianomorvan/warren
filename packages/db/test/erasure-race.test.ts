import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, ERASURE_LOCK, rowsOf, UserErasedError } from '../src/client'
import { eraseUser } from '../src/erase'
import { seedFixtures } from '../src/tenancy-check'
import { testDatabase } from './helpers'

/*
 * Erasure against work in flight. PGlite is one connection, so two transactions can never
 * overlap here: what it can show is that every asUser holds the shared erasure lock, which is
 * what makes erasure wait for it on a real database, and that work that comes after erasure
 * finds the tombstone and never makes the user a new key. The overlap itself is not tested.
 */
let t: Awaited<ReturnType<typeof testDatabase>>
let user: string

beforeAll(async () => {
  t = await testDatabase()
  user = await t.newUser('race')
  await seedFixtures(t.owner, t.app, user, 'race', { tombstone: false })
})

const files = { deletePrefix: async () => 0 }

describe('erasure and work in flight', () => {
  it('holds the erasure lock shared for the whole of an asUser', async () => {
    const held = await asUser(t.app, user, async (scope) =>
      rowsOf<{ mode: string; granted: boolean }>(
        await scope.tx.execute(sql`
          select mode, granted from pg_locks
          where locktype = 'advisory' and pid = pg_backend_pid()
            and classid::bigint = ((hashtextextended(${user}::text, ${ERASURE_LOCK}) >> 32) & 4294967295)
            and objid::bigint = (hashtextextended(${user}::text, ${ERASURE_LOCK}) & 4294967295)`),
      ),
    )
    expect(held).toEqual([{ mode: 'ShareLock', granted: true }])
    // And it is released with the transaction.
    const after = await t.pg.query<{ n: number }>(
      "select count(*)::int n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()",
    )
    expect(after.rows[0]?.n).toBe(0)
  })

  it('finds the tombstone after erasure and never makes a new key', async () => {
    await eraseUser(t.eraser, user, files)
    for (const spelling of [user, user.toUpperCase()]) {
      await expect(asUser(t.app, spelling, async () => 'ran')).rejects.toBeInstanceOf(
        UserErasedError,
      )
    }
    const keys = await t.pg.query<{ n: number }>(
      'select count(*)::int n from user_key where user_id = $1',
      [user],
    )
    expect(keys.rows[0]?.n).toBe(0)
  })
})
