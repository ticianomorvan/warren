import type { PushSubscription, StoredSubscription } from '@warren/core'
import { asc, eq, sql } from 'drizzle-orm'
import type { Scope } from './client'
import { pushSubscription } from './schema'

// Sealed: where to push and the keys to do it. The id names the row; the scope adds the user.
const aad = (id: string, column: 'endpoint' | 'p256dh' | 'auth') =>
  `push_subscription:${id}:${column}`

/** Browsers one user may subscribe from. */
export const MAX_SUBSCRIPTIONS = 10

/** One user's push subscriptions: browsers that may be told about a notice. */
export function createPushStore(scope: Scope) {
  const { tx } = scope
  const mine = (endpoint: string) => eq(pushSubscription.endpointKey, scope.endpointKey(endpoint))
  return {
    /**
     * Adds a subscription. `exists` when this browser is already stored with the same keys (a
     * no-op); `limit` when the user already has `MAX_SUBSCRIPTIONS` other browsers. A browser
     * stored with different keys is replaced: deleted, then added (there is no update grant).
     * Two adds at the very same moment can pass the limit by one.
     */
    async add(subscription: PushSubscription): Promise<'added' | 'exists' | 'limit'> {
      const key = scope.endpointKey(subscription.endpoint)
      const found = (
        await tx.select().from(pushSubscription).where(eq(pushSubscription.endpointKey, key))
      )[0]
      if (found) {
        const same =
          scope.open(found.p256dh, aad(found.id, 'p256dh')).toString('utf8') ===
            subscription.p256dh &&
          scope.open(found.auth, aad(found.id, 'auth')).toString('utf8') === subscription.auth
        if (same) return 'exists'
        await tx.delete(pushSubscription).where(eq(pushSubscription.id, found.id))
      } else if ((await this.count()) >= MAX_SUBSCRIPTIONS) {
        return 'limit'
      }
      const id = crypto.randomUUID()
      await tx.insert(pushSubscription).values({
        id,
        endpointKey: key,
        endpoint: scope.seal(subscription.endpoint, aad(id, 'endpoint')),
        p256dh: scope.seal(subscription.p256dh, aad(id, 'p256dh')),
        auth: scope.seal(subscription.auth, aad(id, 'auth')),
      })
      return 'added'
    },

    /** Deletes the subscription of one browser. True when there was one. */
    async remove(endpoint: string): Promise<boolean> {
      const rows = await tx
        .delete(pushSubscription)
        .where(mine(endpoint))
        .returning({ id: pushSubscription.id })
      return rows.length > 0
    },

    /** Whether this browser is subscribed, without opening anything. */
    async has(endpoint: string): Promise<boolean> {
      const rows = await tx
        .select({ id: pushSubscription.id })
        .from(pushSubscription)
        .where(mine(endpoint))
        .limit(1)
      return rows.length > 0
    },

    async count(): Promise<number> {
      const rows = await tx.select({ n: sql<number>`count(*)::int` }).from(pushSubscription)
      return rows[0]?.n ?? 0
    },

    /** All of the user's subscriptions, opened, oldest first. */
    async list(): Promise<StoredSubscription[]> {
      const rows = await tx.select().from(pushSubscription).orderBy(asc(pushSubscription.createdAt))
      const text = (value: Uint8Array, id: string, column: 'endpoint' | 'p256dh' | 'auth') =>
        scope.open(value, aad(id, column)).toString('utf8')
      return rows.map((r) => ({
        id: r.id,
        subscription: {
          endpoint: text(r.endpoint, r.id, 'endpoint'),
          p256dh: text(r.p256dh, r.id, 'p256dh'),
          auth: text(r.auth, r.id, 'auth'),
        },
      }))
    },

    /** Deletes one subscription by id: the push service said it is gone. */
    async drop(id: string): Promise<void> {
      await tx.delete(pushSubscription).where(eq(pushSubscription.id, id))
    },
  }
}
