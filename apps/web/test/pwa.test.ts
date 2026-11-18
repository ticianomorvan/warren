import type { MovementListItem } from '@warren/db'
import { describe, expect, it } from 'vitest'
import manifest from '../app/manifest'
import { env } from '../lib/env'
import { dayHeading, movementAmount, movementDetail, movementTitle } from '../lib/movements'
import { config } from '../proxy'

describe('what a signed-out browser may fetch to install the app', () => {
  // Next reads `matcher` as a path pattern; for this one a regular expression says the same.
  const guarded = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path)

  it('leaves the service worker, the manifest and the icons outside the sign-in guard', () => {
    for (const path of [
      '/sw.js',
      '/manifest.webmanifest',
      '/icons/icon-192.png',
      '/icons/icon-512.png',
    ]) {
      expect(guarded(path), path).toBe(false)
    }
  })

  it('still guards the pages', () => {
    for (const path of ['/', '/movements', '/sign-in', '/swordfish']) {
      expect(guarded(path), path).toBe(true)
    }
  })

  it('points the manifest at icons that exist and starts standalone', () => {
    const m = manifest()
    expect(m).toMatchObject({ name: 'Warren', display: 'standalone', start_url: '/' })
    expect(m.icons?.map((i) => i.src)).toContain('/icons/icon-192.png')
    expect(m.icons?.map((i) => i.src)).toContain('/icons/icon-512.png')
  })
})

describe('VAPID settings', () => {
  const set = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  it('is null until all three are set, and refuses a subject that is not a contact URL', () => {
    set({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, VAPID_SUBJECT: undefined })
    expect(env.vapid()).toBeNull()
    set({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.c' })
    expect(env.vapid()).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.c' })
    set({ VAPID_SUBJECT: 'ops' })
    expect(() => env.vapid()).toThrow('VAPID_SUBJECT')
    set({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, VAPID_SUBJECT: undefined })
  })
})

const base: MovementListItem = {
  id: 'm1',
  date: '2026-11-14',
  time: '14:09:00',
  type: 'unclassified',
  direction: 'out',
  amount: '1500.00000000',
  currency: 'ARS',
  counterpartyName: 'Juana Ejemplo',
  accountName: 'Bank ARS',
  counterAccountName: null,
  cardLastFour: null,
}

describe('movement rows', () => {
  it('shows a transfer sent: the other party, the account and time, a minus sign', () => {
    expect(movementTitle(base)).toBe('Juana Ejemplo')
    expect(movementDetail(base)).toBe('Transferencia enviada · Bank ARS · 14:09')
    expect(movementAmount(base)).toBe('−$ 1.500,00')
  })

  it('shows money received with a plus sign, and a purchase by its merchant', () => {
    expect(movementAmount({ ...base, direction: 'in' })).toBe('+$ 1.500,00')
    const purchase = {
      ...base,
      type: 'card_purchase' as const,
      counterpartyName: 'Kiosco',
      time: null,
    }
    expect(movementTitle(purchase)).toBe('Kiosco')
    expect(movementDetail(purchase)).toBe('Compra con tarjeta · Bank ARS')
  })

  it('shows a transfer between own accounts as a route, without a sign', () => {
    const own = {
      ...base,
      type: 'own_transfer' as const,
      counterpartyName: null,
      counterAccountName: 'Wallet ARS',
    }
    expect(movementTitle(own)).toBe('Transferencia entre tus cuentas')
    expect(movementDetail(own)).toBe('Bank ARS → Wallet ARS · 14:09')
    expect(movementAmount(own)).toBe('$ 1.500,00')
    expect(movementDetail({ ...own, direction: 'in' })).toBe('Wallet ARS → Bank ARS · 14:09')
  })

  it('names an unnamed party by what it is, and leaves out what is not known', () => {
    const unknown = { ...base, counterpartyName: null, accountName: null, time: null }
    expect(movementTitle(unknown)).toBe('Transferencia enviada')
    expect(movementDetail(unknown)).toBe('')
  })

  it('writes a day in Spanish, with the year only when it is not this one', () => {
    expect(dayHeading('2026-11-14', 2026)).toBe('14 de noviembre')
    expect(dayHeading('2025-01-02', 2026)).toBe('2 de enero de 2025')
  })
})
