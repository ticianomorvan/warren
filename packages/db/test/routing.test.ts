import type { RawStore } from '@warren/core'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, inSystemContext, inUserContext, provisionUser, rowsOf } from '../src/client'
import { createNoticeTenancy, createTenancy } from '../src/context'
import * as system from '../src/system'
import { seedFixtures } from '../src/tenancy-check'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let a: string
let b: string
const files = new Map<string, Uint8Array>()
const store: RawStore = {
  put: async (p, bytes) => void files.set(p, bytes),
  get: async (p) => files.get(p) ?? null,
  deletePrefix: async () => 0,
}

beforeAll(async () => {
  t = await testDatabase()
  a = await t.newUser('a')
  b = await t.newUser('b')
  await seedFixtures(t.owner, t.app, a, 'a')
  await seedFixtures(t.owner, t.app, b, 'b')
})

describe('routing before a user exists', () => {
  it('finds the user of a registered mailbox, whatever its case', async () => {
    const address = `a-${a.slice(0, 8)}@example.invalid`
    expect(await system.userForMailbox(t.app, address)).toBe(a)
    expect(await system.userForMailbox(t.app, address.toUpperCase())).toBe(a)
    expect(await system.userForMailbox(t.app, 'nobody@example.invalid')).toBeNull()
  })

  it('refuses to register an address that belongs to another user, and says nothing twice', async () => {
    const address = `a-${a.slice(0, 8)}@example.invalid`
    await expect(system.addMailbox(t.owner, b, address)).rejects.toThrow(/another user/)
    await system.addMailbox(t.owner, a, address)
    expect(await system.userForMailbox(t.app, address)).toBe(a)
  })

  it('cannot be used to read the table: the app sees only its own mailboxes, and cannot add any', async () => {
    const rows = await inUserContext(t.app, a, async (tx) =>
      rowsOf<{ user_id: string }>(await tx.execute(sql`select user_id from mailbox`)),
    )
    expect(rows.map((r) => r.user_id)).toEqual([a])
    await expect(
      inUserContext(t.app, a, (tx) =>
        tx.execute(sql`insert into mailbox (address) values ('mine@example.invalid')`),
      ),
    ).rejects.toThrow()
  })

  it('declares both functions security definer, with a fixed search_path, for warren_app only', async () => {
    const rows = await inSystemContext(t.owner, async (tx) =>
      rowsOf<{
        proname: string
        prosecdef: boolean
        cfg: string[]
        app: boolean
        auth: boolean
        eraser: boolean
      }>(
        await tx.execute(sql`
          select proname, prosecdef, coalesce(proconfig, '{}') as cfg,
                 has_function_privilege('warren_app', oid, 'execute') as app,
                 has_function_privilege('warren_auth', oid, 'execute') as auth,
                 has_function_privilege('warren_eraser', oid, 'execute') as eraser
          from pg_proc where proname in ('user_for_mailbox', 'user_for_wamid') order by proname`),
      ),
    )
    expect(rows.map((r) => r.proname)).toEqual(['user_for_mailbox', 'user_for_wamid'])
    for (const r of rows) {
      expect(r).toMatchObject({ prosecdef: true, app: true, auth: false, eraser: false })
      expect(r.cfg.join()).toContain('search_path=pg_catalog, pg_temp')
    }
  })

  it('finds the user of a WhatsApp message id', async () => {
    expect(await system.userForWamid(t.app, 'wamid.b')).toBe(b)
    expect(await system.userForWamid(t.app, 'wamid.unknown')).toBeNull()
  })

  it('notes an unclaimed delivery with no content, once, and cannot read it back', async () => {
    const delivery = {
      provider: 'resend',
      providerId: 'em_x',
      receivedAt: new Date('2026-11-14T10:00:00Z'),
    }
    await system.recordUnrouted(t.app, delivery)
    await system.recordUnrouted(t.app, delivery)
    const { rows } = await t.pg.query<{ n: number }>(
      'select count(*)::int n from unrouted_delivery',
    )
    expect(rows[0]?.n).toBe(1)
    await expect(
      inSystemContext(t.app, (tx) => tx.execute(sql`select * from unrouted_delivery`)),
    ).rejects.toThrow()
    await expect(t.pg.query('delete from unrouted_delivery')).rejects.toThrow(/append-only/)
  })

  it('gives intake only the user it acts for: their mailboxes, a sealing store', async () => {
    const tenancy = createTenancy(t.app, store)
    const address = `b-${b.slice(0, 8)}@example.invalid`
    expect(await tenancy.userForMailbox(address)).toBe(b)
    const ctx = await tenancy.withUser(b, async (c) => {
      await c.store.put(`u/${b}/x`, Buffer.from('raw bytes'), 'message/rfc822')
      expect(Buffer.from((await c.store.get(`u/${b}/x`)) ?? []).toString()).toBe('raw bytes')
      return { mailboxes: c.mailboxes, userId: c.userId }
    })
    expect(ctx).toEqual({ mailboxes: [address], userId: b })
    // In the shared store it is ciphertext.
    expect(Buffer.from(files.get(`u/${b}/x`) ?? []).includes(Buffer.from('raw bytes'))).toBe(false)
    // Another user cannot open it, even at the same path.
    await expect(
      tenancy.withUser(a, async (c) => {
        files.set(`u/${a}/x`, files.get(`u/${b}/x`) ?? new Uint8Array())
        return c.store.get(`u/${a}/x`)
      }),
    ).rejects.toThrow()
  })

  it('serves the legacy webhook through the same door', async () => {
    const tenancy = createNoticeTenancy(t.app)
    expect(await tenancy.userForWamid('wamid.a')).toBe(a)
    const known = await tenancy.withOutbox(a, (o) =>
      o.recordStatus({ wamid: 'wamid.a', status: 'read', errorCode: null, occurredAt: new Date() }),
    )
    expect(known).toBe(true)
    // B cannot record a status for A's message.
    expect(
      await tenancy.withOutbox(b, (o) =>
        o.recordStatus({
          wamid: 'wamid.a',
          status: 'failed',
          errorCode: 1,
          occurredAt: new Date(),
        }),
      ),
    ).toBe(false)
  })
})

