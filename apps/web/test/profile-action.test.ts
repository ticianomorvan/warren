import { asUser, latestProfile } from '@warren/db'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { saveProfile } from '../app/profile/actions'
import { asOwner, setup, signedInUser, t } from './harness'

// The action reaches the session and the database through these two modules; stand in for both.
const state = vi.hoisted(() => ({ userId: null as string | null, app: null as unknown }))
vi.mock('@/lib/session', () => ({
  getSession: async () => (state.userId ? { user: { id: state.userId } } : null),
}))
vi.mock('@/lib/db', () => ({ database: () => state.app }))

const good = {
  monthly_income: '1500000.50',
  currency: 'ARS',
  goals: [{ name: 'Viaje', target: '3000', currency: 'USD', date: '2027-12-31' }],
  obligations: [],
  risk_limits: { emergency_months: 6 },
}

let a: string
let b: string
const rows = (user: string) =>
  asOwner(async () => {
    const r = await t.pg.query<{ n: number }>(
      'select count(*)::int n from profile where user_id = $1',
      [user],
    )
    return r.rows[0]?.n
  })

beforeAll(async () => {
  await setup()
  state.app = t.app
  a = (await signedInUser()).id
  b = (await signedInUser()).id
})

describe('saveProfile', () => {
  it('refuses without a session, and writes nothing', async () => {
    state.userId = null
    expect(await saveProfile(good)).toEqual({ ok: false, reason: 'signed-out' })
    expect(await rows(a)).toBe(0)
    expect(await rows(b)).toBe(0)
  })

  it('writes only for the session user, whatever user id the input names', async () => {
    state.userId = a
    const result = await saveProfile({ ...good, user_id: b, userId: b, version: 99 })
    expect(result).toEqual({ ok: true, version: 1 })
    expect(await rows(a)).toBe(1)
    expect(await rows(b)).toBe(0)
    expect((await asUser(t.app, a, latestProfile))?.profile?.monthly_income).toBe('1500000.50')
    expect(await asUser(t.app, b, latestProfile)).toBeNull()
  })

  it('returns the issues of an invalid profile and writes nothing', async () => {
    state.userId = b
    const result = await saveProfile({ ...good, monthly_income: '1.500.000,50' })
    expect(result).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [{ path: 'monthly_income', code: 'amount' }],
    })
    expect(await rows(b)).toBe(0)
  })
})
