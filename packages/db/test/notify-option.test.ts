import type { BankOperation } from '@warren/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, type Scope } from '../src/client'
import { createLedger } from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import { sha, testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user: string

const operation = (reference: string): BankOperation => ({
  kind: 'transfer_out',
  amount: '1500.00',
  currency: 'ARS',
  date: '2026-11-14',
  time: '14:09',
  ownAccount: null,
  counterparty: { name: 'Juana Ejemplo', account: '0170099220000012345670', taxId: '20123456786' },
  reference,
  reason: 'VARIOS',
})

const record = (c: string, reference: string, options?: { notify?: boolean }) =>
  asUser(t.app, user, async (scope: Scope) => {
    await createMailLog(scope).recordMail({
      mailId: sha(c),
      pathname: `u/${user}/mail/${sha(c)}.eml.sealed`,
      bytes: 10,
      provider: 'resend',
      providerId: `em_${c}`,
      receivedAt: new Date('2026-11-14T17:10:00Z'),
    })
    return createLedger(scope).recordMailOperation(
      { mailId: sha(c), templateId: 'bbva.transfer-sent', operation: operation(reference) },
      options,
    )
  })

const counts = async () => {
  const { rows } = await t.pg.query<{ movements: number; notices: number }>(
    `select (select count(*) from movement where user_id = $1)::int as movements,
            (select count(*) from notice where user_id = $1)::int as notices`,
    [user],
  )
  return rows[0]
}

beforeAll(async () => {
  t = await testDatabase()
  user = await t.newUser('notify-option')
})

describe('recordMailOperation notify option', () => {
  it('creates a movement and a notice by default, as live intake does', async () => {
    expect(await record('a', '1')).toMatchObject({ outcome: 'created' })
    expect(await counts()).toEqual({ movements: 1, notices: 1 })
  })

  it('creates a movement and no notice when told not to notify, as a rebuild does', async () => {
    const before = await counts()
    expect(await record('b', '2', { notify: false })).toMatchObject({ outcome: 'created' })
    expect(await counts()).toEqual({
      movements: (before?.movements ?? 0) + 1,
      notices: before?.notices,
    })
  })

  it('does not notify later either: a rebuilt mail seen again is a duplicate', async () => {
    const before = await counts()
    expect(await record('b', '2')).toMatchObject({ outcome: 'duplicate' })
    expect(await counts()).toEqual(before)
  })
})
