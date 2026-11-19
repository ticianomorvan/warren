import { createHash } from 'node:crypto'
import type { ForwardingConfirmation, ForwardingConfirmations } from '@warren/core'
import { desc, eq, gt, sql } from 'drizzle-orm'
import { rowsOf, type Scope } from './client'
import { forwardingConfirmation, mailbox } from './schema'

// Sealed: the address and the link. The scope adds the user; this names the table, row and column.
const aad = (hash: string, receivedAt: Date) =>
  `forwarding_confirmation:${hash}:${receivedAt.toISOString()}:data`

/** How long a confirmation counts toward a claim. The same 7 days as `claim_mailbox` (0013). */
export const CONFIRMATION_DAYS = 7

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

/** The newest confirmation received in the last 7 days, opened, or null. For the page. */
export async function latestConfirmation(
  scope: Scope,
  now: Date = new Date(),
): Promise<(ForwardingConfirmation & { receivedAt: Date }) | null> {
  const since = new Date(now.getTime() - CONFIRMATION_DAYS * 86_400_000)
  const row = (
    await scope.tx
      .select()
      .from(forwardingConfirmation)
      .where(gt(forwardingConfirmation.receivedAt, since))
      .orderBy(desc(forwardingConfirmation.id))
      .limit(1)
  )[0]
  if (!row) return null
  const data = scope.json.open<ForwardingConfirmation>(
    row.data,
    aad(row.addressHash, row.receivedAt),
  )
  return { address: data.address, url: data.url, receivedAt: row.receivedAt }
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
