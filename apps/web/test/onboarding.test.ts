import { REJECT_REASONS } from '@warren/core'
import { asUser, createForwardingConfirmations } from '@warren/db'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { onboardingStatus } from '../app/onboarding/actions'
import { GET } from '../app/onboarding/filter.xml/route'
import { kindText, reasonText } from '../lib/onboarding'
import { stepStates } from '../lib/steps'
import { t as strings } from '../lib/strings'
import { setup, signedInUser, t } from './harness'

const state = vi.hoisted(() => ({ userId: null as string | null, app: null as unknown }))
vi.mock('@/lib/session', () => ({
  getSession: async () => (state.userId ? { user: { id: state.userId } } : null),
}))
vi.mock('@/lib/db', () => ({ database: () => state.app }))
vi.mock('@/lib/env', () => ({ env: { inboundDomain: () => 'in.heywarren.app' } }))

beforeAll(async () => {
  await setup()
  state.app = t.app
})

describe('reject reasons', () => {
  it('has Spanish words for every RejectReason', () => {
    expect(Object.keys(strings.onboarding.reasons).sort()).toEqual([...REJECT_REASONS].sort())
    for (const reason of REJECT_REASONS) expect(reasonText(reason).length).toBeGreaterThan(10)
    expect(reasonText('something-new')).toBe(strings.onboarding.reasonUnknown)
    expect(reasonText(null)).toBe(strings.onboarding.reasonUnknown)
  })
  it('names the kind of notice without detail', () => {
    expect(kindText('bbva.card-purchase')).toBe('Compra con tarjeta')
    expect(kindText('bbva.transfer-sent')).toBe('Transferencia')
    expect(kindText(null)).toBe('Aviso del banco')
  })
})

describe('stepStates', () => {
  const states = (
    hasConfirmation: boolean,
    hasMailbox: boolean,
    verified: boolean,
    opened = false,
  ) => stepStates({ hasConfirmation, hasMailbox, verified, opened })
  it('starts at step 1', () => {
    expect(states(false, false, false)).toEqual(['current', 'todo', 'todo', 'todo', 'todo', 'todo'])
  })
  it('moves to step 2 once Google asked', () => {
    expect(states(true, false, false)).toEqual(['done', 'current', 'todo', 'todo', 'todo', 'todo'])
  })
  it('moves to step 3 once the link was opened', () => {
    expect(states(true, false, false, true)).toEqual([
      'done',
      'done',
      'current',
      'todo',
      'todo',
      'todo',
    ])
    expect(states(false, false, false, true)[1]).toBe('todo')
  })
  it('a claim finishes 1 to 3', () => {
    expect(states(true, true, false)).toEqual(['done', 'done', 'done', 'current', 'todo', 'todo'])
    expect(states(false, true, false)[0]).toBe('done')
  })
  it('a verified mail leaves only the agent', () => {
    expect(states(true, true, true)).toEqual(['done', 'done', 'done', 'done', 'done', 'current'])
  })
})

describe('onboardingStatus', () => {
  it('refuses without a session', async () => {
    state.userId = null
    expect(await onboardingStatus()).toEqual({ ok: false })
  })
  it('holds counts and words only, never an address or a link', async () => {
    const id = (await signedInUser()).id
    state.userId = id
    await asUser(t.app, id, (s) =>
      createForwardingConfirmations(s).record(
        { address: 'ana@gmail.com', url: 'https://mail-settings.google.com/mail/vf-secret' },
        new Date(),
      ),
    )
    const status = await onboardingStatus()
    expect(status).toEqual({ ok: true, pending: 1, hasMailbox: false, mail: { state: 'waiting' } })
    expect(JSON.stringify(status)).not.toMatch(/gmail|mail-settings|vf-secret/)
  })
})

describe('GET /onboarding/filter.xml', () => {
  it('refuses without a session', async () => {
    state.userId = null
    expect((await GET()).status).toBe(401)
  })
  it("returns the user's own address as a download", async () => {
    state.userId = (await signedInUser()).id
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="warren-filtro.xml"')
    const body = await res.text()
    expect(body).toMatch(/name="forwardTo" value="u-[a-z2-7]{22}@in\.heywarren\.app"/)
    expect(body).toContain('avisos@bbva.com.ar')
    expect(body).toContain('avisos-bbva-ar@bbva.com')
  })
})
