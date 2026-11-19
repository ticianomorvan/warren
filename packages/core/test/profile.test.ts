import { describe, expect, it } from 'vitest'
import { PROFILE_LIMITS, parseProfile } from '../src/advice'

const good = {
  monthly_income: '1500000.50',
  currency: 'ARS',
  goals: [{ name: ' Viaje ', target: '3000', currency: 'USD', date: '2027-12-31' }],
  obligations: [{ name: 'Alquiler', amount: '600000', currency: 'ARS', due_day: 5 }],
  risk_limits: { emergency_months: 6, max_share_in_usd: 40 },
}

const issues = (input: unknown) => {
  const r = parseProfile(input)
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`)
}

describe('parseProfile', () => {
  it('accepts a good profile and returns it clean (names trimmed, unknown fields dropped)', () => {
    const r = parseProfile({ ...good, extra: 'x', goals: [{ ...good.goals[0], note: 'y' }] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.profile.goals[0]).toEqual({
        name: 'Viaje',
        target: '3000',
        currency: 'USD',
        date: '2027-12-31',
      })
      expect(r.profile).not.toHaveProperty('extra')
    }
  })

  it('accepts the smallest profile', () => {
    const r = parseProfile({ currency: 'USD' })
    expect(r).toEqual({
      ok: true,
      profile: { currency: 'USD', goals: [], obligations: [], risk_limits: {} },
    })
  })

  it.each(['0', '0.00', '-5', '1e3', '1,5', '12.345', '', ' 5', '5.', '.5', '01', '1'.repeat(14)])(
    'rejects the amount %j',
    (amount) => {
      expect(issues({ ...good, monthly_income: amount })).toEqual(['monthly_income:amount'])
    },
  )

  it.each(['1', '0.01', '1500.5', '99999.99', '1'.repeat(13)])('accepts the amount %j', (a) => {
    expect(issues({ ...good, monthly_income: a })).toEqual([])
  })

  it('rejects numbers where strings belong, so a float never becomes money', () => {
    expect(issues({ ...good, monthly_income: 1500 })).toEqual(['monthly_income:amount'])
  })

  it('names the field of every problem', () => {
    expect(
      issues({
        currency: 'EUR',
        goals: [{ name: '', target: '0', currency: 'ARS', date: '2027-02-30' }],
        obligations: [{ name: 'x', amount: '1', currency: 'ARS', due_day: 32 }],
        risk_limits: { emergency_months: 61, max_share_in_usd: 50.5 },
      }),
    ).toEqual([
      'currency:currency',
      'goals.0.name:required',
      'goals.0.target:amount',
      'goals.0.date:date',
      'obligations.0.due_day:day',
      'risk_limits.emergency_months:out_of_range',
      'risk_limits.max_share_in_usd:whole_number',
    ])
  })

  it('caps the lists and the names', () => {
    const goal = good.goals[0]
    expect(
      issues({ ...good, goals: Array.from({ length: PROFILE_LIMITS.goals + 1 }, () => goal) }),
    ).toEqual(['goals:too_many'])
    expect(
      issues({
        ...good,
        obligations: Array.from(
          { length: PROFILE_LIMITS.obligations + 1 },
          () => good.obligations[0],
        ),
      }),
    ).toEqual(['obligations:too_many'])
    expect(
      issues({ ...good, goals: [{ ...goal, name: 'a'.repeat(PROFILE_LIMITS.name + 1) }] }),
    ).toEqual(['goals.0.name:too_long'])
    expect(
      parseProfile({ ...good, goals: Array.from({ length: PROFILE_LIMITS.goals }, () => goal) }).ok,
    ).toBe(true)
  })

  it('rejects things that are not a profile', () => {
    for (const input of [null, 'x', 4, [], undefined]) expect(parseProfile(input).ok).toBe(false)
  })

  it('checks real days', () => {
    const on = (date: string) => issues({ ...good, goals: [{ ...good.goals[0], date }] })
    expect(on('2028-02-29')).toEqual([])
    for (const bad of ['2027-02-29', '1999-01-01', '2027-1-1', 'mañana', ''])
      expect(on(bad), bad).toEqual(['goals.0.date:date'])
  })
})
