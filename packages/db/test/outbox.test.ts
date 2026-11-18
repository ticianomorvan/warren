import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import type { Attempt, BankOperation, OpenNotice } from '@warren/core'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../src/client'
import { createLedger, seedAccounts } from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import { createOutbox, recentNotices } from '../src/outbox'
import * as schema from '../src/schema'

const pg = new PGlite()
const db = drizzle(pg, { schema }) as unknown as Db
const ledger = createLedger(db)
const log = createMailLog(db)
const outbox = createOutbox(db)

// Invented identifiers with valid shapes; nothing here is a real account.
const OWN_WALLET = '0170099220000012345670'
const sha = (c: string) => c.repeat(64)

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

async function record(c: string, templateId: string, operation: BankOperation) {
  await log.recordMail({
    sha256: sha(c),
    pathname: `raw/mail/${sha(c)}.eml`,
    bytes: 10,
    provider: 'resend',
    providerId: `em_${c}`,
    receivedAt: new Date('2026-11-14T17:10:00Z'),
  })
  return ledger.recordMailOperation({ mailSha256: sha(c), templateId, operation })
}

const seen: OpenNotice[] = []
const reply = (attempt: Attempt | null) => async (n: OpenNotice) => {
  seen.push(n)
  return attempt
}

beforeAll(async () => {
  await migrate(drizzle(pg), {
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  })
  await seedAccounts(db, [
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
  ])
})

describe('outbox', () => {
  it('owes one notice per movement, however many mails describe it', async () => {
    await record('a', 'bbva.transfer-sent', sent)
    await record('b', 'bbva.transfer-debited', debited)
    await record('a', 'bbva.transfer-sent', sent)
    const { rows } = await pg.query<{ n: number }>('select count(*)::int n from notice')
    expect(rows[0]?.n).toBe(1)
  })

  it('hands over the movement with account names and records the attempt', async () => {
    const made = await outbox.drain(
      reply({ mode: 'text', body: 'hola', outcome: 'sent', wamid: 'wamid.A' }),
    )
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
    await outbox.drain(reply(null))
    expect(seen.at(-1)?.history).toEqual([
      { mode: 'text', failed: false, errorCode: null, retryable: false },
    ])
  })

  it('reopens a notice when WhatsApp reports the message as failed', async () => {
    const status = { wamid: 'wamid.A', errorCode: 131047, occurredAt: new Date() }
    expect(await outbox.recordStatus({ ...status, status: 'failed' })).toBe(true)
    expect(await outbox.recordStatus({ ...status, status: 'failed' })).toBe(true)
    expect(await outbox.recordStatus({ ...status, wamid: 'wamid.other', status: 'read' })).toBe(
      false,
    )
    await outbox.drain(
      reply({
        mode: 'template',
        body: 'hola',
        outcome: 'failed',
        errorCode: null,
        retryable: true,
        detail: 'http-503',
      }),
    )
    expect(seen.at(-1)?.history).toEqual([
      { mode: 'text', failed: true, errorCode: 131047, retryable: false },
    ])
    await outbox.drain(reply(null))
    expect(seen.at(-1)?.history).toHaveLength(2)
    expect(seen.at(-1)?.history[1]).toEqual({
      mode: 'template',
      failed: true,
      errorCode: null,
      retryable: true,
    })
    expect((await recentNotices(db))[0]).toMatchObject({
      attempts: 2,
      lastMode: 'template',
      lastOutcome: 'failed',
      lastDetail: 'http-503',
    })
  })

  it('never rewrites what was sent', async () => {
    await expect(pg.query("update notice_attempt set body = 'x'")).rejects.toThrow(/append-only/)
    await expect(pg.query('delete from notice')).rejects.toThrow(/append-only/)
    await expect(pg.query('delete from notice_status')).rejects.toThrow(/append-only/)
  })
})
