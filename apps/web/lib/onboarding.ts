import { inboundAddressOf, REJECT_REASONS, type RejectReason } from '@warren/core'
import {
  asUser,
  firstMailProgress,
  inboundAddressFor,
  mailboxesOf,
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

export type StepState = 'done' | 'current' | 'todo'
export const STEP_COUNT = 6

/**
 * The state of the six steps, from what the server knows. Step 1 is done once Google's request or
 * a mailbox exists; 2 and 3 once a mailbox does (which of the two is current before that is the
 * browser's, since only it knows whether the link was opened); 4 and 5 once a verified mail
 * arrived after the mailbox; 6 has no data of its own and is never done. The first step not done
 * is current and the ones after it wait.
 */
export function stepStates(p: {
  hasConfirmation: boolean
  hasMailbox: boolean
  verified: boolean
}): StepState[] {
  const done = [
    p.hasConfirmation || p.hasMailbox,
    p.hasMailbox,
    p.hasMailbox,
    p.verified,
    p.verified,
    false,
  ]
  const current = done.indexOf(false)
  return done.map((d, i) => (d ? 'done' : i === current ? 'current' : 'todo'))
}

const REASONS: ReadonlySet<string> = new Set(REJECT_REASONS)

export const reasonText = (reason: string | null): string =>
  reason !== null && REASONS.has(reason)
    ? t.onboarding.reasons[reason as RejectReason]
    : t.onboarding.reasonUnknown

export const kindText = (templateId: string | null): string =>
  templateId?.startsWith('bbva.card-')
    ? t.onboarding.kinds.card
    : templateId?.startsWith('bbva.transfer-')
      ? t.onboarding.kinds.transfer
      : t.onboarding.kinds.other

const dayFormat = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

/** The first-mail state for the page, from the database's content-free progress. */
export async function loadFirstMail(userId: string): Promise<FirstMail> {
  const progress = await asUser(database(), userId, firstMailProgress)
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

export async function loadOnboarding(userId: string) {
  const { token, confirmations, mailboxes } = await asUser(database(), userId, async (scope) => ({
    token: await inboundAddressFor(scope),
    confirmations: await pendingConfirmations(scope),
    mailboxes: await mailboxesOf(scope),
  }))
  // A confirmation whose address is already connected has nothing left to ask.
  const pending = confirmations
    .filter((c) => !mailboxes.includes(c.address))
    .map((c) => ({ address: c.address, url: c.url }))
  return {
    address: inboundAddressOf(token, env.inboundDomain()),
    pending,
    mailboxes,
    hasConfirmation: confirmations.length > 0,
    firstMail: await loadFirstMail(userId),
  }
}
