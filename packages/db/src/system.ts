import { sql } from 'drizzle-orm'
import { type Database, inSystemContext, rowsOf } from './client'
import { mailbox, unroutedDelivery } from './schema'

/*
 * The few calls that run with no user, because their job is to find one. Everything else goes
 * through `asUser`. Keep this file small: each function is a hole in "no query without a user".
 */

/** The user who registered this address, or null. A `security definer` function reads the table. */
export async function userForMailbox(database: Database, address: string): Promise<string | null> {
  return inSystemContext(database, async (tx) => {
    const rows = rowsOf<{ id: string | null }>(
      await tx.execute(sql`select user_for_mailbox(${address}) as id`),
    )
    return rows[0]?.id ?? null
  })
}

/** The user a WhatsApp message id belongs to. Serves the legacy Kapso webhook (slice 3 deletes it). */
export async function userForWamid(database: Database, wamid: string): Promise<string | null> {
  return inSystemContext(database, async (tx) => {
    const rows = rowsOf<{ id: string | null }>(
      await tx.execute(sql`select user_for_wamid(${wamid}) as id`),
    )
    return rows[0]?.id ?? null
  })
}

/** Notes a delivery nobody claimed. No content: only the provider's id and when it arrived. */
export async function recordUnrouted(
  database: Database,
  delivery: { provider: string; providerId: string; receivedAt: Date },
): Promise<void> {
  await inSystemContext(database, async (tx) => {
    await tx.insert(unroutedDelivery).values(delivery).onConflictDoNothing()
  })
}

/**
 * Registers a mailbox for a user. Operator only: it needs the owner role (pnpm mailbox:add).
 * An address already registered for another user is refused, never taken over.
 */
export async function addMailbox(
  database: Database,
  userId: string,
  address: string,
): Promise<void> {
  const lower = address.trim().toLowerCase()
  await inSystemContext(database, async (tx) => {
    const added = await tx
      .insert(mailbox)
      .values({ userId, address: lower })
      .onConflictDoNothing()
      .returning({ address: mailbox.address })
    if (added.length > 0) return
    const rows = rowsOf<{ id: string | null }>(
      await tx.execute(sql`select user_for_mailbox(${lower}) as id`),
    )
    if (rows[0]?.id !== userId) throw new Error('that address belongs to another user')
  })
}
