import type { RawStore, Tenancy, UserContext } from '@warren/core'
import { eq } from 'drizzle-orm'
import { asUser, type Database, type Scope } from './client'
import { createForwardingConfirmations } from './forwarding'
import { createLedger } from './ledger'
import { createMailLog } from './mail-log'
import { mailbox } from './schema'
import * as system from './system'

/**
 * A store for one user over a shared one: seals what it writes and opens what it reads, with
 * the user's key. The pathname is part of the associated data, so a file copied to another
 * path, or another user's prefix, does not open.
 */
export function sealedStore(inner: RawStore, scope: Scope): RawStore {
  const aad = (pathname: string) => `blob:${pathname}`
  return {
    put: (pathname, bytes) =>
      inner.put(pathname, scope.seal(bytes, aad(pathname)), 'application/octet-stream'),
    async get(pathname) {
      const sealed = await inner.get(pathname)
      return sealed ? scope.open(sealed, aad(pathname)) : null
    },
    deletePrefix: (prefix) => inner.deletePrefix(prefix),
  }
}

/** Everything mail intake may touch for the scope's user. */
export async function userContext(scope: Scope, files: RawStore): Promise<UserContext> {
  const rows = await scope.tx
    .select({ address: mailbox.address })
    .from(mailbox)
    .where(eq(mailbox.userId, scope.userId))
  return {
    userId: scope.userId,
    store: sealedStore(files, scope),
    log: createMailLog(scope),
    confirmations: createForwardingConfirmations(scope),
    ledger: createLedger(scope),
    mailboxes: rows.map((r) => r.address),
    mailId: scope.mailId,
  }
}

/** Intake's door to the database: find the user, then act as them. */
export function createTenancy(database: Database, files: RawStore): Tenancy {
  return {
    userForInboundAddress: (token) => system.userForInboundAddress(database, token),
    userForMailbox: (address) => system.userForMailbox(database, address),
    recordUnrouted: (delivery) => system.recordUnrouted(database, delivery),
    withUser: (userId, fn) =>
      asUser(database, userId, async (scope) => fn(await userContext(scope, files))),
  }
}
