import PostalMime, { decodeWords } from 'postal-mime'
import { daysFromInstant, FieldError } from './fields'
import { bodyText, parseDocument } from './html'
import { bbvaCardPurchase } from './templates/bbva-card-purchase'
import { bbvaTransferCredited, bbvaTransferDebited } from './templates/bbva-transfer-notice'
import { bbvaTransferSent } from './templates/bbva-transfer-sent'
import {
  beloArsDeposit,
  beloArsWithdrawal,
  beloUsdDeposit,
  beloUsdWithdrawal,
} from './templates/belo'
import type { ParseResult, Template } from './types'

export type {
  BankOperation,
  CardPurchaseOperation,
  ParseResult,
  SignedHeaders,
  Template,
  TemplateKind,
  TransferOperation,
} from './types'

export const TEMPLATES: readonly Template[] = [
  bbvaTransferSent,
  bbvaTransferDebited,
  bbvaTransferCredited,
  bbvaCardPurchase,
  beloArsDeposit,
  beloArsWithdrawal,
  beloUsdWithdrawal,
  beloUsdDeposit,
]

/** The kind of notice a stored template id reads, or null for an id no template has. */
export const templateKind = (templateId: string | null) =>
  TEMPLATES.find((t) => t.id === templateId)?.kind ?? null

/** Recorded with "no template" results, so they are retried once new templates ship. */
export const TEMPLATE_SET_VERSION = 3

/** The printed date may differ from the signed Date by a weekend or holiday, not more. */
const MAX_DATE_DISTANCE_DAYS = 3

export type VerifiedMail = {
  senderId: string
  /** Raw value of the signed Subject header. */
  subject: string
  signedDate: Date
}

/**
 * Turns a verified mail into a typed operation. Only call this for mail that passed
 * verifySignedMail: the template is chosen from signed headers, and the body is trusted
 * because the signature covers it.
 */
export async function parseBankMail(raw: Uint8Array, mail: VerifiedMail): Promise<ParseResult> {
  const subject = decodeWords(mail.subject).replace(/\s+/g, ' ').trim()
  const named = TEMPLATES.filter((t) => t.senderId === mail.senderId && t.subject.test(subject))
  const first = named[0]
  if (!first) {
    return { status: 'unparsed', templateId: null, templateVersion: null, reason: 'no-template' }
  }
  const { html } = await PostalMime.parse(raw)
  if (!html) return unparsedBy(first, 'no-html')
  const doc = parseDocument(html)
  // Templates that share a subject are told apart by the sentence in the body. Nothing that
  // matches none of them is guessed at.
  const text = bodyText(doc)
  const template = named.find((t) => !t.body || t.body.test(text))
  if (!template) {
    return { status: 'unparsed', templateId: null, templateVersion: null, reason: 'no-template' }
  }
  const unparsed = (reason: string) => unparsedBy(template, reason)
  try {
    const operation = template.parse(doc, { subject, date: mail.signedDate })
    if (Math.abs(daysFromInstant(operation.date, mail.signedDate)) > MAX_DATE_DISTANCE_DAYS) {
      return unparsed('schema-fail:date-far-from-signed')
    }
    return {
      status: 'parsed',
      templateId: template.id,
      templateVersion: template.version,
      operation,
    }
  } catch (error) {
    if (error instanceof FieldError) return unparsed(`schema-fail:${error.field}`)
    throw error
  }
}

const unparsedBy = (template: Template, reason: string): ParseResult => ({
  status: 'unparsed',
  templateId: template.id,
  templateVersion: template.version,
  reason,
})
