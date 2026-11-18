import type { Attempt, BankOperation, OpenNotice } from '@warren/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, type Scope } from '../src/client'
import { createLedger, seedAccounts } from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import { createOutbox, recentNotices } from '../src/outbox'
import { sha, testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user: string
const as = <T>(fn: (scope: Scope) => Promise<T>) => asUser(t.app, user, fn)
const outbox = <T>(fn: (o: ReturnType<typeof createOutbox>) => Promise<T>) =>
  as((scope) => fn(createOutbox(scope)))

// Invented identifiers with valid shapes; nothing here is a real account.
const OWN_WALLET = '0170099220000012345670'

const sent: BankOperation = {
  kind: 'transfer_out',
  amount: '1500.00',
  currency: 'ARS',
  date: '2026-11-14',
  time: '14:09',
  ownAccount: null,
  counterparty: { name: 'Juana Ejemplo', account: OWN_WALLET, taxId: '20123456786' },
  reference: '1017000001',
  reason: 'VARIOS',
}
const debited: BankOperation = {
  ...sent,
  time: null,
  ownAccount: 'CA-ARS ***123/4',
  counterparty: { name: null, account: OWN_WALLET, taxId: '20123456786' },
  reference: null,
  reason: null,
}

const record = (c: string, templateId: string, operation: BankOperation) =>
  as(async (scope) => {
    await createMailLog(scope).recordMail({
      mailId: sha(c),
      pathname: `u/x/mail/${sha(c)}.eml.sealed`,
      bytes: 10,
      provider: 'resend',
      providerId: `em_${c}`,
      receivedAt: new Date('2026-11-14T17:10:00Z'),
    })
    return createLedger(scope).recordMailOperation({ mailId: sha(c), templateId, operation })
  })

const seen: OpenNotice[] = []
/** What flushNotices does, with a scripted answer: read what is owed, record `attempt` for each. */
const drain = (attempt: Attempt | null) =>
  outbox(async (o) => {
    const owed = await o.owed()
    seen.push(...owed)
    const made: Attempt[] = []
    for (const n of owed) {
      if (!attempt) continue
      await o.recordAttempt(n.noticeId, attempt)
      made.push(attempt)
    }
    return made
  })

beforeAll(async () => {
  t = await testDatabase()
  user = await t.newUser('outbox')
  await asUser(t.owner, user, (scope) =>
    seedAccounts(scope, [
      {
        id: 'asset:bank:ars',
        kind: 'asset',
        name: 'Bank ARS',
        currency: 'ARS',
        institution: 'Bank',
        identifiers: [{ scheme: 'bank-label', value: 'CA-ARS ***123/4' }],
      },
      {
        id: 'asset:wallet:ars',
        kind: 'asset',
        name: 'Wallet ARS',
        currency: 'ARS',
        institution: 'Wallet',
        identifiers: [{ scheme: 'cbu', value: OWN_WALLET }],
      },
    ]),
  )
})

describe('outbox', () => {
  it('owes one notice per movement, however many mails describe it', async () => {
    await record('a', 'bbva.transfer-sent', sent)
    await record('b', 'bbva.transfer-debited', debited)
    await record('a', 'bbva.transfer-sent', sent)
    const { rows } = await t.pg.query<{ n: number }>('select count(*)::int n from notice')
    expect(rows[0]?.n).toBe(1)
  })

  it('hands over the movement with account names and records the attempt', async () => {
    const made = await drain({ mode: 'text', body: 'hola', outcome: 'sent', wamid: 'wamid.A' })
    expect(made).toHaveLength(1)
    expect(seen.at(-1)).toMatchObject({
      history: [],
      movement: {
        type: 'own_transfer',
        direction: 'out',
        amount: '1500.00000000',
        accountName: 'Bank ARS',
        counterAccountName: 'Wallet ARS',
      },
    })
    await drain(null)
    expect(seen.at(-1)?.history).toEqual([
      { mode: 'text', failed: false, errorCode: null, retryable: false },
    ])
    // The text that was sent sits in the table as ciphertext.
    const { rows } = await t.pg.query<{ body: Uint8Array }>('select body from notice_attempt')
    expect(Buffer.from(rows[0]?.body ?? []).includes(Buffer.from('hola'))).toBe(false)
  })

  it('reopens a notice when WhatsApp reports the message as failed', async () => {
    const status = { wamid: 'wamid.A', errorCode: 131047, occurredAt: new Date() }
    expect(await outbox((o) => o.recordStatus({ ...status, status: 'failed' }))).toBe(true)
    expect(await outbox((o) => o.recordStatus({ ...status, status: 'failed' }))).toBe(true)
    expect(
      await outbox((o) => o.recordStatus({ ...status, wamid: 'wamid.other', status: 'read' })),
    ).toBe(false)
    await drain({
      mode: 'template',
      body: 'hola',
      outcome: 'failed',
      errorCode: null,
      retryable: true,
      detail: 'http-503',
    })
    expect(seen.at(-1)?.history).toEqual([
      { mode: 'text', failed: true, errorCode: 131047, retryable: false },
    ])
    await drain(null)
    expect(seen.at(-1)?.history).toHaveLength(2)
    expect(seen.at(-1)?.history[1]).toEqual({
      mode: 'template',
      failed: true,
      errorCode: null,
      retryable: true,
    })
    expect((await as((scope) => recentNotices(scope)))[0]).toMatchObject({
      attempts: 2,
      lastMode: 'template',
      lastOutcome: 'failed',
      lastDetail: 'http-503',
    })
  })

  it('never rewrites what was sent', async () => {
    await expect(t.pg.query("update notice_attempt set mode = 'text'")).rejects.toThrow(
      /append-only/,
    )
    await expect(t.pg.query('delete from notice')).rejects.toThrow(/append-only/)
    await expect(t.pg.query('delete from notice_status')).rejects.toThrow(/append-only/)
  })
})
