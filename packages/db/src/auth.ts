import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { canonicalUserId, type Database, inSystemContext } from './client'
import { authAccount, session, user, verification } from './schema'

/**
 * What Better Auth sees of the database: its four tables, and nothing else. The key of the
 * renamed `account` table is the model name Better Auth is configured with (`auth_account`).
 * Connect it with the `warren_auth` URL: that role has grants on these tables only.
 */
export const authSchema = { user, session, auth_account: authAccount, verification }

export function createAuthDatabase(pool: Pool) {
  return drizzle(pool, { schema: authSchema })
}

/**
 * Gives a user a password, or replaces theirs, and ends their sessions. For the operator, until
 * a reset mail exists (slice 6): `hash` comes from Better Auth's own hasher, never the password.
 * Run it on a connection as `warren_auth`. Returns false when there is no such user.
 */
export async function setCredentialPassword(
  auth: Database,
  id: string,
  hash: string,
): Promise<boolean> {
  const userId = canonicalUserId(id)
  return inSystemContext(auth, async (tx) => {
    const found = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId))
    if (found.length === 0) return false
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
    return true
  })
}
