import type { Profile } from '@warren/core'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser } from '../src/client'
import { appendProfile, latestProfile } from '../src/profile'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let a: string
let b: string

const profile = (income: string, name = 'Viaje'): Profile => ({
  monthly_income: income,
  currency: 'ARS',
  goals: [{ name, target: '3000', currency: 'USD', date: '2027-12-31' }],
  obligations: [{ name: 'Alquiler', amount: '600000', currency: 'ARS', due_day: 5 }],
  risk_limits: { emergency_months: 6 },
})

const save = (user: string, data: Profile) => asUser(t.app, user, (s) => appendProfile(s, data))
const latest = (user: string) => asUser(t.app, user, latestProfile)
const failure = (fn: () => Promise<unknown>) =>
  fn().then(
    () => 'accepted',
    (e: { cause?: unknown }) => String(e.cause ?? e),
  )

beforeAll(async () => {
  t = await testDatabase()
  a = await t.newUser('a')
  b = await t.newUser('b')
})

describe('profile', () => {
  it('has nothing until one is saved', async () => {
    expect(await latest(a)).toBeNull()
  })

  it('appends versions and reads the latest, unsealed', async () => {
    expect(await save(a, profile('100.00'))).toBe(1)
    expect(await save(a, profile('200.00', 'Auto'))).toBe(2)
    const got = await latest(a)
    expect(got?.version).toBe(2)
    expect(got?.profile).toEqual(profile('200.00', 'Auto'))
    const { rows } = await t.pg.query<{ n: number }>(
      'select count(*)::int n from profile where user_id = $1',
      [a],
    )
    expect(rows[0]?.n).toBe(2)
  })

  it('keeps the data sealed at rest', async () => {
    const { rows } = await t.pg.query<{ data: Uint8Array }>('select data from profile limit 1')
    expect(Buffer.from(rows[0]?.data ?? []).toString('utf8')).not.toContain('Alquiler')
  })

  it('gives concurrent saves consecutive versions, none lost', async () => {
    const before = (await latest(a))?.version ?? 0
    await Promise.all([1, 2, 3, 4, 5].map((n) => save(a, profile(`${n}00.00`))))
    expect((await latest(a))?.version).toBe(before + 5)
  })

  it('cannot be updated or deleted by the app, even for its own rows', async () => {
    const update = await failure(() =>
      asUser(t.app, a, (s) => s.tx.execute(sql`update profile set version = 99`)),
    )
    expect(update).toMatch(/permission denied/)
    const del = await failure(() => asUser(t.app, a, (s) => s.tx.execute(sql`delete from profile`)))
    expect(del).toMatch(/permission denied/)
  })

  it('refuses update and delete for every role, by trigger, except erasure deleting', async () => {
    const owner = await failure(async () => {
      await t.pg.query('update profile set version = version where user_id = $1', [a])
    })
    expect(owner).toMatch(/append-only/)
    const del = await failure(async () => {
      await t.pg.query('delete from profile where user_id = $1', [a])
    })
    expect(del).toMatch(/append-only/)
    const truncate = await failure(async () => {
      await t.pg.query('truncate profile')
    })
    expect(truncate).toMatch(/append-only/)
  })

  it("never shows one user's profile to another", async () => {
    expect(await latest(b)).toBeNull()
    await save(b, profile('7.00', 'Mía'))
    expect((await latest(b))?.profile.goals[0]?.name).toBe('Mía')
    expect((await latest(a))?.profile.goals[0]?.name).not.toBe('Mía')
    const seen = await asUser(t.app, b, (s) =>
      s.tx.execute(sql`select count(*)::int n from profile`),
    )
    expect((seen as { rows: { n: number }[] }).rows[0]?.n).toBe(1)
  })

  it('cannot write a row for another user', async () => {
    const stolen = await failure(() =>
      asUser(t.app, a, (s) =>
        s.tx.execute(sql`insert into profile (user_id, version, data) values (${b}, 50, '\\x00')`),
      ),
    )
    expect(stolen).toMatch(/row-level security/)
  })

  it("does not open a sealed value copied onto another user's row", async () => {
    await t.pg.exec('alter table profile disable trigger profile_no_mutation')
    try {
      await t.pg.query(
        `update profile set data = (select data from profile where user_id = $1 and version = 1)
         where user_id = $2`,
        [a, b],
      )
    } finally {
      await t.pg.exec('alter table profile enable trigger profile_no_mutation')
    }
    await expect(latest(b)).rejects.toThrow()
  })
})
