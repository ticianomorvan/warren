import { and, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { canonicalUserId, type Database, inSystemContext } from './client'
import { authAccount, rateLimit, session, user, verification } from './schema'

/**
 * What Better Auth sees of the database: its tables, and nothing else. The keys of the renamed
 * `account` and `rateLimit` tables are the model names Better Auth is configured with
 * (`auth_account`, `rate_limit`). Connect it with the `warren_auth` URL: that role has grants on
 * these tables only.
 */
export const authSchema = {
  user,
  session,
  auth_account: authAccount,
  verification,
  rate_limit: rateLimit,
}

export function createAuthDatabase(pool: Pool) {
  return drizzle(pool, { schema: authSchema })
}

export type SetPasswordResult = 'set' | 'no-user' | 'erased'

/**
 * Gives a user a password, or replaces theirs, and ends their sessions. For the operator, until
 * a reset mail exists (slice 6): `hash` comes from Better Auth's own hasher, never the password.
 * Run it on a connection as `warren_auth`. An erased user gets none: their credentials are gone
 * for good, and a new one would let them sign in again.
 */
export async function setCredentialPassword(
  auth: Database,
  id: string,
  hash: string,
): Promise<SetPasswordResult> {
  const userId = canonicalUserId(id)
  return inSystemContext(auth, async (tx) => {
    // The row lock orders this against an erasure in flight: it waits, then sees the result.
    const found = await tx
      .select({ erasedAt: user.erasedAt })
      .from(user)
      .where(eq(user.id, userId))
      .for('update')
    if (!found[0]) return 'no-user'
    if (found[0].erasedAt) return 'erased'
    const credential = and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential'))
    const updated = await tx
      .update(authAccount)
      .set({ password: hash })
      .where(credential)
      .returning({ id: authAccount.id })
    if (updated.length === 0) {
      await tx
        .insert(authAccount)
        .values({ userId, providerId: 'credential', accountId: userId, password: hash })
    }
    await tx.delete(session).where(eq(session.userId, userId))
    return 'set'
  })
}

export type AuthErasure = { sessions: number; accounts: number }

/**
 * The auth side of erasing a user, as `warren_auth`: deletes their sessions, their credentials
 * and any pending verification for their email, marks the user row erased, and scrubs its
 * email, name and image. The row itself stays, because every `user_id` points at it; its email
 * becomes `erased+<id>@invalid` so the unique constraint holds and the address is free again.
 * Safe to run again. Returns null when there is no such user.
 *
 * The row is locked and updated first, and the sessions deleted after: with the trigger in
 * migration 0006 a sign-in racing with this either never gets a session or has it deleted here.
 */
export async function eraseAuthUser(auth: Database, id: string): Promise<AuthErasure | null> {
  const userId = canonicalUserId(id)
  return inSystemContext(auth, async (tx) => {
    const found = await tx
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .for('update')
    if (!found[0]) return null
    await tx
      .update(user)
      .set({
        erasedAt: sql`coalesce(${user.erasedAt}, now())`,
        email: `erased+${userId}@invalid`,
        name: 'erased',
        image: null,
        emailVerified: false,
      })
      .where(eq(user.id, userId))
    const sessions = await tx
      .delete(session)
      .where(eq(session.userId, userId))
      .returning({ id: session.id })
    const accounts = await tx
      .delete(authAccount)
      .where(eq(authAccount.userId, userId))
      .returning({ id: authAccount.id })
    // Better Auth keys a verification by the email, as given or lower-cased.
    const email = found[0].email
    await tx
      .delete(verification)
      .where(inArray(verification.identifier, [email, email.toLowerCase()]))
    return { sessions: sessions.length, accounts: accounts.length }
  })
}

/** A user's name and email, as `warren_auth`; null for a user that does not exist or is erased. */
export async function userIdentity(
  auth: Database,
  id: string,
): Promise<{ name: string; email: string } | null> {
  const userId = canonicalUserId(id)
  return inSystemContext(auth, async (tx) => {
    const rows = await tx
      .select({ name: user.name, email: user.email, erasedAt: user.erasedAt })
      .from(user)
      .where(eq(user.id, userId))
    const row = rows[0]
    return row && !row.erasedAt ? { name: row.name, email: row.email } : null
  })
}

/**
 * A fixed-window limit on one action, kept in `rate_limit` (the table Better Auth's limiter
 * uses; run as `warren_auth`). True while the key has made at most `max` calls in the last
 * `windowMs`; every call counts, allowed or not. The key must not be a user id: that table
 * holds none and erasure does not look in it, so callers pass a hash.
 */
export async function allowAction(
  auth: Database,
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  const rows = await inSystemContext(auth, (tx) =>
    tx
      .insert(rateLimit)
      .values({ key, count: 1, lastRequest: now })
      .onConflictDoUpdate({
        target: rateLimit.key,
        set: {
          count: sql`case when ${rateLimit.lastRequest} <= ${now - windowMs} then 1 else ${rateLimit.count} + 1 end`,
          lastRequest: sql`case when ${rateLimit.lastRequest} <= ${now - windowMs} then ${now} else ${rateLimit.lastRequest} end`,
        },
      })
      .returning({ count: rateLimit.count }),
  )
  return (rows[0]?.count ?? max + 1) <= max
}
