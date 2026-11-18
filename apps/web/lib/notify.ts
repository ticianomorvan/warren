import { type Attempt, errorTag, flushNotices, type PushSender, webPushSender } from '@warren/core'
import { asUser, createOutbox } from '@warren/db'
import { database } from './db'
import { env } from './env'

let pushCached: PushSender | null | undefined

/** Null until the VAPID keys are set, so everything else works without push. */
export function pushSender(): PushSender | null {
  if (pushCached !== undefined) return pushCached
  const vapid = env.vapid()
  pushCached = vapid ? webPushSender(vapid) : null
  return pushCached
}

/** One user's outbox. */
export const withUserOutbox =
  (userId: string) =>
  <T>(fn: (outbox: ReturnType<typeof createOutbox>) => Promise<T>) =>
    asUser(database(), userId, (scope) => fn(createOutbox(scope)))

/**
 * Pushes the notices still owed to `userId` to every subscription they have. The calls are made
 * between database transactions (see `flushNotices`), never inside one. A failure here is logged
 * and never fails the caller. Logs only status codes: never a subscription, an endpoint or a
 * message.
 */
export async function sendOwedNotices(userId: string): Promise<Attempt[]> {
  try {
    // Inside the try: a bad setting must not turn a recorded mail into a 500 and a retry.
    const push = pushSender()
    if (!push) return []
    const attempts = await flushNotices(withUserOutbox(userId), push)
    for (const a of attempts) {
      if (a.outcome === 'failed') console.warn('notice not sent:', a.status)
    }
    return attempts
  } catch (error) {
    console.error('notices failed:', errorTag(error))
    return []
  }
}
