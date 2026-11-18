import PostalMime, { decodeWords } from 'postal-mime'
import { daysFromInstant, FieldError } from './fields'
import { parseDocument } from './html'
import { bbvaTransferCredited, bbvaTransferDebited } from './templates/bbva-transfer-notice'
import { bbvaTransferSent } from './templates/bbva-transfer-sent'
import type { ParseResult, Template } from './types'

export type { BankOperation, ParseResult, Template } from './types'

export const TEMPLATES: readonly Template[] = [
  bbvaTransferSent,
  bbvaTransferDebited,
  bbvaTransferCredited,
]

/** Recorded with "no template" results, so they are retried once new templates ship. */
export const TEMPLATE_SET_VERSION = 1

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
 * verifyBankMail: the template is chosen from signed headers, and the body is trusted
 * because the signature covers it.
 */
export async function parseBankMail(raw: Uint8Array, mail: VerifiedMail): Promise<ParseResult> {
  const subject = decodeWords(mail.subject).replace(/\s+/g, ' ').trim()
  const template = TEMPLATES.find((t) => t.senderId === mail.senderId && t.subject.test(subject))
  if (!template) {
    return { status: 'unparsed', templateId: null, templateVersion: null, reason: 'no-template' }
  }
  const unparsed = (reason: string): ParseResult => ({
    status: 'unparsed',
    templateId: template.id,
    templateVersion: template.version,
    reason,
  })

  const { html } = await PostalMime.parse(raw)
  if (!html) return unparsed('no-html')
  try {
    const operation = template.parse(parseDocument(html))
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
