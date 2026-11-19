import { createHash } from 'node:crypto'
import type { BankOperation } from '@warren/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, type Scope } from '../src/client'
import {
  createLedger,
  recentMovements,
  reprojectMovements,
  seedAccounts,
  summarizeMovements,
} from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import { createOutbox, recentNotices } from '../src/outbox'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user = ''
let n = 0

// Invented identifiers with valid shapes; nothing here is a real account.
const BELO_ARS_CVU = '0000003100012345678901'
const BELO_USD_CVU = '0000003100098765432109'

const account = (id: string, currency: string, institution: string, identifiers: AccountIds) => ({
  id,
  kind: 'asset' as const,
  name: id,
  currency,
  institution,
  identifiers,
})
type AccountIds = { scheme: 'cbu' | 'bank-label'; value: string }[]

beforeAll(async () => {
  t = await testDatabase()
})

/** A user with two BBVA-like accounts and Belo's two, as the operator seeds them. */
async function fresh() {
  user = await t.newUser(`legs${n++}`)
  await asUser(t.owner, user, (scope) =>
    seedAccounts(scope, [
      account('asset:bbva:ars', 'ARS', 'bbva', [{ scheme: 'bank-label', value: 'CA-ARS ***1' }]),
      account('asset:bbva:usd', 'USD', 'bbva', [{ scheme: 'bank-label', value: 'CA-USD ***2' }]),
      account('asset:belo:ars', 'ARS', 'belo', [
        { scheme: 'bank-label', value: 'belo ARS' },
        { scheme: 'cbu', value: BELO_ARS_CVU },
      ]),
      account('asset:belo:usdt', 'USDT', 'belo', [
        { scheme: 'bank-label', value: 'belo USDT' },
        { scheme: 'cbu', value: BELO_USD_CVU },
      ]),
    ]),
  )
}

const as = <T>(fn: (scope: Scope) => Promise<T>) => asUser(t.app, user, fn)

const record = async (templateId: string, operation: BankOperation) => {
  const mailId = createHash('sha256').update(`${user}:${n++}`).digest('hex')
  await as((scope) =>
    createMailLog(scope).recordMail({
      mailId,
      pathname: `u/${user}/mail/${mailId}.eml.sealed`,
      bytes: 10,
      provider: 'resend',
      providerId: `em_${mailId}`,
      receivedAt: new Date('2026-11-14T17:10:00Z'),
    }),
  )
  return as((scope) =>
    createLedger(scope).recordMailOperation({ mailId, templateId, operation }, { notify: true }),
  )
}

