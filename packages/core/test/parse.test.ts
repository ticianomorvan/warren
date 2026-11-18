import { describe, expect, it } from 'vitest'
import { parseBankMail } from '../src/mail/parse'
import {
  daysFromInstant,
  parseCbu,
  parseCuit,
  parseDate,
  parseMoney,
} from '../src/mail/parse/fields'
import {
  CBU,
  CUIT,
  cardPurchaseHtml,
  cardValueRow,
  htmlMessage,
  transferNoticeHtml,
  transferSentHtml,
} from './fixtures'
import { MAILBOX } from './helpers'

const SIGNED = new Date('2026-11-14T13:00:00Z')
const parse = (subject: string, html: string) =>
  parseBankMail(new TextEncoder().encode(htmlMessage(subject, html, MAILBOX)), {
    senderId: 'bbva-transfers',
    subject,
    signedDate: SIGNED,
  })
const DEBIT = 'Mensajes y Avisos por e-mail - AVISO TRANSFERENCIA INMEDIATA DEBITADA'
const CREDIT = 'Mensajes y Avisos por e-mail - AVISO TRANSFERENCIA INMEDIATA ACREDITADA'
const SENT = 'Realizaste una transferencia'

describe('field validators', () => {
  it('reads Argentine money without floats', () => {
    expect(parseMoney('$ 3,77')).toEqual({ amount: '3.77', currency: 'ARS' })
    expect(parseMoney('ARS 1.234.567,00')).toEqual({ amount: '1234567.00', currency: 'ARS' })
    expect(parseMoney('U$S 100,50')).toEqual({ amount: '100.50', currency: 'USD' })
    for (const bad of ['3,77', '$ 3.77', '$ 1.23,45', '$ -3,77', 'EUR 3,77', '$ 3,7', ''])
      expect(() => parseMoney(bad), bad).toThrow()
  })
  it('checks dates, CBU and CUIT check digits', () => {
    expect(parseDate('29/02/2028')).toBe('2028-02-29')
    expect(() => parseDate('31/02/2026')).toThrow()
    expect(parseCbu(CBU)).toBe(CBU)
    expect(() => parseCbu(`${CBU.slice(0, 21)}${(Number(CBU[21]) + 1) % 10}`)).toThrow()
    expect(parseCuit(CUIT)).toBe(CUIT)
    expect(() => parseCuit(`${CUIT.slice(0, 10)}${(Number(CUIT[10]) + 1) % 10}`)).toThrow()
  })
  it('compares dates in Argentina time', () => {
    // 01:30 UTC on the 15th is still the 14th in Argentina.
    expect(daysFromInstant('2026-11-14', new Date('2026-11-15T01:30:00Z'))).toBe(0)
    expect(daysFromInstant('2026-11-10', new Date('2026-11-14T13:00:00Z'))).toBe(-4)
  })
})

describe('bbva.transfer-sent', () => {
  it('reads every field', async () => {
    expect(await parse(SENT, transferSentHtml())).toEqual({
      status: 'parsed',
      templateId: 'bbva.transfer-sent',
      templateVersion: 1,
      operation: {
        kind: 'transfer_out',
        amount: '12345.60',
        currency: 'ARS',
        date: '2026-11-14',
        time: '09:58',
        ownAccount: null,
        counterparty: { name: 'Juana Ejemplo', account: CBU, taxId: CUIT },
        reference: '10170000000000001',
        reason: 'VARIOS',
      },
    })
  })
  it('fails by field name when a value is malformed', async () => {
    expect(await parse(SENT, transferSentHtml({ amount: '$ 12,3' }))).toMatchObject({
      status: 'unparsed',
      templateId: 'bbva.transfer-sent',
      reason: 'schema-fail:amount',
    })
    expect(await parse(SENT, transferSentHtml({ cbu: '1'.repeat(22) }))).toMatchObject({
      reason: 'schema-fail:cbu',
    })
  })
  it('fails when the bank adds a field the template does not know', async () => {
    const extra = '<tr><td><b>Concepto nuevo</b></td></tr><tr><td class="not-bold-text">X</td></tr>'
    expect(await parse(SENT, transferSentHtml({}, extra))).toMatchObject({
      status: 'unparsed',
      reason: 'schema-fail:unknown-label',
    })
  })
  it('refuses a printed date far from the signed date', async () => {
    expect(await parse(SENT, transferSentHtml({ when: '01/10/2026 - 09:58' }))).toMatchObject({
      reason: 'schema-fail:date-far-from-signed',
    })
  })
})

