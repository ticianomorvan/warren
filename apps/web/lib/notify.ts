import {
  type Attempt,
  type Channels,
  errorTag,
  flushNotices,
  kapsoSender,
  type PushSender,
  type WhatsAppSender,
  webPushSender,
} from '@warren/core'
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

let pushCached: PushSender | null | undefined

/** Null until the VAPID keys are set, so everything else works without push. */
export function pushSender(): PushSender | null {
  if (pushCached !== undefined) return pushCached
  const vapid = env.vapid()
  pushCached = vapid ? webPushSender(vapid) : null
  return pushCached
}

/** How the Kapso status webhook finds a user from a message id, then reaches their outbox. */
export const kapsoLookup = () => ({
  userForWamid: (wamid: string) => system.userForWamid(database(), wamid),
  withOutbox: <T>(userId: string, fn: (outbox: ReturnType<typeof createOutbox>) => Promise<T>) =>
    asUser(database(), userId, (scope) => fn(createOutbox(scope))),
})

/** One user's outbox, for the push helpers. */
export const withUserOutbox =
  (userId: string) =>
  <T>(fn: (outbox: ReturnType<typeof createOutbox>) => Promise<T>) =>
    asUser(database(), userId, (scope) => fn(createOutbox(scope)))

/**
 * Sends the notices still owed to `userId`: by push to every subscription they have, and over
 * WhatsApp if they are the user the WhatsApp number belongs to (slice 3 removes that). The
 * calls are made between database transactions (see `flushNotices`), never inside one. A
 * failure here is logged and never fails the caller. Logs only modes and status codes: never a
 * subscription, an endpoint or a message.
 */
export async function sendOwedNotices(userId: string): Promise<Attempt[]> {
  try {
    // Inside the try: a bad setting must not turn a recorded mail into a 500 and a retry.
    const channels: Channels = {}
    const kapso = env.kapso()
    const whatsapp = whatsAppSender()
    if (whatsapp && kapso && kapso.userId === canonicalUserId(userId)) {
      channels.whatsapp = whatsapp
    }
    const push = pushSender()
    if (push) channels.push = push
    if (!channels.whatsapp && !channels.push) return []
    const attempts = await flushNotices(withUserOutbox(userId), channels)
    for (const a of attempts) {
      if (a.outcome === 'failed') {
        console.warn('notice not sent:', a.mode, a.mode === 'push' ? a.status : a.errorCode)
      }
    }
    return attempts
  } catch (error) {
    console.error('notices failed:', errorTag(error))
    return []
  }
}
