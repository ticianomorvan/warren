import { asUser, createForwardingConfirmations, mailboxesOf } from '@warren/db'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { claimGmail } from '../app/onboarding/actions'
import { setup, signedInUser, t } from './harness'

const state = vi.hoisted(() => ({ userId: null as string | null, app: null as unknown }))
vi.mock('@/lib/session', () => ({
  getSession: async () => (state.userId ? { user: { id: state.userId } } : null),
}))
vi.mock('@/lib/db', () => ({ database: () => state.app }))
// Claiming re-checks stored mail; this user has none, so the deps are only asked for.
vi.mock('@/lib/intake', () => ({
  intakeDeps: () => ({
    tenancy: {
      withUser: async () => ({
        candidates: [],
        mailboxes: [],
        store: {},
        mailId: () => '',
      }),
    },
    resolver: async () => [],
    senders: [],
    maxDateSkewMinutes: 120,
    inboundDomain: 'in.heywarren.app',
  }),
}))

let a: string
let b: string
const mailboxes = (user: string) => asUser(t.app, user, mailboxesOf)

beforeAll(async () => {
  await setup()
  state.app = t.app
  a = (await signedInUser()).id
  b = (await signedInUser()).id
  await asUser(t.app, a, (s) =>
    createForwardingConfirmations(s).record(
      { address: 'persona@gmail.com', url: 'https://mail-settings.google.com/mail/vf-x' },
      new Date(),
    ),
  )
})

describe('claimGmail', () => {
  it('refuses without a session, and claims nothing', async () => {
    state.userId = null
    expect(await claimGmail('persona@gmail.com')).toEqual({ ok: false, reason: 'signed-out' })
    expect(await mailboxes(a)).toEqual([])
  })

  it('refuses an input that is not an address string', async () => {
    state.userId = a
    expect(await claimGmail({ address: 'persona@gmail.com' })).toEqual({
      ok: false,
      reason: 'failed',
    })
  })

  it("refuses another user's confirmation", async () => {
    state.userId = b
    expect(await claimGmail('persona@gmail.com')).toEqual({
      ok: true,
      status: 'no-confirmation',
      rescued: 0,
    })
    expect(await mailboxes(b)).toEqual([])
  })

  it('claims for the session user with their own confirmation', async () => {
    state.userId = a
    expect(await claimGmail('Persona@Gmail.com')).toEqual({
      ok: true,
      status: 'claimed',
      rescued: 0,
    })
    expect(await mailboxes(a)).toEqual(['persona@gmail.com'])
  })
})
