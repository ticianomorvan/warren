import { userFilesPrefix } from '@warren/core'
import { desc, eq } from 'drizzle-orm'
import { type AuthErasure, eraseAuthUser } from './auth'
import {
  canonicalUserId,
  type Database,
  ERASURE_LOCK,
  inUserContext,
  lockUserExclusive,
} from './client'
import { erasure, event } from './schema'
import { ERASED_TABLES } from './tables'

export type ErasureReport = {
  /** The user's last chain link when they were erased, hex; null when they had no events. */
  chainHead: string | null
  files: number
  /** True when the user had been erased before: only the files were swept again. */
  alreadyErased: boolean
  /** What was removed from the sign-in side: sessions and credentials. */
  auth: AuthErasure
}

/** The two roles erasure needs: `eraser` for the ledger side, `auth` for sign-in. */
export type ErasureDatabases = { eraser: Database; auth: Database }

/**
 * Erases a user. First, as `warren_auth`, it ends the user's sessions and credentials and
 * scrubs their email and name (`eraseAuthUser`), so nobody can sign in as them while the rest
 * runs. Then, as `warren_eraser`, which may delete only the user's rows in
 * `ERASED_TABLES` (their key, mailboxes, accounts and identifiers, movements, sources and
 * notices), write the tombstone, and read the chain head.
 *
 * In one transaction it takes the erasure lock exclusively (so work in flight finishes first,
 * and work that starts later finds the tombstone), deletes those rows and writes
 * `erasure(user_id, chain_head, erased_at)`. After the commit it deletes the user's files.
 * Everything append-only stays as ciphertext nobody can open once the key is gone, and every
 * chain, this user's included, still verifies. Each step is safe to run again, so a run that
 * stopped halfway is finished by running it again.
 *
 * Files: an intake that was in flight can put a file after the sweep. Intake deletes that file
 * itself when it finds the user erased (`ensureStored`, best effort). If even that failed, run
 * this again: for an erased user it only repeats the sweep. So is it when the first sweep fails.
 */
export async function eraseUser(
  { eraser, auth }: ErasureDatabases,
  id: string,
  files: { deletePrefix(prefix: string): Promise<number> },
): Promise<ErasureReport> {
  const userId = canonicalUserId(id)
  const signIn = await eraseAuthUser(auth, userId)
  if (!signIn) throw new Error(`no user ${userId}`)
  const report = await inUserContext(eraser, userId, async (tx) => {
    await lockUserExclusive(tx, userId, ERASURE_LOCK)
    const done = await tx
      .select({ userId: erasure.userId })
      .from(erasure)
      .where(eq(erasure.userId, userId))
    if (done[0]) return { chainHead: null, alreadyErased: true }

    const last = await tx
      .select({ chain: event.chainSha256 })
      .from(event)
      .where(eq(event.userId, userId))
      .orderBy(desc(event.seq))
      .limit(1)
    const head = last[0]?.chain ?? null

    // The order of ERASED_TABLES is children before parents.
    for (const table of ERASED_TABLES) await tx.delete(table).where(eq(table.userId, userId))
    await tx.insert(erasure).values({ userId, chainHead: head })
    return { chainHead: head ? Buffer.from(head).toString('hex') : null, alreadyErased: false }
  })
  return { ...report, auth: signIn, files: await files.deletePrefix(userFilesPrefix(userId)) }
}
