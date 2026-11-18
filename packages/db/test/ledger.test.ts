import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import type { BankOperation } from '@warren/core'
import { recordPending } from '@warren/core'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../src/client'
import { createLedger, recentMovements, reprojectMovements, seedAccounts } from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import * as schema from '../src/schema'

const pg = new PGlite()
const db = drizzle(pg, { schema }) as unknown as Db
const ledger = createLedger(db)
const log = createMailLog(db)

// Invented identifiers with valid shapes; nothing here is a real account.
const OWN_WALLET = '0170099220000012345670'
const STRANGER = '0720099220000076543210'
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

async function mail(c: string) {
  await log.recordMail({
    sha256: sha(c),
    pathname: `raw/mail/${sha(c)}.eml`,
    bytes: 10,
    provider: 'resend',
    providerId: `em_${c}`,
    receivedAt: new Date('2026-11-14T17:10:00Z'),
  })
  return sha(c)
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
  ])
})

describe('ledger', () => {
  it('turns the two mails of one transfer into one movement', async () => {
    const a = await ledger.recordMailOperation({
      mailSha256: await mail('a'),
      templateId: 'bbva.transfer-sent',
      operation: sent,
    })
    const b = await ledger.recordMailOperation({
      mailSha256: await mail('b'),
      templateId: 'bbva.transfer-debited',
      operation: debited,
    })
    expect(a.outcome).toBe('created')
    expect(b).toEqual({ movementId: a.movementId, outcome: 'linked', type: 'unclassified' })

    const rows = await recentMovements(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      direction: 'out',
      amount: '1500.00000000',
      accountId: 'asset:bank:ars',
      counterpartyName: 'Juana Ejemplo',
      reference: '1017000001',
      time: '14:09:00',
      sources: 2,
    })
  })

  it('does nothing when the same mail is recorded again', async () => {
    const again = await ledger.recordMailOperation({
      mailSha256: sha('a'),
      templateId: 'bbva.transfer-sent',
      operation: sent,
    })
    expect(again.outcome).toBe('duplicate')
    const { rows } = await pg.query<{ n: number }>('select count(*)::int n from event')
    expect(rows[0]?.n).toBe(2)
  })

  it('keeps a second equal transfer as its own movement', async () => {
    const c = await ledger.recordMailOperation({
      mailSha256: await mail('c'),
      templateId: 'bbva.transfer-sent',
      operation: { ...sent, time: '16:00', reference: '1017000002' },
    })
    expect(c.outcome).toBe('created')
    expect(await recentMovements(db)).toHaveLength(2)
  })

  it('marks a transfer to an owner account as own, once that account is known', async () => {
    await seedAccounts(db, [
      {
        id: 'asset:wallet:ars',
        kind: 'asset',
        name: 'Wallet ARS',
        currency: 'ARS',
        institution: 'Wallet',
        identifiers: [{ scheme: 'cbu', value: OWN_WALLET }],
      },
    ])
    expect(await reprojectMovements(db)).toBe(2)
    expect((await recentMovements(db)).map((m) => [m.type, m.counterAccountId])).toEqual([
      ['own_transfer', 'asset:wallet:ars'],
      ['own_transfer', 'asset:wallet:ars'],
    ])
    const d = await ledger.recordMailOperation({
      mailSha256: await mail('d'),
      templateId: 'bbva.transfer-sent',
      operation: {
        ...sent,
        reference: '1017000003',
        counterparty: { name: 'Otra Persona', account: STRANGER, taxId: '27123456780' },
      },
    })
    expect(d.type).toBe('unclassified')
  })

  it('records parsed mails the ledger has not seen', async () => {
    const e = await mail('e')
    await log.recordVerdict(
      e,
      {
        verdict: 'verified',
        senderId: 'bbva-transfers',
        fromAddress: 'avisos@bbva.com.ar',
        signingDomain: 'bbva.com.ar',
        selector: 's1',
        keyRecord: 'v=DKIM1',
        signedHeaders: ['from', 'to', 'date', 'subject'],
        subject: 'Realizaste una transferencia',
        signedDate: new Date('2026-11-14T17:09:00Z'),
      },
      1,
    )
    const operation = { ...sent, amount: '99.00', reference: '1017000009' }
    await log.recordParse(e, 1, {
      status: 'parsed',
      templateId: 'bbva.transfer-sent',
      templateVersion: 1,
      operation,
    })
    expect(await recordPending(ledger)).toMatchObject([{ mailSha256: e, outcome: 'created' }])
    expect(await recordPending(ledger)).toEqual([])
  })
})

describe('event log', () => {
  it('chains every event to the one before it', async () => {
    const { rows } = await pg.query<{ ok: boolean; n: number }>(`
      select count(*)::int n, bool_and(chain_sha256 = sha256(coalesce(prev, ''::bytea) || payload_sha256)) ok
      from (select *, lag(chain_sha256) over (order by seq) prev from event) e`)
    expect(rows[0]).toMatchObject({ ok: true })
    expect(rows[0]?.n).toBeGreaterThan(3)
  })

  it.each([
    "update event set kind = 'link'",
    'delete from event',
    'truncate event',
    "update account set name = 'x'",
    'delete from account_identifier',
  ])('blocks: %s', async (statement) => {
    await expect(pg.exec(statement)).rejects.toThrow(/append-only/)
  })

  it("does not let the app decide which accounts are the owner's", async () => {
    await pg.exec('set role warren_app')
    try {
      await expect(
        pg.exec(
          "insert into account (id, kind, name, currency, institution) values ('x','asset','x','ARS','x')",
        ),
      ).rejects.toThrow(/permission denied/)
      await expect(
        pg.exec(
          "insert into account_identifier (scheme, value, account_id) values ('cbu','1','asset:bank:ars')",
        ),
      ).rejects.toThrow(/permission denied/)
      await expect(pg.exec('delete from movement')).rejects.toThrow(/permission denied/)
      const f = await ledger.recordMailOperation({
        mailSha256: sha('a'),
        templateId: 'bbva.transfer-sent',
        operation: sent,
      })
      expect(f.outcome).toBe('duplicate')
    } finally {
      await pg.exec('reset role')
    }
  })
})
