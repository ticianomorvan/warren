import { inboundAddressOf, REJECT_REASONS, type RejectReason, templateKind } from '@warren/core'
import {
  asUser,
  inboundAddressFor,
  type MailProgress,
  mailboxesOf,
  onboardingProgress,
  pendingConfirmations,
} from '@warren/db'
import { database } from '@/lib/db'
import { env } from '@/lib/env'
import { t } from '@/lib/strings'

/** What the page may say about the first mail: the kind and the date, never an amount or a name. */
export type FirstMail =
  | { state: 'waiting' }
  | { state: 'rejected'; reason: string }
  | { state: 'verified'; kind: string; date: string }

const REASONS: ReadonlySet<string> = new Set(REJECT_REASONS)

export const reasonText = (reason: string | null): string =>
  reason !== null && REASONS.has(reason)
    ? t.onboarding.reasons[reason as RejectReason]
    : t.onboarding.reasonUnknown

export const kindText = (templateId: string | null): string =>
  t.onboarding.kinds[templateKind(templateId) ?? 'other']

const dayFormat = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

/** The first-mail state for the page, from the database's content-free progress. */
export function toFirstMail(progress: MailProgress): FirstMail {
  if (progress.state === 'verified')
    return {
      state: 'verified',
      kind: kindText(progress.templateId),
      date: dayFormat.format(progress.signedDate),
    }
  if (progress.state === 'rejected')
    return { state: 'rejected', reason: reasonText(progress.reason) }
  return { state: 'waiting' }
}

/** The light status: counts and words, for the poll and for home. */
export async function loadStatus(userId: string) {
  const p = await asUser(database(), userId, onboardingProgress)
  return {
    pending: p.pending,
    hasConfirmation: p.hasConfirmation,
    hasMailbox: p.hasMailbox,
    mail: toFirstMail(p.mail),
  }
}

export async function loadOnboarding(userId: string) {
  const { token, confirmations, mailboxes, progress } = await asUser(
    database(),
    userId,
    async (scope) => ({
      token: await inboundAddressFor(scope),
      confirmations: await pendingConfirmations(scope),
      mailboxes: await mailboxesOf(scope),
      progress: await onboardingProgress(scope),
    }),
  )
  // A confirmation whose address is already connected has nothing left to ask.
  const pending = confirmations
    .filter((c) => !mailboxes.includes(c.address))
    .map((c) => ({ address: c.address, url: c.url }))
  return {
    address: inboundAddressOf(token, env.inboundDomain()),
    pending,
    mailboxes,
    hasConfirmation: confirmations.length > 0,
    firstMail: toFirstMail(progress.mail),
  }
}
