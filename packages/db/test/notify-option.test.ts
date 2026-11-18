import { type BankOperation, recordPending, TEMPLATE_SET_VERSION } from '@warren/core'
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

const record = (c: string, reference: string, options: { notify: boolean }) =>
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

/** Mail that was verified and parsed but never recorded in the ledger, as `mail:parse-pending` finds it. */
const parked = (c: string, reference: string, receivedAt: Date) =>
  asUser(t.app, user, async (scope: Scope) => {
    const log = createMailLog(scope)
    const id = sha(c)
    await log.recordMail({
      mailId: id,
      pathname: `u/${user}/mail/${id}.eml.sealed`,
      bytes: 10,
      provider: 'resend',
      providerId: `em_${c}`,
      receivedAt,
    })
    await log.recordVerdict(
      id,
      {
        verdict: 'verified',
        senderId: 'bbva-transfers',
        fromAddress: 'avisos@bbva.com.ar',
        signingDomain: 'bbva.com.ar',
        selector: 's1',
        keyRecord: 'v=DKIM1',
        signedHeaders: ['from', 'to', 'date', 'subject'],
        subject: 'Realizaste una transferencia',
        signedDate: receivedAt,
      },
      1,
    )
    await log.recordParse(id, TEMPLATE_SET_VERSION, {
      status: 'parsed',
      templateId: 'bbva.transfer-sent',
      templateVersion: 1,
      operation: operation(reference),
    })
  })

const recordParked = (now: Date) =>
  asUser(t.app, user, (scope: Scope) => recordPending(createLedger(scope), () => now))

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
  it('creates a movement and a notice when told to notify, as live intake does', async () => {
    expect(await record('a', '1', { notify: true })).toMatchObject({ outcome: 'created' })
    expect(await counts()).toEqual({ movements: 1, notices: 1 })
  })

  it('creates a movement and no notice when told not to notify, as a rebuild does', async () => {
    const before = await counts()
    expect(await record('b', '2', { notify: false })).toMatchObject({ outcome: 'created' })
    expect(await counts()).toEqual({ movements: 2, notices: 1 })
    expect(before).toEqual({ movements: 1, notices: 1 })
  })

  it('does not notify later either: a rebuilt mail seen again, even when told to, is a duplicate', async () => {
    const before = await counts()
    expect(await record('b', '2', { notify: true })).toMatchObject({ outcome: 'duplicate' })
    expect(await counts()).toEqual(before)
  })

  it('parse-pending notifies only for mail inside the notice window', async () => {
    const received = new Date('2026-11-14T17:10:00Z')
    await parked('c', '3', received)
    await parked('d', '4', received)
    const before = await counts()
    // A reparse long after the mail arrived: old mail is not news.
    const late = new Date(received.getTime() + 48 * 3_600_000)
    expect(await recordParked(late)).toHaveLength(2)
    expect(await counts()).toEqual({
      movements: (before?.movements ?? 0) + 2,
      notices: before?.notices,
    })
    // Mail still inside the window is news.
    await parked('e', '5', received)
    expect(await recordParked(new Date(received.getTime() + 3_600_000))).toHaveLength(1)
    expect(await counts()).toEqual({
      movements: (before?.movements ?? 0) + 3,
      notices: (before?.notices ?? 0) + 1,
    })
  })
})
