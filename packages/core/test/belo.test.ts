import { beforeAll, describe, expect, it } from 'vitest'
import { matchMovement } from '../src/ledger'
import { type BankOperation, parseBankMail } from '../src/mail/parse'
import { parseMoney, parseTimestamp } from '../src/mail/parse/fields'
import { SENDERS } from '../src/mail/senders'
import { verifySignedMail } from '../src/mail/verify'
import { formatMoney } from '../src/notify'
import { beloMessage, MAILBOX, makeSigner, RECEIVED_AT, resolverFor } from './helpers'

// Wording follows the layouts table of the slice 7 spec; every amount is invented.
const page = (...lines: string[]) =>
  `<html><body>${lines.map((l) => `<p>${l}</p>`).join('')}</body></html>`
const ARS_DEPOSIT = 'Aviso de operación - 14/11/2026 10:05:33'
const ARS_WITHDRAWAL = 'Retiro exitoso! - 14/11/2026 11:20:01'
const USD_WITHDRAWAL = '¡Retiro exitoso! - 14/11/2026 12:30:59'
const USD_DEPOSIT = 'Recibiste un depósito en dólares 💵'

const belo = makeSigner('belo.app')
let verifyOptions: Parameters<typeof verifySignedMail>[1]
beforeAll(() => {
  verifyOptions = {
    senders: SENDERS,
    mailboxes: [MAILBOX],
    resolver: resolverFor({ [belo.dnsName]: belo.record }),
    receivedAt: RECEIVED_AT,
    maxDateSkewMinutes: 120,
  }
})

/** Signs the mail, verifies it as intake does, and parses what verifies. */
async function parseSigned(subject: string, html: string, date?: string) {
  const bytes = new TextEncoder().encode(
    await belo.sign(beloMessage({ subject, html, ...(date ? { date } : {}) })),
  )
  const v = await verifySignedMail(bytes, {
    ...verifyOptions,
    receivedAt: date ? new Date(date) : RECEIVED_AT,
  })
  if (v.verdict !== 'verified') throw new Error(`not verified: ${v.reason}`)
  return parseBankMail(bytes, v)
}

describe('money in a wallet mail', () => {
  const wallet = (t: string) => parseMoney(t, 'amount', { wallet: true })
  it('reads the forms Belo prints', () => {
    expect(wallet('$1695')).toEqual({ amount: '1695.00', currency: 'ARS' })
    expect(wallet('$9999,99')).toEqual({ amount: '9999.99', currency: 'ARS' })
    expect(wallet('$999.999,99')).toEqual({ amount: '999999.99', currency: 'ARS' })
    expect(wallet('99,99 USD')).toEqual({ amount: '99.99', currency: 'USD' })
    expect(wallet('99,99 USD₮')).toEqual({ amount: '99.99', currency: 'USDT' })
    expect(wallet('999,99 USDT')).toEqual({ amount: '999.99', currency: 'USDT' })
  })
  it('refuses what is not money', () => {
    for (const bad of ['$12,3', '$1.23,45', '99,99 EUR', '99,99', '$ 1,234,56', ''])
      expect(() => wallet(bad), bad).toThrow()
  })
  it('keeps the bank forms strict: places always, currency first', () => {
    expect(() => parseMoney('$1695')).toThrow()
    expect(() => parseMoney('99,99 USD')).toThrow()
  })
  it('reads the Subject timestamp to the minute', () => {
    expect(parseTimestamp('14/11/2026 10:05:33')).toEqual({ date: '2026-11-14', time: '10:05' })
    expect(() => parseTimestamp('14/11/2026 25:05:33')).toThrow()
  })
  it('writes USDT in a notice the way the mail names it', () => {
    expect(formatMoney('99.99000000', 'USDT')).toBe('USDT 99,99')
    expect(formatMoney('1500.00000000', 'ARS')).toBe('$ 1.500,00')
  })
})

