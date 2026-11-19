import type { Currency } from '../../../assets'
import { argentinaDate, FieldError, parseMoney, parseTimestamp } from '../fields'
import { bodyText, type Doc } from '../html'
import type { SignedHeaders, Template } from '../types'

/**
 * Belo's mail is one sentence with the amount: no counterparty, account, CVU or reference. The
 * operation time is in the signed Subject ("dd/mm/yyyy hh:mm:ss"), except for the USD deposit,
 * whose subject has none: its date is the signed Date's, in Argentina, and it has no time.
 * Wording is matched exactly as the layouts table of the slice 7 spec records it.
 */
// The grammar parseMoney accepts: thousands with '.', optional ',dd', and no digit after it.
const NUMBER = String.raw`(?:\d{1,3}(?:\.\d{3})*|\d+)(?:,\d{2})?(?![.,]?\d)`
const AMOUNT = String.raw`(\$\s?${NUMBER}|${NUMBER} ?(?:USD₮|USDT|USD)(?![A-Za-z]))`
const TIMESTAMP = String.raw`(\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2})`

function belo(spec: {
  id: string
  kind: 'transfer_in' | 'transfer_out'
  currency: Currency
  /** The label the operator seeds as a `bank-label` of the Belo account holding this currency. */
  ownAccount: string
  subject: RegExp
  /** Group 1 is the amount. */
  sentence: RegExp
  timed: boolean
}): Template {
  return {
    id: spec.id,
    kind: 'transfer',
    version: 1,
    senderId: 'belo',
    subject: spec.subject,
    body: spec.sentence,
    parse(doc: Doc, signed: SignedHeaders) {
      const amount = spec.sentence.exec(bodyText(doc))?.[1]
      const money = parseMoney(amount ?? '', 'amount', { wallet: true })
      if (money.currency !== spec.currency) throw new FieldError('currency')
      const when = spec.timed
        ? parseTimestamp(spec.subject.exec(signed.subject)?.[1] ?? '', 'date')
        : { date: argentinaDate(signed.date), time: null }
      return {
        kind: spec.kind,
        ...money,
        ...when,
        ownAccount: spec.ownAccount,
        counterparty: { name: null, account: null, taxId: null },
        reference: null,
        reason: null,
      }
    },
  }
}

export const beloArsDeposit = belo({
  id: 'belo.ars-deposit',
  kind: 'transfer_in',
  currency: 'ARS',
  ownAccount: 'belo ARS',
  subject: new RegExp(`^Aviso de operación - ${TIMESTAMP}$`),
  sentence: new RegExp(`Tu cuenta de belo recibió un depósito de ${AMOUNT}`),
  timed: true,
})

export const beloArsWithdrawal = belo({
  id: 'belo.ars-withdrawal',
  kind: 'transfer_out',
  currency: 'ARS',
  ownAccount: 'belo ARS',
  subject: new RegExp(`^Retiro exitoso! - ${TIMESTAMP}$`),
  sentence: new RegExp(`Retiraste ${AMOUNT} a una cuenta propia`),
  timed: true,
})

export const beloUsdWithdrawal = belo({
  id: 'belo.usd-withdrawal',
  kind: 'transfer_out',
  currency: 'USD',
  ownAccount: 'belo USDT',
  subject: new RegExp(`^¡Retiro exitoso! - ${TIMESTAMP}$`),
  sentence: new RegExp(`Retiraste ${AMOUNT} a una cuenta propia`),
  timed: true,
})

export const beloUsdDeposit = belo({
  id: 'belo.usd-deposit',
  kind: 'transfer_in',
  currency: 'USDT',
  ownAccount: 'belo USDT',
  subject: /^Recibiste un depósito en dólares/,
  sentence: new RegExp(`Se acreditó con éxito ${AMOUNT} en tu cuenta`),
  timed: false,
})
