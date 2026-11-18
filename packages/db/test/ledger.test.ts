import type { BankOperation } from '@warren/core'
import { recordPending } from '@warren/core'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, inUserContext, type Scope } from '../src/client'
import {
  createLedger,
  recentMovements,
  reprojectMovements,
  seedAccounts,
  verifyChain,
} from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import { sha, testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user: string
const as = <T>(fn: (scope: Scope) => Promise<T>) => asUser(t.app, user, fn)

// Invented identifiers with valid shapes; nothing here is a real account.
const OWN_WALLET = '0170099220000012345670'
const STRANGER = '0720099220000076543210'

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

/** Records mail `c` for the user and returns its id. */
const mail = (c: string) =>
  as(async (scope) => {
    const id = sha(c)
    await createMailLog(scope).recordMail({
      mailId: id,
      pathname: `u/${user}/mail/${id}.eml.sealed`,
      bytes: 10,
      provider: 'resend',
      providerId: `em_${c}`,
      receivedAt: new Date('2026-11-14T17:10:00Z'),
    })
    return id
  })
const record = (mailId: string, templateId: string, operation: BankOperation) =>
  as((scope) => createLedger(scope).recordMailOperation({ mailId, templateId, operation }))

beforeAll(async () => {
  t = await testDatabase()
  user = await t.newUser('owner')
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
    ]),
  )
})

describe('ledger', () => {
  it('turns the two mails of one transfer into one movement', async () => {
    const a = await record(await mail('a'), 'bbva.transfer-sent', sent)
    const b = await record(await mail('b'), 'bbva.transfer-debited', debited)
    expect(a.outcome).toBe('created')
    expect(b).toEqual({ movementId: a.movementId, outcome: 'linked', type: 'unclassified' })

    const rows = await as((scope) => recentMovements(scope))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: user,
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
    const again = await record(sha('a'), 'bbva.transfer-sent', sent)
    expect(again.outcome).toBe('duplicate')
    const { rows } = await t.pg.query<{ n: number }>('select count(*)::int n from event')
    expect(rows[0]?.n).toBe(2)
  })

  it('keeps a second equal transfer as its own movement', async () => {
    const c = await record(await mail('c'), 'bbva.transfer-sent', {
      ...sent,
      time: '16:00',
      reference: '1017000002',
    })
    expect(c.outcome).toBe('created')
    expect(await as((scope) => recentMovements(scope))).toHaveLength(2)
  })

  it('marks a transfer to an own account as own, once that account is known', async () => {
    await asUser(t.owner, user, (scope) =>
      seedAccounts(scope, [
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
    expect(await asUser(t.owner, user, (scope) => reprojectMovements(scope))).toBe(2)
    expect(
      (await as((scope) => recentMovements(scope))).map((m) => [m.type, m.counterAccountId]),
    ).toEqual([
      ['own_transfer', 'asset:wallet:ars'],
      ['own_transfer', 'asset:wallet:ars'],
    ])
    const d = await record(await mail('d'), 'bbva.transfer-sent', {
      ...sent,
      reference: '1017000003',
      counterparty: { name: 'Otra Persona', account: STRANGER, taxId: '27123456780' },
    })
    expect(d.type).toBe('unclassified')
  })

  it('records parsed mails the ledger has not seen', async () => {
    const e = await mail('e')
    const operation = { ...sent, amount: '99.00', reference: '1017000009' }
    await as(async (scope) => {
      const log = createMailLog(scope)
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
      await log.recordParse(e, 1, {
        status: 'parsed',
        templateId: 'bbva.transfer-sent',
        templateVersion: 1,
        operation,
      })
    })
    expect(await as((scope) => recordPending(createLedger(scope)))).toMatchObject([
      { mailId: e, outcome: 'created' },
    ])
    expect(await as((scope) => recordPending(createLedger(scope)))).toEqual([])
  })
})

describe('event log', () => {
  it('chains every event to the one before it, over the sealed payload', async () => {
    expect(await verifyChain(t.app, user)).toMatchObject({ ok: true, brokenAt: null })
    expect((await verifyChain(t.app, user)).events).toBeGreaterThan(3)
  })

  it('notices a rewritten payload', async () => {
    const { rows } = await t.pg.query<{ seq: string; payload: Uint8Array }>(
      'select seq::text, payload from event order by seq limit 1',
    )
    const first = rows[0]
    if (!first) throw new Error('no events')
    const set = (payload: Uint8Array) =>
      t.pg.query('update event set payload = $1 where seq = $2', [payload, first.seq])
    await t.pg.exec('alter table event disable trigger event_no_mutation')
    try {
      await set(new Uint8Array([1, 2, 3]))
      expect(await verifyChain(t.app, user)).toMatchObject({
        ok: false,
        brokenAt: Number(first.seq),
      })
    } finally {
      await set(first.payload)
      await t.pg.exec('alter table event enable trigger event_no_mutation')
    }
    expect(await verifyChain(t.app, user)).toMatchObject({ ok: true })
  })

  it.each([
    "update event set kind = 'link'",
    'delete from event',
    'truncate event',
    "update account set name = 'x'",
    'delete from account_identifier',
  ])('blocks: %s', async (statement) => {
    await expect(t.pg.exec(statement)).rejects.toThrow(/append-only/)
  })

  it("does not let the app decide which accounts are a user's", async () => {
    const attempt = (statement: string) =>
      inUserContext(t.app, user, (tx) => tx.execute(sql.raw(statement)))
    await expect(
      attempt(
        "insert into account (id, kind, name, currency, institution) values ('x','asset','x','ARS','x')",
      ),
    ).rejects.toThrow(/permission denied|Failed query/)
    await expect(attempt('delete from movement')).rejects.toThrow(/permission denied|Failed query/)
    expect((await record(sha('a'), 'bbva.transfer-sent', sent)).outcome).toBe('duplicate')
  })
})