describe('bbva transfer notices', () => {
  it('reads a debit notice', async () => {
    const r = await parse(DEBIT, transferNoticeHtml('destino'))
    expect(r).toMatchObject({
      status: 'parsed',
      templateId: 'bbva.transfer-debited',
      operation: {
        kind: 'transfer_out',
        amount: '12345.60',
        currency: 'ARS',
        date: '2026-11-14',
        time: null,
        ownAccount: 'CA-ARS ***123/4',
        counterparty: { name: null, account: CBU, taxId: CUIT },
        reference: null,
      },
    })
  })
  it('reads a credit notice, with CBU or CVU as the label', async () => {
    for (const label of ['CVU', 'CBU']) {
      const r = await parse(CREDIT, transferNoticeHtml('origen', {}, label))
      expect(r).toMatchObject({
        status: 'parsed',
        templateId: 'bbva.transfer-credited',
        operation: { kind: 'transfer_in', amount: '12345.60' },
      })
    }
  })
  it('does not read a debit layout under a credit subject', async () => {
    expect(await parse(CREDIT, transferNoticeHtml('destino'))).toMatchObject({ status: 'unparsed' })
  })
})

describe('template choice', () => {
  it('reports no template for an unknown subject or sender', async () => {
    expect(await parse('Compra rechazada', transferSentHtml())).toEqual({
      status: 'unparsed',
      templateId: null,
      templateVersion: null,
      reason: 'no-template',
    })
    // The card template belongs to the cards sender: the transfers sender gets none.
    expect(await parse('Compra aprobada', cardPurchaseHtml())).toMatchObject({
      reason: 'no-template',
    })
    const other = await parseBankMail(
      new TextEncoder().encode(htmlMessage(SENT, transferSentHtml(), MAILBOX)),
      {
        senderId: 'bbva-cards',
        subject: SENT,
        signedDate: SIGNED,
      },
    )
    expect(other).toMatchObject({ reason: 'no-template' })
  })
  it('decodes an encoded Subject before matching', async () => {
    const encoded = `=?UTF-8?B?${Buffer.from(SENT).toString('base64')}?=`
    const r = await parseBankMail(
      new TextEncoder().encode(htmlMessage(SENT, transferSentHtml(), MAILBOX)),
      {
        senderId: 'bbva-transfers',
        subject: encoded,
        signedDate: SIGNED,
      },
    )
    expect(r.status).toBe('parsed')
  })
})

describe('bbva card purchase', () => {
  const card = (html: string) =>
    parseBankMail(new TextEncoder().encode(htmlMessage('Compra aprobada', html, MAILBOX)), {
      senderId: 'bbva-cards',
      subject: 'Compra aprobada',
      signedDate: SIGNED,
    })
  const reason = async (html: string) => ((await card(html)) as { reason: string }).reason

  it('reads an ARS purchase from the unlabeled value rows', async () => {
    expect(await card(cardPurchaseHtml())).toEqual({
      status: 'parsed',
      templateId: 'bbva.card-purchase',
      templateVersion: 1,
      operation: {
        kind: 'card_purchase',
        cardLastFour: '1234',
        merchant: 'COMERCIO DE EJEMPLO SRL',
        amount: '12345.60',
        currency: 'ARS',
        date: '2026-11-14',
        cardType: 'credit',
      },
    })
  })
  it('reads a dollar purchase, with either symbol', async () => {
    for (const amount of ['US$ 12,34', 'U$S 12,34']) {
      expect(await card(cardPurchaseHtml({ amount }))).toMatchObject({
        status: 'parsed',
        operation: { amount: '12.34', currency: 'USD' },
      })
    }
  })
  it('allows digits in the merchant', async () => {
    expect(await card(cardPurchaseHtml({ merchant: 'KIOSCO 24 HS' }))).toMatchObject({
      operation: { merchant: 'KIOSCO 24 HS' },
    })
  })
  it('fails closed without the credit-card heading', async () => {
    expect(await reason(cardPurchaseHtml({ heading: 'Pagaste con tu tarjeta de débito' }))).toBe(
      'schema-fail:heading',
    )
    expect(await reason(transferSentHtml())).toBe('schema-fail:heading')
  })
  it('fails closed unless the intro holds exactly one 4-digit run', async () => {
    const two = 'Hola, tarjeta terminada en 1234, autorizada a las 1015.'
    expect(await reason(cardPurchaseHtml({ intro: two }))).toBe('schema-fail:card')
    expect(await reason(cardPurchaseHtml({ intro: 'Hola, se aprobó un pago.' }))).toBe(
      'schema-fail:card',
    )
  })
  it('never takes a year or an amount for the card', async () => {
    const year = 'Hola, se aprobó tu primera compra del año 2026.'
    expect(await reason(cardPurchaseHtml({ intro: year }))).toBe('schema-fail:card')
    const amount = 'Hola, se aprobó un pago de $ 1500,00.'
    expect(await reason(cardPurchaseHtml({ intro: amount }))).toBe('schema-fail:card')
  })
  it('fails closed on a changed value table', async () => {
    expect(await reason(cardPurchaseHtml({ extraRows: cardValueRow('4 cuotas') }))).toBe(
      'schema-fail:layout',
    )
    expect(await reason(cardPurchaseHtml({ date: '2026-11-14' }))).toBe('schema-fail:date')
    expect(await reason(cardPurchaseHtml({ amount: '12,34' }))).toBe('schema-fail:amount')
    expect(await reason(cardPurchaseHtml({ merchant: '  ' }))).toBe('schema-fail:merchant')
  })
})
