import type { Currency } from '../../assets'
import type { Doc } from './html'

/** A transfer, as one bank mail states it. Values are exactly what the bank printed, validated. */
export type TransferOperation = {
  kind: 'transfer_out' | 'transfer_in'
  /** Positive decimal string with the asset's places, e.g. "1234.56". */
  amount: string
  currency: Currency
  /** Operation date in Argentina, YYYY-MM-DD. */
  date: string
  /** HH:MM in Argentina, when the mail prints it. */
  time: string | null
  /** The owner's account as the bank masks it, e.g. "CA-ARS ***123/4". */
  ownAccount: string | null
  /** All null when the mail names no counterparty (a wallet's mail names none). */
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

/** What a template's mail is about, in words a page can translate. */
export type TemplateKind = 'card' | 'transfer'

export type Template = {
  id: string
  /** The sort of notice this template reads. */
  kind: TemplateKind
  version: number
  senderId: string
  /** Tested against the decoded, signed Subject. */
  subject: RegExp
  /**
   * For senders whose kinds share one subject: the wording of the body that picks this template.
   * A mail it does not match is left to the next template, or to "no template".
   */
  body?: RegExp
  /**
   * The mail says the other side of its transfer is one of the owner's own accounts, without
   * naming it ("a una cuenta propia"). A property of the template, not of the stored operation,
   * so mail recorded before the template said so is covered too.
   */
  counterpartyIsOwn?: true
  parse(doc: Doc, signed: SignedHeaders): BankOperation
}

/** What the signature vouches for, for a template whose mail does not print everything itself. */
export type SignedHeaders = {
  /** The decoded Subject, whitespace collapsed. */
  subject: string
  /** The Date header. */
  date: Date
}

export type ParseResult =
  | { status: 'parsed'; templateId: string; templateVersion: number; operation: BankOperation }
  | {
      status: 'unparsed'
      templateId: string | null
      templateVersion: number | null
      reason: string
    }
