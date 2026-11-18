import { type Attempt, flushNotices, kapsoSender, type WhatsAppSender } from '@warren/core'
import { asUser, canonicalUserId, createOutbox, system } from '@warren/db'
import { database } from './db'
import { env } from './env'

let cached: WhatsAppSender | null | undefined

/** Null until Kapso is configured, so mail intake works without the WhatsApp channel. */
export function whatsAppSender(): WhatsAppSender | null {
  if (cached !== undefined) return cached
  const kapso = env.kapso()
  cached = kapso ? kapsoSender(kapso) : null
  return cached
}

/** How the Kapso status webhook finds a user from a message id, then reaches their outbox. */
export const kapsoLookup = () => ({
  userForWamid: (wamid: string) => system.userForWamid(database(), wamid),
  withOutbox: <T>(userId: string, fn: (outbox: ReturnType<typeof createOutbox>) => Promise<T>) =>
    asUser(database(), userId, (scope) => fn(createOutbox(scope))),
})

/**
 * Sends the notices still owed to `userId`, if they are the user the WhatsApp number belongs
 * to; anyone else's wait for push. The WhatsApp call is made between database transactions
 * (see `flushNotices`), never inside one. A failure here is logged and never fails the caller.
 */
export async function sendOwedNotices(userId: string): Promise<Attempt[]> {
  const sender = whatsAppSender()
  const kapso = env.kapso()
  if (!sender || !kapso || kapso.userId !== canonicalUserId(userId)) return []
  try {
    const attempts = await flushNotices(
      (fn) => asUser(database(), userId, (scope) => fn(createOutbox(scope))),
      sender,
    )
    for (const a of attempts) {
      if (a.outcome === 'failed') console.warn('notice not sent:', a.mode, a.errorCode)
    }
    return attempts
  } catch (error) {
    console.error('notices failed:', error instanceof Error ? error.message : 'unknown error')
    return []
  }
}
