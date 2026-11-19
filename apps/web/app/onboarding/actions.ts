'use server'

import { errorTag, reverifyRejected } from '@warren/core'
import { asUser, type ClaimStatus, claimMailbox } from '@warren/db'
import { database } from '@/lib/db'
import { intakeDeps } from '@/lib/intake'
import { type FirstMail, loadStatus } from '@/lib/onboarding'
import { getSession } from '@/lib/session'

/*
 * Claims a Gmail address as the signed-in person's mailbox. A Server Action: Next checks the
 * request's Origin. It acts only for the session's user, through `asUser`, and the database
 * decides (`claim_mailbox`): only an address Google confirmed to this user in the last 7 days.
 * On a claim, mail rejected as not addressed to the user is checked again. Nothing here logs
 * the address.
 */

export type ClaimResult =
  | { ok: true; status: ClaimStatus; rescued: number }
  | { ok: false; reason: 'signed-out' | 'failed' }

export async function claimGmail(address: unknown): Promise<ClaimResult> {
  const session = await getSession()
  if (!session) return { ok: false, reason: 'signed-out' }
  if (typeof address !== 'string' || address.length > 320) return { ok: false, reason: 'failed' }
  let status: ClaimStatus
  try {
    status = await asUser(database(), session.user.id, (scope) => claimMailbox(scope, address))
  } catch (error) {
    console.error('claim mailbox failed:', errorTag(error))
    return { ok: false, reason: 'failed' }
  }
  // The second look comes after the claim has committed, and its failure never undoes it: the
  // person has the mailbox either way. It runs again on 'already-yours' (a retry after a failure
  // here, or a mail whose first look hit DNS trouble): a mail it already settled is not touched.
  let rescued = 0
  if (status === 'claimed' || status === 'already-yours') {
    try {
      rescued = await reverifyRejected(intakeDeps(), session.user.id)
    } catch (error) {
      console.error('second look after claim failed:', errorTag(error))
    }
  }
  return { ok: true, status, rescued }
}

export type StatusResult =
  | { ok: true; pending: number; hasMailbox: boolean; mail: FirstMail }
  | { ok: false }

/**
 * The page's poll: how many Gmails wait for a yes, whether a mailbox exists, and where the first
 * mail stands. One light transaction, and counts and words only: no address, link or mail
 * content. The page compares it with what it shows and reloads itself when something moved.
 */
export async function onboardingStatus(): Promise<StatusResult> {
  const session = await getSession()
  if (!session) return { ok: false }
  try {
    const { pending, hasMailbox, mail } = await loadStatus(session.user.id)
    return { ok: true, pending, hasMailbox, mail }
  } catch (error) {
    console.error('onboarding status failed:', errorTag(error))
    return { ok: false }
  }
}
