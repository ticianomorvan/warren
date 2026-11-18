'use server'

import { errorTag, parseSubscription, sendTestPush } from '@warren/core'
import { asUser, createPushStore } from '@warren/db'
import { after } from 'next/server'
import { database } from '@/lib/db'
import { pushSender, sendOwedNotices, withUserOutbox } from '@/lib/notify'
import { getSession } from '@/lib/session'
import { t } from '@/lib/strings'

/*
 * What the notifications card does on the server. Server Actions: Next checks the request's
 * Origin, so another site cannot submit them for a signed-in person. Each acts only for the
 * session's user, through `asUser`. Nothing here logs a subscription, an endpoint or a message.
 */

export type PushActionResult =
  | { ok: true; sent?: number }
  | { ok: false; reason: 'signed-out' | 'invalid' | 'unavailable' | 'failed' | 'gone' }

/** Stores this browser's subscription (again, harmlessly, if it was there) and flushes owed notices. */
export async function subscribePush(input: unknown): Promise<PushActionResult> {
  const session = await getSession()
  if (!session) return { ok: false, reason: 'signed-out' }
  const subscription = parseSubscription(input)
  if (!subscription) return { ok: false, reason: 'invalid' }
  try {
    const added = await asUser(database(), session.user.id, (scope) =>
      createPushStore(scope).add(subscription),
    )
    // A purchase from the last 24 hours that arrived before they subscribed goes out now.
    if (added) after(() => sendOwedNotices(session.user.id))
    return { ok: true }
  } catch (error) {
    console.error('subscribe failed:', errorTag(error))
    return { ok: false, reason: 'failed' }
  }
}

export async function unsubscribePush(endpoint: unknown): Promise<PushActionResult> {
  const session = await getSession()
  if (!session) return { ok: false, reason: 'signed-out' }
  // Parsed like a subscription, so the endpoint is spelled as it was stored.
  const parsed = typeof endpoint === 'string' ? new URL(endpoint, 'https://x.invalid').href : null
  if (!parsed) return { ok: false, reason: 'invalid' }
  try {
    await asUser(database(), session.user.id, (scope) => createPushStore(scope).remove(parsed))
    return { ok: true }
  } catch (error) {
    console.error('unsubscribe failed:', errorTag(error))
    return { ok: false, reason: 'failed' }
  }
}

/** Pushes a test message to every browser the person turned notifications on in. */
export async function testPush(): Promise<PushActionResult> {
  const session = await getSession()
  if (!session) return { ok: false, reason: 'signed-out' }
  const sender = pushSender()
  if (!sender) return { ok: false, reason: 'unavailable' }
  try {
    const counts = await sendTestPush(withUserOutbox(session.user.id), sender, {
      title: t.appName,
      body: t.notifications.testBody,
      tag: 'test',
      url: '/movements',
    })
    if (counts.sent > 0) return { ok: true, sent: counts.sent }
    return { ok: false, reason: counts.failed > 0 ? 'failed' : 'gone' }
  } catch (error) {
    console.error('test push failed:', errorTag(error))
    return { ok: false, reason: 'failed' }
  }
}