describe('belo templates', () => {
  const operation = (kind: 'transfer_in' | 'transfer_out', over: Partial<BankOperation>) =>
    ({
      kind,
      time: null,
      counterparty: { name: null, account: null, taxId: null },
      reference: null,
      reason: null,
      ...over,
    }) as BankOperation

  it('reads an ARS deposit', async () => {
    const r = await parseSigned(
      ARS_DEPOSIT,
      page('Depósito exitoso', 'Tu cuenta de belo recibió un depósito de $12.345,60'),
    )
    expect(r).toEqual({
      status: 'parsed',
      templateId: 'belo.ars-deposit',
      templateVersion: 1,
      operation: operation('transfer_in', {
        amount: '12345.60',
        currency: 'ARS',
        date: '2026-11-14',
        time: '10:05',
        ownAccount: 'belo ARS',
      }),
    })
  })

  it('reads an ARS withdrawal, with no decimals printed', async () => {
    const r = await parseSigned(ARS_WITHDRAWAL, page('Retiraste $1695 a una cuenta propia'))
    expect(r).toMatchObject({
      status: 'parsed',
      templateId: 'belo.ars-withdrawal',
      operation: {
        kind: 'transfer_out',
        amount: '1695.00',
        currency: 'ARS',
        time: '11:20',
        ownAccount: 'belo ARS',
      },
    })
  })

  it('reads a USD withdrawal as USD out of the USDT account', async () => {
    const r = await parseSigned(
      USD_WITHDRAWAL,
      page('Realizaste un retiro en dólares', 'Retiraste 99,99 USD a una cuenta propia'),
    )
    expect(r).toMatchObject({
      status: 'parsed',
      templateId: 'belo.usd-withdrawal',
      operation: {
        kind: 'transfer_out',
        amount: '99.99',
        currency: 'USD',
        time: '12:30',
        ownAccount: 'belo USDT',
      },
    })
  })

  it('reads a USD deposit as USDT in, dated by the signed Date in Argentina, with no time', async () => {
    // 01:30 UTC on the 15th is still the 14th in Argentina.
    const r = await parseSigned(
      USD_DEPOSIT,
      page('Se acreditó con éxito 250,00 USD₮ en tu cuenta.'),
      'Sun, 15 Nov 2026 01:30:00 +0000',
    )
    expect(r).toMatchObject({
      status: 'parsed',
      templateId: 'belo.usd-deposit',
      operation: {
        kind: 'transfer_in',
        amount: '250.00',
        currency: 'USDT',
        date: '2026-11-14',
        time: null,
        ownAccount: 'belo USDT',
      },
    })
  })

  it('leaves conversions, card purchases and unknown wording without a template', async () => {
    for (const html of [
      page('Se realizó con éxito tu conversión de 100,00 USDT por $120.000,00'),
      page('Compra exitosa', 'Hiciste una compra de 5,00 USDT en Cafe Ejemplo'),
      page('Algo que Belo nunca dijo'),
    ])
      expect(await parseSigned(ARS_DEPOSIT, html)).toEqual({
        status: 'unparsed',
        templateId: null,
        templateVersion: null,
        reason: 'no-template',
      })
  })

  it('takes the amount up to its end: a final period, an adjacent block, no more', async () => {
    const ok = (html: string) =>
      parseSigned(ARS_DEPOSIT, html).then((r) => (r.status === 'parsed' ? r.operation : r))
    expect(await ok(page('Tu cuenta de belo recibió un depósito de $1695.'))).toMatchObject({
      amount: '1695.00',
    })
    expect(await ok(page('Tu cuenta de belo recibió un depósito de $1.695,50.'))).toMatchObject({
      amount: '1695.50',
    })
    // The next block starts with digits; blocks do not run together.
    expect(
      await ok(
        '<div>Tu cuenta de belo recibió un depósito de $1695</div><div>12 de noviembre</div>',
      ),
    ).toMatchObject({ amount: '1695.00' })
    // Text that is not one of the amounts parseMoney reads is not an amount.
    expect(
      await parseSigned(ARS_DEPOSIT, page('Tu cuenta de belo recibió un depósito de $1,2,3')),
    ).toMatchObject({ status: 'unparsed', templateId: null, reason: 'no-template' })
  })

  it('fails by field when the sentence is right but the currency is not', async () => {
    // A dollar sentence under the ARS subject is not an ARS withdrawal.
    expect(
      await parseSigned(ARS_WITHDRAWAL, page('Retiraste 99,99 USD a una cuenta propia')),
    ).toMatchObject({ status: 'unparsed', reason: 'schema-fail:currency' })
  })
})

describe('matchMovement across banks', () => {
  const base = {
    amount: '99.99',
    currency: 'USD' as const,
    date: '2026-11-14',
    reference: null,
    reason: null,
  }
  const bankIn: BankOperation = {
    ...base,
    kind: 'transfer_in',
    time: null,
    ownAccount: 'CA-USD ***1',
    counterparty: { name: null, account: '0170099220000012345670', taxId: '20123456786' },
  }
  const beloOut: BankOperation = {
    ...base,
    kind: 'transfer_out',
    time: '12:30',
    ownAccount: 'belo USDT',
    counterparty: { name: null, account: null, taxId: null },
  }
  const src = (templateId: string, operation: BankOperation) => ({
    mailId: templateId,
    templateId,
    operation,
  })

  it('joins the wallet mail to the movement whose counter account it is, times unequal', () => {
    const bank = {
      movementId: 'm1',
      sources: [src('bank.credited', { ...bankIn, time: '12:33' })],
      accounts: { own: 'asset:bank:usd', counter: 'asset:belo:usdt' },
    }
    const incoming = {
      templateId: 'belo.usd-withdrawal',
      operation: beloOut,
      accounts: { own: 'asset:belo:usdt', counter: null },
    }
    expect(matchMovement(incoming, [bank])).toBe('m1')
    expect(matchMovement(incoming, [bank, { ...bank, movementId: 'm2' }])).toBeNull()
    expect(
      matchMovement({ ...incoming, operation: { ...beloOut, amount: '99.98' } }, [bank]),
    ).toBeNull()
    expect(
      matchMovement({ ...incoming, accounts: { own: 'asset:other', counter: null } }, [bank]),
    ).toBeNull()
  })

  it('does nothing without resolved accounts', () => {
    const bank = { movementId: 'm1', sources: [src('bank.credited', bankIn)] }
    expect(
      matchMovement({ templateId: 'belo.usd-withdrawal', operation: beloOut }, [bank]),
    ).toBeNull()
  })
})
