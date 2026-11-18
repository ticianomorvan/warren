import { sql } from 'drizzle-orm'
import { canonicalUserId, type Database, inSystemContext, rowsOf, type Tx } from './client'
import { mailbox, unroutedDelivery } from './schema'

/*
 * The few calls that run with no user, because their job is to find one. Everything else goes
 * through `asUser`. Keep this file small: each function is a hole in "no query without a user".
 */

type LookupFunction = 'user_for_mailbox' | 'user_for_wamid'

/** Calls one of the two `security definer` lookups, which return a user id or null. */
async function lookup(tx: Tx, fn: LookupFunction, key: string): Promise<string | null> {
  const rows = rowsOf<{ id: string | null }>(
    await tx.execute(sql`select ${sql.identifier(fn)}(${key}) as id`),
  )
  return rows[0]?.id ?? null
}

/** The user who registered this address, or null. A `security definer` function reads the table. */
export async function userForMailbox(database: Database, address: string): Promise<string | null> {
  return inSystemContext(database, (tx) => lookup(tx, 'user_for_mailbox', address))
}

/**
 * The user a WhatsApp message id belongs to. This is the whole of the legacy Kapso shim: the
 * status webhook names only a message id, so a user is found from it before anything else.
 * Slice 3 deletes it, with its SQL function.
 */
export async function userForWamid(database: Database, wamid: string): Promise<string | null> {
  return inSystemContext(database, (tx) => lookup(tx, 'user_for_wamid', wamid))
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
export async function addMailbox(database: Database, id: string, address: string): Promise<void> {
  const userId = canonicalUserId(id)
  const lower = address.trim().toLowerCase()
  await inSystemContext(database, async (tx) => {
    const added = await tx
      .insert(mailbox)
      .values({ userId, address: lower })
      .onConflictDoNothing()
      .returning({ address: mailbox.address })
    if (added.length > 0) return
    if ((await lookup(tx, 'user_for_mailbox', lower)) !== userId) {
      throw new Error('that address belongs to another user')
    }
  })
}

/**
 * Deliveries that arrived while no user claimed them, and still have no recorded delivery
 * under any user: what `pnpm mail:replay-unrouted` runs through intake. Operator only: it
 * reads two tables the app role cannot, and needs the owner role.
 */
export async function pendingUnrouted(
  database: Database,
): Promise<{ provider: string; providerId: string; receivedAt: Date }[]> {
  return inSystemContext(database, async (tx) =>
    rowsOf<{ provider: string; provider_id: string; received_at: Date | string }>(
      await tx.execute(sql`
        select u.provider, u.provider_id, u.received_at
        from unrouted_delivery u
        where not exists (select 1 from mail_delivery d
                          where d.provider = u.provider and d.provider_id = u.provider_id)
        order by u.received_at, u.provider_id`),
    ).map((r) => ({
      provider: r.provider,
      providerId: r.provider_id,
      receivedAt: new Date(r.received_at),
    })),
  )
}