describe('asUser', () => {
  it('refuses anything that is not a uuid, so nothing can be smuggled into the setting', async () => {
    await expect(asUser(t.app, "x'; drop table event; --", async () => {})).rejects.toThrow(/uuid/)
    await expect(asUser(t.app, '', async () => {})).rejects.toThrow(/uuid/)
  })

  it('leaves no user behind once the transaction is over', async () => {
    await asUser(t.app, a, async () => {})
    const rows = await inSystemContext(t.app, async (tx) =>
      rowsOf<{ id: string | null }>(await tx.execute(sql`select app_user_id() as id`)),
    )
    expect(rows[0]?.id).toBeNull()
  })

  it('rolls back everything when the callback fails', async () => {
    const before = await t.pg.query<{ n: number }>('select count(*)::int n from blob_file')
    await expect(
      asUser(t.app, a, async (scope) => {
        await scope.tx.execute(
          sql`insert into blob_file (mail_id, pathname, mime, bytes) values (${'9'.repeat(64)}, 'p', 'm', 1)`,
        )
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const after = await t.pg.query<{ n: number }>('select count(*)::int n from blob_file')
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
  })

  it('makes a key once, however many calls race for it, and none for a user that does not exist', async () => {
    const c = await t.newUser('c')
    await Promise.all([provisionUser(t.app, c), provisionUser(t.app, c), provisionUser(t.app, c)])
    const { rows } = await t.pg.query<{ n: number }>(
      'select count(*)::int n from user_key where user_id = $1',
      [c],
    )
    expect(rows[0]?.n).toBe(1)
    await expect(provisionUser(t.app, '00000000-0000-4000-8000-000000000000')).rejects.toThrow()
  })

  it('wraps each key so it only opens for its own user', async () => {
    const { rows } = await t.pg.query<{
      user_id: string
      wrapped_key: Uint8Array
      wrap_version: number
    }>('select user_id, wrapped_key, wrap_version from user_key where user_id in ($1, $2)', [a, b])
    expect(rows).toHaveLength(2)
    const { unwrapDataKey } = await import('@warren/core')
    const { masters } = await import('./helpers')
    const [first, second] = rows
    if (!first || !second) throw new Error('keys missing')
    expect(() =>
      unwrapDataKey(masters, second.user_id, first.wrapped_key, first.wrap_version),
    ).toThrow()
    expect(
      unwrapDataKey(masters, first.user_id, first.wrapped_key, first.wrap_version),
    ).toHaveLength(32)
  })
})