const movements = () => as((scope) => recentMovements(scope))
const shape = async () =>
  (await movements())
    .map((m) => ({
      direction: m.direction,
      currency: m.currency,
      amount: Number(m.amount),
      accountId: m.accountId,
      counterAccountId: m.counterAccountId,
      type: m.type,
      sources: m.sources,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

const common = { date: '2026-11-14', reference: null, reason: null }
const NONE = { name: null, account: null, taxId: null }
const bank = (
  kind: 'transfer_in' | 'transfer_out',
  currency: 'ARS' | 'USD',
  amount: string,
  counterAccount: string,
  time: string | null = null,
): BankOperation => ({
  ...common,
  kind,
  currency,
  amount,
  time,
  ownAccount: currency === 'ARS' ? 'CA-ARS ***1' : 'CA-USD ***2',
  counterparty: { name: null, account: counterAccount, taxId: '20123456786' },
})
const belo = (
  kind: 'transfer_in' | 'transfer_out',
  currency: 'ARS' | 'USD' | 'USDT',
  amount: string,
  time: string | null,
): BankOperation => ({
  ...common,
  kind,
  currency,
  amount,
  time,
  ownAccount: currency === 'ARS' ? 'belo ARS' : 'belo USDT',
  counterparty: NONE,
})

/** What the Belo withdrawal templates record; whether it says "own account" is the template's. */
const beloOwn = (currency: 'ARS' | 'USD', amount: string): BankOperation =>
  belo('transfer_out', currency, amount, '12:30')
/** BBVA's DEBIN credit: it names no counterparty. */
const debin = (amount: string, ownAccount = 'CA-USD ***2'): BankOperation => ({
  ...common,
  kind: 'transfer_in',
  currency: 'USD',
  amount,
  time: null,
  ownAccount,
  counterparty: NONE,
})

const DEBITED = 'bbva.transfer-debited'
const DEBIN = 'bbva.debin-credited'
const CREDITED = 'bbva.transfer-credited'
const ARS_DEPOSIT = 'belo.ars-deposit'
const USD_WITHDRAWAL = 'belo.usd-withdrawal'
const USD_DEPOSIT = 'belo.usd-deposit'

describe('one transfer, two banks, the same currency', () => {
  const joined = {
    direction: 'out',
    currency: 'ARS',
    amount: 1500,
    accountId: 'asset:bbva:ars',
    counterAccountId: 'asset:belo:ars',
    type: 'own_transfer',
    sources: 2,
  }

  it('joins BBVA to Belo when Belo came first, though the clocks differ', async () => {
    await fresh()
    const first = await record(ARS_DEPOSIT, belo('transfer_in', 'ARS', '1500.00', '14:09'))
    expect(first.type).toBe('unclassified')
    const second = await record(DEBITED, bank('transfer_out', 'ARS', '1500.00', BELO_ARS_CVU))
    expect(second).toEqual({
      movementId: first.movementId,
      outcome: 'linked',
      type: 'own_transfer',
    })
    expect(await shape()).toEqual([joined])
  })

  it('joins Belo to BBVA when BBVA came first', async () => {
    await fresh()
    const first = await record(
      DEBITED,
      bank('transfer_out', 'ARS', '1500.00', BELO_ARS_CVU, '14:11'),
    )
    expect(first.type).toBe('own_transfer')
    const second = await record(ARS_DEPOSIT, belo('transfer_in', 'ARS', '1500.00', '14:09'))
    expect(second).toMatchObject({ movementId: first.movementId, outcome: 'linked' })
    expect(await shape()).toEqual([joined])
  })

  it('joins the mirror: a USD withdrawal from Belo and the credit it makes at BBVA, either way', async () => {
    const expected = {
      direction: 'in',
      currency: 'USD',
      amount: 99.99,
      accountId: 'asset:bbva:usd',
      counterAccountId: 'asset:belo:usdt',
      type: 'own_transfer',
      sources: 2,
    }
    await fresh()
    await record(USD_WITHDRAWAL, belo('transfer_out', 'USD', '99.99', '12:30'))
    await record(CREDITED, bank('transfer_in', 'USD', '99.99', BELO_USD_CVU))
    expect(await shape()).toEqual([expected])

    await fresh()
    await record(CREDITED, bank('transfer_in', 'USD', '99.99', BELO_USD_CVU))
    await record(USD_WITHDRAWAL, belo('transfer_out', 'USD', '99.99', '12:31'))
    expect(await shape()).toEqual([expected])
  })

  it('joins none when two movements could be the one', async () => {
    await fresh()
    const a = await record(DEBITED, bank('transfer_out', 'ARS', '1500.00', BELO_ARS_CVU))
    // Same template, same figures: a second operation, as BBVA's own rule has it.
    const b = await record(DEBITED, bank('transfer_out', 'ARS', '1500.00', BELO_ARS_CVU))
    expect(b.movementId).not.toBe(a.movementId)
    const c = await record(ARS_DEPOSIT, belo('transfer_in', 'ARS', '1500.00', '14:09'))
    expect(c.outcome).toBe('created')
    expect(await movements()).toHaveLength(3)
  })

  it('does not join an amount, a date or an account that differs', async () => {
    await fresh()
    await record(DEBITED, bank('transfer_out', 'ARS', '1500.00', BELO_ARS_CVU))
    await record(ARS_DEPOSIT, belo('transfer_in', 'ARS', '1500.01', '14:09'))
    await record(ARS_DEPOSIT, {
      ...belo('transfer_in', 'ARS', '1500.00', '14:09'),
      date: '2026-11-15',
    })
    expect(await movements()).toHaveLength(3)
  })

  it('counts a joined transfer once, as an own transfer, and not as spending or income', async () => {
    await fresh()
    await record(DEBITED, bank('transfer_out', 'ARS', '1500.00', BELO_ARS_CVU))
    await record(ARS_DEPOSIT, belo('transfer_in', 'ARS', '1500.00', '14:09'))
    const summary = await as((scope) =>
      summarizeMovements(scope, { from: '2026-11-01', to: '2026-11-30' }),
    )
    expect(summary.currencies).toEqual([])
    expect(summary.own_transfers).toEqual([
      { currency: 'ARS', count: 1, in: '0.00000000', out: '1500.00000000' },
    ])
  })

  it('projects the same rows again', async () => {
    await fresh()
    await record(ARS_DEPOSIT, belo('transfer_in', 'ARS', '1500.00', '14:09'))
    await record(DEBITED, bank('transfer_out', 'ARS', '1500.00', BELO_ARS_CVU))
    await record(USD_DEPOSIT, belo('transfer_in', 'USDT', '100.00', null))
    await record(DEBITED, bank('transfer_out', 'USD', '100.00', BELO_USD_CVU))
    const before = await shape()
    await asUser(t.owner, user, (scope) => reprojectMovements(scope))
    expect(await shape()).toEqual(before)
    await asUser(t.owner, user, (scope) => reprojectMovements(scope))
    expect(await shape()).toEqual(before)
  })
})

describe('a dollar deposit: USD out of BBVA, USDT into Belo', () => {
  const pair = [
    {
      direction: 'in',
      currency: 'USDT',
      amount: 100,
      accountId: 'asset:belo:usdt',
      counterAccountId: 'asset:bbva:usd',
      type: 'own_transfer',
      sources: 1,
    },
    {
      direction: 'out',
      currency: 'USD',
      amount: 100,
      accountId: 'asset:bbva:usd',
      counterAccountId: 'asset:belo:usdt',
      type: 'own_transfer',
      sources: 1,
    },
  ]

  it('keeps two movements and classes the Belo leg own, whichever mail came first', async () => {
    await fresh()
    await record(USD_DEPOSIT, belo('transfer_in', 'USDT', '100.00', null))
    expect((await shape()).map((m) => m.type)).toEqual(['unclassified'])
    await record(DEBITED, bank('transfer_out', 'USD', '100.00', BELO_USD_CVU))
    expect(await shape()).toEqual(pair)

    await fresh()
    await record(DEBITED, bank('transfer_out', 'USD', '100.00', BELO_USD_CVU))
    await record(USD_DEPOSIT, belo('transfer_in', 'USDT', '100.00', null))
    expect(await shape()).toEqual(pair)
  })

  it('leaves it unclassified when two BBVA transfers could be its other leg', async () => {
    await fresh()
    await record(DEBITED, bank('transfer_out', 'USD', '100.00', BELO_USD_CVU))
    await record(DEBITED, bank('transfer_out', 'USD', '100.00', BELO_USD_CVU))
    await record(USD_DEPOSIT, belo('transfer_in', 'USDT', '100.00', null))
    const rows = await shape()
    expect(
      rows.filter((m) => m.currency === 'USDT').map((m) => [m.type, m.counterAccountId]),
    ).toEqual([['unclassified', null]])
  })

  it('leaves it unclassified when the digits or the date differ', async () => {
    await fresh()
    await record(DEBITED, bank('transfer_out', 'USD', '100.00', BELO_USD_CVU))
    await record(USD_DEPOSIT, belo('transfer_in', 'USDT', '99.99', null))
    await record(USD_DEPOSIT, {
      ...belo('transfer_in', 'USDT', '100.00', null),
      date: '2026-11-13',
    })
    expect((await shape()).filter((m) => m.currency === 'USDT').map((m) => m.type)).toEqual([
      'unclassified',
      'unclassified',
    ])
  })

  it('pairs none when two deposits of the same digits meet one transfer out', async () => {
    await fresh()
    await record(DEBITED, bank('transfer_out', 'USD', '100.00', BELO_USD_CVU))
    await record(USD_DEPOSIT, belo('transfer_in', 'USDT', '100.00', null))
    expect((await shape()).map((m) => m.type)).toEqual(['own_transfer', 'own_transfer'])
    await record(USD_DEPOSIT, { ...belo('transfer_in', 'USDT', '100.00', null) })
    const rows = await shape()
    expect(rows.filter((m) => m.currency === 'USDT').map((m) => m.type)).toEqual([
      'unclassified',
      'unclassified',
    ])
    await asUser(t.owner, user, (scope) => reprojectMovements(scope))
    expect(await shape()).toEqual(rows)
  })
})

describe('notices after a join', () => {
  it('shows a pending notice as the joined transfer, and sends no second one', async () => {
    await fresh()
    await record(ARS_DEPOSIT, belo('transfer_in', 'ARS', '1500.00', '14:09'))
    const owedBefore = await as((scope) => createOutbox(scope).owed())
    expect(owedBefore.map((o) => o.movement.type)).toEqual(['unclassified'])
    await record(DEBITED, bank('transfer_out', 'ARS', '1500.00', BELO_ARS_CVU))
    const owed = await as((scope) => createOutbox(scope).owed())
    expect(owed).toHaveLength(1)
    expect(owed[0]?.noticeId).toBe(owedBefore[0]?.noticeId)
    expect(owed[0]?.movement).toMatchObject({
      type: 'own_transfer',
      direction: 'out',
      accountName: 'asset:bbva:ars',
      counterAccountName: 'asset:belo:ars',
    })
    expect(await as((scope) => recentNotices(scope))).toHaveLength(1)
  })
})

describe('a leg that says "own account" and names no other', () => {
  const joined = {
    direction: 'out',
    currency: 'USD',
    amount: 5.25,
    accountId: 'asset:belo:usdt',
    counterAccountId: 'asset:bbva:usd',
    type: 'own_transfer',
    sources: 2,
  }

  it('joins a Belo USD withdrawal and the DEBIN credit, whichever came first', async () => {
    await fresh()
    const first = await record(USD_WITHDRAWAL, beloOwn('USD', '5.25'))
    expect(first.type).toBe('unclassified')
    const second = await record(DEBIN, debin('5.25'))
    expect(second).toEqual({
      movementId: first.movementId,
      outcome: 'linked',
      type: 'own_transfer',
    })
    expect(await shape()).toEqual([joined])

    await fresh()
    await record(DEBIN, debin('5.25'))
    await record(USD_WITHDRAWAL, beloOwn('USD', '5.25'))
    expect(await shape()).toEqual([joined])
    // Projecting again from the sources gives the same row.
    await asUser(t.owner, user, (scope) => reprojectMovements(scope))
    expect(await shape()).toEqual([joined])
  })

  it('counts the joined pair once, as an own transfer', async () => {
    await fresh()
    await record(DEBIN, debin('5.25'))
    await record(USD_WITHDRAWAL, beloOwn('USD', '5.25'))
    const summary = await as((scope) =>
      summarizeMovements(scope, { from: '2026-11-01', to: '2026-11-30' }),
    )
    expect(summary.currencies).toEqual([])
    expect(summary.own_transfers).toMatchObject([{ currency: 'USD', count: 1 }])
  })

  it('joins none when two DEBIN credits could be its other leg', async () => {
    await fresh()
    await record(DEBIN, debin('5.25'))
    await record(DEBIN, debin('5.25'))
    const w = await record(USD_WITHDRAWAL, beloOwn('USD', '5.25'))
    expect(w.outcome).toBe('created')
    expect((await shape()).map((m) => m.type)).toEqual([
      'unclassified',
      'unclassified',
      'unclassified',
    ])
  })

  it('joins none when two flagged withdrawals could take the credit', async () => {
    await fresh()
    await record(USD_WITHDRAWAL, beloOwn('USD', '5.25'))
    await record(USD_WITHDRAWAL, beloOwn('USD', '5.25'))
    expect((await record(DEBIN, debin('5.25'))).outcome).toBe('created')
    expect(await movements()).toHaveLength(3)
  })

  it('leaves a DEBIN credit alone when no leg says "own account"', async () => {
    await fresh()
    await record(DEBIN, debin('5.25'))
    await record('test.plain-withdrawal', belo('transfer_out', 'USD', '5.25', '12:30'))
    const rows = await shape()
    expect(rows).toHaveLength(2)
    expect(rows.map((m) => m.type)).toEqual(['unclassified', 'unclassified'])
    await fresh()
    await record(DEBIN, debin('5.25'))
    expect(await shape()).toMatchObject([{ direction: 'in', type: 'unclassified', sources: 1 }])
  })

  it('does not join legs on the same account, or when the credit account is unknown', async () => {
    await fresh()
    await record(DEBIN, debin('5.25', 'CA-USD ***999/9'))
    await record(USD_WITHDRAWAL, beloOwn('USD', '5.25'))
    expect(await movements()).toHaveLength(2)
  })
})
