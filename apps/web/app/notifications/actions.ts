'use server'

import { createHash } from 'node:crypto'
import { errorTag, parseSubscription, sendTestPush } from '@warren/core'
import { allowAction, asUser, createPushStore } from '@warren/db'
import { after } from 'next/server'
import { authDatabase } from '@/lib/auth'
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
  | {
      ok: false
      reason: 'signed-out' | 'invalid' | 'unavailable' | 'failed' | 'gone' | 'limit' | 'slow-down'
    }

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
    if (added === 'limit') return { ok: false, reason: 'limit' }
    // A purchase from the last 24 hours that arrived before they subscribed goes out now.
    if (added === 'added') after(() => sendOwedNotices(session.user.id))
    return { ok: true }
  } catch (error) {
    console.error('subscribe failed:', errorTag(error))
    return { ok: false, reason: 'failed' }
  }
}

export async function unsubscribePush(endpoint: unknown): Promise<PushActionResult> {
  const session = await getSession()
  if (!session) return { ok: false, reason: 'signed-out' }
  if (typeof endpoint !== 'string') return { ok: false, reason: 'invalid' }
  try {
    // Spelled as it was stored (see parseSubscription).
    const stored = new URL(endpoint).href
    await asUser(database(), session.user.id, (scope) => createPushStore(scope).remove(stored))
    return { ok: true }
  } catch (error) {
    console.error('unsubscribe failed:', errorTag(error))
    return { ok: false, reason: 'failed' }
  }
}

/** Whether the server holds a subscription for this browser, for the signed-in user. */
export async function hasPush(endpoint: unknown): Promise<boolean> {
  const session = await getSession()
  if (!session || typeof endpoint !== 'string') return false
  try {
    const stored = new URL(endpoint).href
    return await asUser(database(), session.user.id, (scope) => createPushStore(scope).has(stored))
  } catch {
    return false
  }
}

const TEST_PUSHES = 5
const TEST_WINDOW_MS = 10 * 60_000

/** Pushes a test message to every browser the person turned notifications on in. */
export async function testPush(): Promise<PushActionResult> {
  const session = await getSession()
  if (!session) return { ok: false, reason: 'signed-out' }
  try {
    const sender = pushSender()
    if (!sender) return { ok: false, reason: 'unavailable' }
    // A hash, not the id: the rate limit table holds no user ids.
    const key = `push-test:${createHash('sha256').update(session.user.id).digest('hex')}`
    if (!(await allowAction(authDatabase(), key, TEST_PUSHES, TEST_WINDOW_MS))) {
      return { ok: false, reason: 'slow-down' }
    }
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
