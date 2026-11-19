import { newInboundToken } from '@warren/core'
import { and, eq, isNull } from 'drizzle-orm'
import { lockUserExclusive, type Scope } from './client'
import { inboundAddress } from './schema'

/**
 * The advisory-lock purpose that puts one user's address changes in a line. Taken so far: 4200
 * erasure, 4201 the event chain trigger, 4202 the ledger, 4203 the profile, 4204 this.
 */
const INBOUND_ADDRESS_LOCK = 4204

// Row-level security already limits the rows to the user's; naming the user too keeps this right on a connection that bypasses it.
const activeOf = (scope: Scope) =>
  and(eq(inboundAddress.userId, scope.userId), isNull(inboundAddress.revokedAt))

/**
 * The user's active inbound token, made on the first call. Two calls at the same moment take
 * turns on the per-user lock, so one row is made; the partial unique index on `user_id` where
 * `revoked_at` is null is the backstop. Core turns the token into an address (`inboundAddressOf`).
 */
export async function inboundAddressFor(scope: Scope): Promise<string> {
  await lockUserExclusive(scope.tx, scope.userId, INBOUND_ADDRESS_LOCK)
  const active = await scope.tx
    .select({ token: inboundAddress.token })
    .from(inboundAddress)
    .where(activeOf(scope))
  if (active[0]) return active[0].token
  const token = newInboundToken()
  await scope.tx.insert(inboundAddress).values({ token })
  return token
}

/** Revokes the active address, so mail to it routes nowhere. True when there was one. The next `inboundAddressFor` makes a new one. */
export async function revokeInboundAddress(scope: Scope): Promise<boolean> {
  await lockUserExclusive(scope.tx, scope.userId, INBOUND_ADDRESS_LOCK)
  const revoked = await scope.tx
    .update(inboundAddress)
    .set({ revokedAt: new Date() })
    .where(activeOf(scope))
    .returning({ token: inboundAddress.token })
  return revoked.length > 0
}
