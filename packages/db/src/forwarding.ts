import { createHash } from 'node:crypto'
import {
  CONFIRMATION_WINDOW_DAYS,
  type ForwardingConfirmation,
  type ForwardingConfirmations,
} from '@warren/core'
import { desc, eq, gt, sql } from 'drizzle-orm'
import { rowsOf, type Scope } from './client'
import { firstMailProgress, type MailProgress } from './mail-log'
import { forwardingConfirmation, mailbox } from './schema'

// Sealed: the address and the link. The scope adds the user; this names the table, row and column.
const aad = (hash: string, receivedAt: Date) =>
  `forwarding_confirmation:${hash}:${receivedAt.toISOString()}:data`

/** The lowercased, trimmed address: what is hashed, and what `mailbox` holds. */
export const normalizeAddress = (address: string): string => address.trim().toLowerCase()

/** sha256 hex of the normalized address: what `claim_mailbox` compares. */
export const addressHash = (address: string): string =>
  createHash('sha256').update(normalizeAddress(address), 'utf8').digest('hex')

/** What intake writes when it recognizes Google's confirmation. */
export function createForwardingConfirmations(scope: Scope): ForwardingConfirmations {
  return {
    async record(confirmation: ForwardingConfirmation, receivedAt: Date) {
      const hash = addressHash(confirmation.address)
      await scope.tx.insert(forwardingConfirmation).values({
        addressHash: hash,
        receivedAt,
        data: scope.json.seal(
          { address: normalizeAddress(confirmation.address), url: confirmation.url },
          aad(hash, receivedAt),
        ),
      })
    },
  }
}

/**
 * Every confirmation received in the window, opened, one per address (the newest of each),
 * newest first. For the page: anyone who learns a Warren address can make their own Gmail send
 * a confirmation to it, so the person must see all of them and pick theirs.
 */
export async function pendingConfirmations(
  scope: Scope,
  now: Date = new Date(),
): Promise<(ForwardingConfirmation & { receivedAt: Date })[]> {
  const since = new Date(now.getTime() - CONFIRMATION_WINDOW_DAYS * 86_400_000)
  const rows = await scope.tx
    .select()
    .from(forwardingConfirmation)
    .where(gt(forwardingConfirmation.receivedAt, since))
    .orderBy(desc(forwardingConfirmation.id))
    .limit(50)
  const seen = new Set<string>()
  const out: (ForwardingConfirmation & { receivedAt: Date })[] = []
  for (const row of rows) {
    if (seen.has(row.addressHash)) continue
    seen.add(row.addressHash)
    const data = scope.json.open<ForwardingConfirmation>(
      row.data,
      aad(row.addressHash, row.receivedAt),
    )
    out.push({ address: data.address, url: data.url, receivedAt: row.receivedAt })
  }
  return out
}

export type ClaimStatus = 'claimed' | 'already-yours' | 'taken' | 'no-confirmation'

/**
 * Claims a mailbox address for the scope's user, through the SQL function `claim_mailbox`
 * (0013), which holds the only insert path into `mailbox` for the app role and inserts only when
 * the user has a Google confirmation for that address from the last 7 days. The function reads
 * the user from `app.user_id`, which `asUser` sets, so it can only act for the session's user.
 */
export async function claimMailbox(scope: Scope, address: string): Promise<ClaimStatus> {
  const rows = rowsOf<{ status: ClaimStatus }>(
    await scope.tx.execute(sql`select claim_mailbox(${normalizeAddress(address)}) as status`),
  )
  const status = rows[0]?.status
  if (!status) throw new Error('claim_mailbox returned nothing')
  return status
}

/** The user's mailbox addresses, for the page. */
export async function mailboxesOf(scope: Scope): Promise<string[]> {
  const rows = await scope.tx
    .select({ address: mailbox.address })
    .from(mailbox)
    .where(eq(mailbox.userId, scope.userId))
    .orderBy(mailbox.address)
  return rows.map((r) => r.address)
}

/** Where onboarding stands, in counts and words: no address, no link, nothing sealed is opened. */
export type OnboardingProgress = {
  /** Gmails that asked in the window and are not yet connected. */
  pending: number
  /** Whether Google asked at all in the window, connected or not. */
  hasConfirmation: boolean
  hasMailbox: boolean
  mail: MailProgress
}

/**
 * The light read behind the page's poll and the home page: one transaction, no address made, no
 * lock, nothing unsealed. A Gmail counts as connected when the sha256 of a mailbox address equals
 * the confirmation's `address_hash`, the same hash the claim compares.
 */
export async function onboardingProgress(
  scope: Scope,
  now: Date = new Date(),
): Promise<OnboardingProgress> {
  const since = new Date(now.getTime() - CONFIRMATION_WINDOW_DAYS * 86_400_000)
  const rows = rowsOf<{ asked: number; pending: number; boxes: number }>(
    await scope.tx.execute(sql`
      select
        count(distinct c.address_hash)::int as asked,
        (count(distinct c.address_hash) filter (where not exists (
          select 1 from mailbox m
          where m.user_id = c.user_id
            and encode(sha256(convert_to(m.address, 'UTF8')), 'hex') = c.address_hash
        )))::int as pending,
        (select count(*)::int from mailbox where user_id = ${scope.userId}) as boxes
      from forwarding_confirmation c
      where c.user_id = ${scope.userId} and c.received_at > ${since.toISOString()}::timestamptz`),
  )
  const row = rows[0]
  return {
    pending: row?.pending ?? 0,
    hasConfirmation: (row?.asked ?? 0) > 0,
    hasMailbox: (row?.boxes ?? 0) > 0,
    mail: await firstMailProgress(scope),
  }
}
