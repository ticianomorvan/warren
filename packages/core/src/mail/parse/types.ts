import type { Currency } from './fields'
import type { Doc } from './html'

/** A transfer, as one bank mail states it. Values are exactly what the bank printed, validated. */
export type TransferOperation = {
  kind: 'transfer_out' | 'transfer_in'
  /** Positive decimal string with two places, e.g. "1234.56". */
  amount: string
  currency: Currency
  /** Operation date in Argentina, YYYY-MM-DD. */
  date: string
  /** HH:MM in Argentina, when the mail prints it. */
  time: string | null
  /** The owner's account as the bank masks it, e.g. "CA-ARS ***123/4". */
  ownAccount: string | null
  counterparty: {
    /** Free text: a person's name as the bank holds it. */
    name: string | null
    /** CBU or CVU, check digits verified. */
    account: string | null
    /** CUIT or CUIL, check digit verified. */
    taxId: string | null
  }
  /** The bank's own operation number, when printed. */
  reference: string | null
  /** The "Motivo" chosen for the transfer. */
  reason: string | null
}

/** A purchase approved on a card. The mail prints a date only, and no operation number. */
export type CardPurchaseOperation = {
  kind: 'card_purchase'
  /** The four digits the mail names: the only handle on the card. */
  cardLastFour: string
  /** Free text: the merchant as the bank prints it. */
  merchant: string
  /** Positive decimal string with two places, e.g. "1234.56". */
  amount: string
  currency: Currency
  /** Purchase date in Argentina, YYYY-MM-DD. */
  date: string
  cardType: 'credit'
}

/** What one bank mail says happened. Narrow on `kind`. */
export type BankOperation = TransferOperation | CardPurchaseOperation

export type Template = {
  id: string
  version: number
  senderId: string
  /** Tested against the decoded, signed Subject. Never against the body. */
  subject: RegExp
  parse(doc: Doc): BankOperation
}

export type ParseResult =
  | { status: 'parsed'; templateId: string; templateVersion: number; operation: BankOperation }
  | {
      status: 'unparsed'
      templateId: string | null
      templateVersion: number | null
      reason: string
    }
