import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, inUserContext } from '../src/client'
import { eraseUser } from '../src/erase'
import { verifyChain } from '../src/ledger'
import * as system from '../src/system'
import { seedFixtures } from '../src/tenancy-check'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>

beforeAll(async () => {
  t = await testDatabase()
})

describe('a user id in upper case', () => {
  it('reaches the same key: sealed under one spelling, opens under the other', async () => {
    const id = await t.newUser('upper')
    const upper = id.toUpperCase()
    expect(upper).not.toBe(id)
    // The key is made on the first call, and its associated data is the user id: made through
    // the upper-case spelling it must still be the canonical one.
    const sealed = await asUser(t.app, upper, async (scope) => {
      expect(scope.userId).toBe(id)
      return { box: scope.seal('hola', 'x:1'), mail: scope.mailId(Buffer.from('m')) }
    })
    await asUser(t.app, id, async (scope) => {
      expect(scope.open(sealed.box, 'x:1').toString()).toBe('hola')
      expect(scope.mailId(Buffer.from('m'))).toBe(sealed.mail)
    })
    const keys = await t.pg.query<{ n: number }>(
      'select count(*)::int n from user_key where user_id = $1',
      [id],
    )
    expect(keys.rows[0]?.n).toBe(1)
  })

  it('reaches the same chain: written through one spelling, verified through both', async () => {
    const id = await t.newUser('chain')
    await seedFixtures(t.owner, t.app, id.toUpperCase(), 'chain')
    const lower = await verifyChain(t.app, id)
    const upper = await verifyChain(t.app, id.toUpperCase())
    expect(lower).toMatchObject({ ok: true, events: 1, brokenAt: null })
    expect(upper).toEqual(lower)
  })

  it('lets addMailbox run again with either spelling', async () => {
    const id = await t.newUser('mailbox')
    await system.addMailbox(t.owner, id.toUpperCase(), 'upper@example.invalid')
    await system.addMailbox(t.owner, id.toUpperCase(), 'upper@example.invalid')
    await system.addMailbox(t.owner, id, 'upper@example.invalid')
    expect(await system.userForMailbox(t.app, 'upper@example.invalid')).toBe(id)
  })

  it('sets the context to the canonical id', async () => {
    const id = await t.newUser('context')
    const seen = await inUserContext(t.app, id.toUpperCase(), async (tx) =>
      JSON.stringify(
        await tx.execute(
          (await import('drizzle-orm')).sql`select current_setting('app.user_id') as id`,
        ),
      ),
    )
    expect(seen).toContain(id)
  })

  it('erases the files under the canonical prefix', async () => {
    const id = await t.newUser('erase')
    const prefixes: string[] = []
    await eraseUser(t, id.toUpperCase(), {
      deletePrefix: async (p) => (prefixes.push(p), 0),
    })
    expect(prefixes).toEqual([`u/${id}/`])
  })
})
