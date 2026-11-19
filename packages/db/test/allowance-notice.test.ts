import { createHash } from 'node:crypto'
import type { BankOperation, TransferOperation } from '@warren/core'
import { noticeText } from '@warren/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { addRule, allowanceMonth, setAllowance } from '../src/allowance'
import { asUser, type Scope } from '../src/client'
import { createLedger, seedAccounts } from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import { createOutbox } from '../src/outbox'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user = ''
let n = 0
const as = <T>(fn: (scope: Scope) => Promise<T>) => asUser(t.app, user, fn)

// Invented identifiers with valid check digits.
const OWN_CBU = '0000003100012345678901'
const LANDLORD = { account: '0720099122000007654329', taxId: '20111111112' }
const DAY = '2026-11-14'

const fresh = async () => {
  user = await t.newUser(`figure${n++}`)
  await asUser(t.owner, user, (scope) =>
    seedAccounts(scope, [
      {
        id: 'asset:bbva:ars',
        kind: 'asset',
        name: 'bbva',
        currency: 'ARS',
        institution: 'bbva',
        identifiers: [{ scheme: 'bank-label', value: 'CA-ARS ***1' }],
      },
      {
        id: 'asset:belo:ars',
        kind: 'asset',
        name: 'belo',
        currency: 'ARS',
        institution: 'belo',
        identifiers: [{ scheme: 'cbu', value: OWN_CBU }],
      },
    ]),
  )
}

const card = (
  amount: string,
  merchant = 'Tienda',
  currency = 'ARS',
  date = DAY,
): BankOperation => ({
  kind: 'card_purchase',
  cardLastFour: '1234',
  merchant,
  amount,
  currency: currency as 'ARS',
  date,
  cardType: 'credit',
})
const out = (amount: string, account = LANDLORD.account): BankOperation => ({
  kind: 'transfer_out',
  amount,
  currency: 'ARS',
  date: DAY,
  time: null,
  ownAccount: 'CA-ARS ***1',
  counterparty: { name: null, account, taxId: LANDLORD.taxId },
  reference: null,
  reason: null,
})

const record = async (operation: BankOperation, notify = true, templateId = 'test') => {
  const mailId = createHash('sha256').update(`${user}:${n++}`).digest('hex')
  return as(async (scope) => {
    await createMailLog(scope).recordMail({
      mailId,
      pathname: `u/${user}/mail/${mailId}.eml.sealed`,
      bytes: 10,
      provider: 'resend',
      providerId: `em_${mailId}`,
      receivedAt: new Date('2026-11-14T17:10:00Z'),
    })
    return createLedger(scope).recordMailOperation({ mailId, templateId, operation }, { notify })
  })
}

/** What each owed notice says about the allowance, in notice order. */
const figures = () =>
  as(async (scope) => (await createOutbox(scope).owed()).map((o) => o.movement.allowance ?? null))

beforeAll(async () => {
  t = await testDatabase()
})

describe('the allowance figure on a notice', () => {
  it('is what was left right after this movement, and reads back through owed()', async () => {
    await fresh()
    await as((s) => setAllowance(s, '1000.00', '2026-11'))
    await record(card('100.50'))
    await record(card('300.00'))
    expect(await figures()).toEqual([
      { month: '2026-11', left: '899.50000000' },
      { month: '2026-11', left: '599.50000000' },
    ])
    const owed = await as((s) => createOutbox(s).owed())
    const last = owed.at(-1)
    expect(
      noticeText(last?.movement as never)
        .split('\n')
        .at(-1),
    ).toBe('Te quedan $ 599,50 de tu asignación de noviembre')
  })

  it('goes negative when the person overspends', async () => {
    await fresh()
    await as((s) => setAllowance(s, '100.00', '2026-11'))
    await record(card('150.25'))
    expect(await figures()).toEqual([{ month: '2026-11', left: '-50.25000000' }])
  })

  it('is stored sealed, never as a readable amount', async () => {
    await fresh()
    await as((s) => setAllowance(s, '1000.00', '2026-11'))
    await record(card('100.50'))
    const { rows } = await t.pg.query<{ figure: Buffer }>(
      'select figure from notice where user_id = $1',
      [user],
    )
    expect(Buffer.from(rows[0]?.figure ?? []).toString('utf8')).not.toContain('899')
  })

  it('is absent for an own transfer, an excluded movement, a USD movement and a month with no allowance', async () => {
    await fresh()
    await as((s) => setAllowance(s, '1000.00', '2026-11'))
    await as((s) => addRule(s, { scheme: 'merchant', value: 'Excluido', class: 'excluded' }))
    await as((s) =>
      addRule(s, { scheme: 'counterparty-account', value: LANDLORD.account, class: 'fixed' }),
    )
    await record(out('11.00', OWN_CBU))
    await record(card('12.00', 'EXCLUIDO'))
    await record(out('13.00'))
    await record(card('14.00', 'Tienda', 'USD'))
    await record(card('15.00', 'Tienda', 'ARS', '2026-10-20'))
    await record({ ...(out('16.00') as TransferOperation), kind: 'transfer_in' })
    expect(await figures()).toEqual([null, null, null, null, null, null])
  })

  it('is not stored when the movement is recorded without notifying, and a joined mail changes nothing', async () => {
    await fresh()
    await as((s) => setAllowance(s, '1000.00', '2026-11'))
    await record(card('20.00'), false)
    expect(await figures()).toEqual([])
    const first = await record(out('30.00'))
    const again = await record(out('30.00'), true, 'test-other')
    expect(first.outcome).toBe('created')
    expect(again.outcome).toBe('linked')
    expect(await figures()).toEqual([{ month: '2026-11', left: '950.00000000' }])
  })

  it('does not change when a rule is added later, while the allowance page does', async () => {
    await fresh()
    await as((s) => setAllowance(s, '1000.00', '2026-11'))
    await record(card('100.00', 'Tienda'))
    await as((s) => addRule(s, { scheme: 'merchant', value: 'Tienda', class: 'excluded' }))
    expect(await figures()).toEqual([{ month: '2026-11', left: '900.00000000' }])
    expect((await as((s) => allowanceMonth(s, '2026-11'))).left).toBe('1000.00000000')
  })

  it('two concurrent recordings each store what was left after their own position in the lock order', async () => {
    await fresh()
    await as((s) => setAllowance(s, '1000.00', '2026-11'))
    const amounts = ['100.00', '250.00', '30.00', '7.00']
    await Promise.all(amounts.map((a) => record(card(a))))
    const rows = (
      await t.pg.query<{ amount: string }>(
        `select m.amount::text from notice n join movement m on m.id = n.movement_id
         where n.user_id = $1 order by n.id`,
        [user],
      )
    ).rows
    expect(rows).toHaveLength(4)
    let left = 1000
    const expected = rows.map((r) => {
      left -= Number(r.amount)
      return { month: '2026-11', left: `${left}.00000000` }
    })
    expect(await figures()).toEqual(expected)
    expect(new Set(expected.map((e) => e.left)).size).toBe(4)
  })
})
