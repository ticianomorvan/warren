import { userFilesPrefix } from '@warren/core'
import { desc, eq } from 'drizzle-orm'
import { type Database, inUserContext } from './client'
import { erasure, event, mailbox, movement, movementSource, notice, userKey } from './schema'

export type ErasureReport = {
  /** The user's last chain link when they were erased, hex; null when they had no events. */
  chainHead: string | null
  files: number
  /** True when the user had been erased before: only the files were swept again. */
  alreadyErased: boolean
}

/**
 * Erases a user. Connect as `warren_eraser`: it may delete only the user's key, mailboxes,
 * movements, movement sources and notices, write the tombstone, and read the chain head.
 *
 * In one transaction it deletes those rows and writes `erasure(user_id, chain_head, erased_at)`.
 * After the commit it deletes the user's files. Everything append-only stays as ciphertext
 * nobody can open once the key is gone, and every chain, this user's included, still verifies.
 * Safe to run again if the file deletion failed.
 */
export async function eraseUser(
  database: Database,
  userId: string,
  files: { deletePrefix(prefix: string): Promise<number> },
): Promise<ErasureReport> {
  const report = await inUserContext(database, userId, async (tx) => {
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

    // Children before parents: notices and sources point at movements.
    await tx.delete(notice).where(eq(notice.userId, userId))
    await tx.delete(movementSource).where(eq(movementSource.userId, userId))
    await tx.delete(movement).where(eq(movement.userId, userId))
    await tx.delete(mailbox).where(eq(mailbox.userId, userId))
    await tx.delete(userKey).where(eq(userKey.userId, userId))
    await tx.insert(erasure).values({ userId, chainHead: head })
    return { chainHead: head ? Buffer.from(head).toString('hex') : null, alreadyErased: false }
  })
  return { ...report, files: await files.deletePrefix(userFilesPrefix(userId)) }
}
