import { createHash } from 'node:crypto'
import type { BankOperation } from '@warren/core'
import { foldMerchant } from '@warren/core'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  AllowanceInputError,
  activeRules,
  addRule,
  allowanceMonth,
  revokeRule,
  setAllowance,
} from '../src/allowance'
import { asUser, type Scope } from '../src/client'
import { createLedger, seedAccounts } from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user = ''
let n = 0
const as = <T>(fn: (scope: Scope) => Promise<T>) => asUser(t.app, user, fn)

// Invented identifiers with valid check digits; nothing here is a real account or person.
const OWN_CBU = '0000003100012345678901'
const LANDLORD = { account: '0720099122000007654329', taxId: '20111111112' }
const CARD_ISSUER = { account: '0170099222000001234561', taxId: '30700000016' }

const fresh = async () => {
  user = await t.newUser(`allowance${n++}`)
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

type Who = { account: string; taxId: string; name?: string }
const card = (date: string, amount: string, merchant: string, currency = 'ARS'): BankOperation => ({
  kind: 'card_purchase',
  cardLastFour: '1234',
  merchant,
  amount,
  currency: currency as 'ARS',
  date,
  cardType: 'credit',
})
const transfer = (
  kind: 'transfer_out' | 'transfer_in',
  date: string,
  amount: string,
  who: Who,
  currency = 'ARS',
): BankOperation => ({
  kind,
  amount,
  currency: currency as 'ARS',
  date,
  time: null,
  ownAccount: 'CA-ARS ***1',
  counterparty: { name: who.name ?? null, account: who.account, taxId: who.taxId },
  reference: null,
  reason: null,
})
const out = (date: string, amount: string, who: Who = LANDLORD) =>
  transfer('transfer_out', date, amount, who)

const record = async (operation: BankOperation) => {
  const mailId = createHash('sha256').update(`${user}:${n++}`).digest('hex')
  await as(async (scope) => {
    await createMailLog(scope).recordMail({
      mailId,
      pathname: `u/${user}/mail/${mailId}.eml.sealed`,
      bytes: 10,
      provider: 'resend',
      providerId: `em_${mailId}`,
      receivedAt: new Date('2026-11-14T17:10:00Z'),
    })
    const r = await createLedger(scope).recordMailOperation(
      { mailId, templateId: 'test', operation },
      { notify: false },
    )
    if (r.outcome !== 'created') throw new Error(`fixture movement was ${r.outcome}`)
  })
}

type Step =
  | { movement: BankOperation }
  | { allowance: [amount: string, month: string] }
  | { rule: Parameters<typeof addRule>[1] }
  | { revokeLastRule: true }
type Expected = Omit<Awaited<ReturnType<typeof allowanceMonth>>, 'month' | 'currency'>
type Golden = { name: string; steps: Step[]; months: Record<string, Expected> }

const none = { amount: null, left: null }
const zero = '0.00000000'

/** Movements and settings, in the order they are recorded, and what each month then says. */
const GOLDEN: Golden[] = [
  {
    name: '1. the first and last Argentine day of the month count, the day after does not',
    steps: [
      { allowance: ['100000.00', '2026-11'] },
      { movement: out('2026-10-31', '1000.00') },
      { movement: out('2026-11-01', '2000.50') },
      { movement: out('2026-11-30', '3000.00') },
      { movement: out('2026-12-01', '4000.00') },
    ],
    months: {
      '2026-11': {
        amount: '100000.00000000',
        spent: '5000.50000000',
        left: '94999.50000000',
        fixed: zero,
        excluded: zero,
      },
      '2026-10': { ...none, spent: '1000.00000000', fixed: zero, excluded: zero },
    },
  },
  {
    name: '2. own transfers and inbound transfers never count',
    steps: [
      { allowance: ['100000.00', '2026-11'] },
      { movement: out('2026-11-05', '7000.00', { account: OWN_CBU, taxId: LANDLORD.taxId }) },
      { movement: transfer('transfer_in', '2026-11-06', '8000.00', LANDLORD) },
      { movement: out('2026-11-07', '500.00') },
    ],
    months: {
      '2026-11': {
        amount: '100000.00000000',
        spent: '500.00000000',
        left: '99500.00000000',
        fixed: zero,
        excluded: zero,
      },
    },
  },
  {
    name: '3. a merchant rule, folded, removes past and future purchases',
    steps: [
      { allowance: ['100000.00', '2026-11'] },
      { movement: card('2026-11-02', '1111.00', 'CAFE NANDU') },
      { movement: card('2026-11-03', '2222.00', 'Café  Ñandú ') },
      { movement: card('2026-11-04', '333.00', 'Otro Comercio') },
      { rule: { scheme: 'merchant', value: 'cafe ñandu', class: 'excluded' } },
      { movement: card('2026-11-20', '4444.00', 'CAFÉ ÑANDÚ') },
    ],
    months: {
      '2026-11': {
        amount: '100000.00000000',
        spent: '333.00000000',
        left: '99667.00000000',
        fixed: zero,
        excluded: '7777.00000000',
      },
    },
  },
  {
    name: '4. an account rule moves rent into fixed',
    steps: [
      { allowance: ['100000.00', '2026-11'] },
      { movement: out('2026-11-03', '300000.00') },
      { movement: out('2026-11-04', '900.00', CARD_ISSUER) },
      { rule: { scheme: 'counterparty-account', value: LANDLORD.account, class: 'fixed' } },
    ],
    months: {
      '2026-11': {
        amount: '100000.00000000',
        spent: '900.00000000',
        left: '99100.00000000',
        fixed: '300000.00000000',
        excluded: zero,
      },
    },
  },
  {
    name: '5. a credit card payment excluded by rule, the purchases counted once',
    steps: [
      { allowance: ['100000.00', '2026-11'] },
      { movement: card('2026-11-02', '1000.00', 'Super Uno') },
      { movement: card('2026-11-09', '2000.00', 'Super Dos') },
      { movement: out('2026-11-28', '3000.00', CARD_ISSUER) },
      { rule: { scheme: 'counterparty-tax-id', value: CARD_ISSUER.taxId, class: 'excluded' } },
    ],
    months: {
      '2026-11': {
        amount: '100000.00000000',
        spent: '3000.00000000',
        left: '97000.00000000',
        fixed: zero,
        excluded: '3000.00000000',
      },
    },
  },
  {
    name: '6. an overspend gives a negative left',
    steps: [
      { allowance: ['1000.00', '2026-11'] },
      { movement: card('2026-11-02', '1500.25', 'Tienda') },
    ],
    months: {
      '2026-11': {
        amount: '1000.00000000',
        spent: '1500.25000000',
        left: '-500.25000000',
        fixed: zero,
        excluded: zero,
      },
    },
  },
  {
    name: '7. a new allowance applies to the whole month it is valid from, not to past months',
    steps: [
      { allowance: ['100000.00', '2026-10'] },
      { movement: card('2026-10-10', '1000.00', 'Tienda') },
      { movement: card('2026-11-10', '2000.00', 'Tienda') },
      { allowance: ['150000.00', '2026-11'] },
    ],
    months: {
      '2026-10': {
        amount: '100000.00000000',
        spent: '1000.00000000',
        left: '99000.00000000',
        fixed: zero,
        excluded: zero,
      },
      '2026-11': {
        amount: '150000.00000000',
        spent: '2000.00000000',
        left: '148000.00000000',
        fixed: zero,
        excluded: zero,
      },
      '2026-09': { ...none, spent: zero, fixed: zero, excluded: zero },
    },
  },
  {
    name: '7b. an allowance set during November, given as 2026-11, covers all of November and nothing earlier',
    steps: [
      { movement: card('2026-10-20', '20.00', 'Tienda') },
      { movement: card('2026-11-02', '10.00', 'Tienda') },
      { allowance: ['150000.00', '2026-11'] },
    ],
    months: {
      '2026-11': {
        amount: '150000.00000000',
        spent: '10.00000000',
        left: '149990.00000000',
        fixed: zero,
        excluded: zero,
      },
      '2026-10': { ...none, spent: '20.00000000', fixed: zero, excluded: zero },
    },
  },
  {
    name: '8. a revoked rule stops applying',
    steps: [
      { allowance: ['100000.00', '2026-11'] },
      { movement: out('2026-11-03', '300000.00') },
      { rule: { scheme: 'counterparty-account', value: LANDLORD.account, class: 'fixed' } },
      { revokeLastRule: true },
    ],
    months: {
      '2026-11': {
        amount: '100000.00000000',
        spent: '300000.00000000',
        left: '-200000.00000000',
        fixed: zero,
        excluded: zero,
      },
    },
  },
  {
    name: '9. USD and USDT movements are ignored',
    steps: [
      { allowance: ['100000.00', '2026-11'] },
      { movement: card('2026-11-02', '50.00', 'Shop', 'USD') },
      { movement: transfer('transfer_out', '2026-11-03', '60.00', LANDLORD, 'USD') },
      { movement: transfer('transfer_out', '2026-11-04', '70.00', LANDLORD, 'USDT') },
      { movement: card('2026-11-05', '10.00', 'Shop') },
    ],
    months: {
      '2026-11': {
        amount: '100000.00000000',
        spent: '10.00000000',
        left: '99990.00000000',
        fixed: zero,
        excluded: zero,
      },
    },
  },
  {
    name: 'no allowance: amount and left are null, the rest is still reported',
    steps: [{ movement: card('2026-11-02', '10.00', 'Shop') }],
    months: { '2026-11': { ...none, spent: '10.00000000', fixed: zero, excluded: zero } },
  },
  {
    name: 'a merchant rule matches card purchases only: a transfer with the same counterparty name still counts',
    steps: [
      { movement: out('2026-11-03', '300.00', { ...LANDLORD, name: 'Cafe Nandu' }) },
      { movement: card('2026-11-04', '40.00', 'Cafe Nandu') },
      { rule: { scheme: 'merchant', value: 'Cafe Nandu', class: 'excluded' } },
    ],
    months: { '2026-11': { ...none, spent: '300.00000000', fixed: zero, excluded: '40.00000000' } },
  },
  {
    name: 'two rules match one movement: the newest wins',
    steps: [
      { movement: out('2026-11-03', '300.00') },
      { rule: { scheme: 'counterparty-account', value: LANDLORD.account, class: 'fixed' } },
      { rule: { scheme: 'counterparty-tax-id', value: LANDLORD.taxId, class: 'excluded' } },
    ],
    months: { '2026-11': { ...none, spent: zero, fixed: zero, excluded: '300.00000000' } },
  },
]

beforeAll(async () => {
  t = await testDatabase()
})

describe('allowance golden cases', () => {
  it.each(GOLDEN)('$name', async ({ steps, months }) => {
    await fresh()
    let lastRule = ''
    for (const step of steps) {
      if ('movement' in step) await record(step.movement)
      else if ('allowance' in step) await as((s) => setAllowance(s, ...step.allowance))
      else if ('rule' in step) lastRule = await as((s) => addRule(s, step.rule))
      else expect(await as((s) => revokeRule(s, lastRule))).toBe(true)
    }
    for (const [month, expected] of Object.entries(months)) {
      expect(await as((s) => allowanceMonth(s, month))).toEqual({
        month,
        currency: 'ARS',
        ...expected,
      })
    }
  })

  it('revoking the newest of two matching rules brings the older one back', async () => {
    await fresh()
    await record(out('2026-11-03', '300.00'))
    await as((s) =>
      addRule(s, { scheme: 'counterparty-account', value: LANDLORD.account, class: 'fixed' }),
    )
    const newest = await as((s) =>
      addRule(s, { scheme: 'counterparty-tax-id', value: LANDLORD.taxId, class: 'excluded' }),
    )
    await as((s) => revokeRule(s, newest))
    expect(await as((s) => allowanceMonth(s, '2026-11'))).toMatchObject({
      fixed: '300.00000000',
      excluded: zero,
    })
  })

  it('the second of two matching rules added in one transaction wins, every time', async () => {
    for (let i = 0; i < 5; i++) {
      await fresh()
      await record(out('2026-11-03', '300.00'))
      await as(async (s) => {
        await addRule(s, {
          scheme: 'counterparty-account',
          value: LANDLORD.account,
          class: 'fixed',
        })
        await addRule(s, {
          scheme: 'counterparty-tax-id',
          value: LANDLORD.taxId,
          class: 'excluded',
        })
      })
      expect(await as((s) => allowanceMonth(s, '2026-11'))).toMatchObject({
        fixed: zero,
        excluded: '300.00000000',
      })
    }
  })

  it("keeps each user's allowance and rules to themselves", async () => {
    await fresh()
    await as((s) => setAllowance(s, '1000', '2026-11'))
    await as((s) => addRule(s, { scheme: 'merchant', value: 'x', class: 'fixed' }))
    const first = user
    await fresh()
    expect(await as((s) => allowanceMonth(s, '2026-11'))).toMatchObject({ amount: null })
    expect(await as((s) => activeRules(s))).toEqual([])
    expect(first).not.toBe(user)
  })
})

describe('rules', () => {
  it('lists the active rules newest first and revokes once', async () => {
    await fresh()
    const a = await as((s) => addRule(s, { scheme: 'merchant', value: 'Café', class: 'fixed' }))
    const b = await as((s) =>
      addRule(s, { scheme: 'counterparty-tax-id', value: LANDLORD.taxId, class: 'excluded' }),
    )
    expect(
      (await as((s) => activeRules(s))).map((r) => [r.id, r.scheme, r.value, r.class]),
    ).toEqual([
      [b, 'counterparty-tax-id', LANDLORD.taxId, 'excluded'],
      [a, 'merchant', 'cafe', 'fixed'],
    ])
    expect(await as((s) => revokeRule(s, a))).toBe(true)
    expect(await as((s) => revokeRule(s, a))).toBe(false)
    expect(await as((s) => revokeRule(s, 'not-an-id'))).toBe(false)
    expect(await as((s) => revokeRule(s, crypto.randomUUID()))).toBe(false)
    expect((await as((s) => activeRules(s))).map((r) => r.id)).toEqual([b])
  })

  it("cannot revoke a revocation, or another user's rule", async () => {
    await fresh()
    const mine = await as((s) => addRule(s, { scheme: 'merchant', value: 'a', class: 'fixed' }))
    await as((s) => revokeRule(s, mine))
    const [revocation] = (
      await t.pg.query<{ id: string }>(
        'select id from rule where revokes is not null and user_id = $1',
        [user],
      )
    ).rows
    expect(await as((s) => revokeRule(s, revocation?.id ?? ''))).toBe(false)
    const other = user
    await fresh()
    const theirs = await asUser(t.app, other, (s) =>
      addRule(s, { scheme: 'merchant', value: 'b', class: 'fixed' }),
    )
    expect(await as((s) => revokeRule(s, theirs))).toBe(false)
  })

  it.each([
    [{ scheme: 'merchant', value: '  ', class: 'fixed' }],
    [{ scheme: 'counterparty-account', value: '123', class: 'fixed' }],
    [{ scheme: 'counterparty-tax-id', value: '20111111113', class: 'fixed' }],
    [{ scheme: 'merchant', value: 'x', class: 'savings' }],
  ])('refuses the invalid rule %j', async (input) => {
    await fresh()
    await expect(as((s) => addRule(s, input as never))).rejects.toThrow(AllowanceInputError)
  })

  it('refuses a bad allowance and a bad month', async () => {
    await fresh()
    await expect(as((s) => setAllowance(s, '0', '2026-11'))).rejects.toThrow(AllowanceInputError)
    await expect(as((s) => setAllowance(s, '10.555', '2026-11'))).rejects.toThrow(
      AllowanceInputError,
    )
    await expect(as((s) => setAllowance(s, '10', '2026-11-15'))).rejects.toThrow(
      AllowanceInputError,
    )
    await expect(as((s) => allowanceMonth(s, '2026-13'))).rejects.toThrow(AllowanceInputError)
  })

  it('folds a merchant in SQL exactly as core does on write', async () => {
    await fresh()
    const samples = ['Café Ñandú', ' ÁÉÍÓÚ  Üü ', 'Café', 'Ž Straße', 'A\tB\nC', 'x']
    for (const sample of samples) {
      await record(card('2026-11-02', `${10 + samples.indexOf(sample)}.00`, sample))
      await as((s) => addRule(s, { scheme: 'merchant', value: sample, class: 'excluded' }))
    }
    const month = await as((s) => allowanceMonth(s, '2026-11'))
    expect(month.spent).toBe(zero)
    expect(foldMerchant('Ž Straße')).toBe('Ž straße')
  })
})

describe('allowance months', () => {
  it('stores the first of the month, and the table refuses any other day', async () => {
    await fresh()
    await as((s) => setAllowance(s, '1000', '2026-11'))
    const days = await t.pg.query<{ d: string }>(
      'select valid_from::text d from allowance where user_id = $1',
      [user],
    )
    expect(days.rows).toEqual([{ d: '2026-11-01' }])
    await expect(
      as((s) =>
        s.tx.execute(
          sql`insert into allowance (amount, currency, valid_from) values (1, 'ARS', '2026-11-15')`,
        ),
      ),
    ).rejects.toThrow(/allowance_valid_from_first|Failed query/)
  })
})

describe('append-only', () => {
  it.each(['allowance', 'rule'])('refuses update, delete and truncate on %s', async (table) => {
    await fresh()
    await as((s) => setAllowance(s, '1000', '2026-11'))
    await as((s) => addRule(s, { scheme: 'merchant', value: 'x', class: 'fixed' }))
    const app = (statement: string) => as((s) => s.tx.execute(sql.raw(statement)))
    await expect(app(`update ${table} set user_id = user_id`)).rejects.toThrow(
      /permission denied|Failed query/,
    )
    await expect(app(`delete from ${table}`)).rejects.toThrow(/permission denied|Failed query/)
    for (const statement of [
      `update ${table} set created_at = created_at`,
      `delete from ${table}`,
      `truncate ${table}`,
    ]) {
      await expect(t.pg.exec(statement)).rejects.toThrow(/append-only/)
    }
  })
})
