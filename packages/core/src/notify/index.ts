import type { PushPayload, PushResult, PushSender, PushSubscription } from './push'
import { type NoticeMovement, noticePushPayload, noticeText } from './text'

export * from './adapters/web-push'
export * from './push'
export * from './text'

/**
 * One past attempt at sending a notice. `legacy` is an attempt of the former WhatsApp notifier
 * (stored as `text` or `template`): nothing writes one any more, but old ones are in the history.
 */
export type AttemptRecord = {
  mode: 'push' | 'legacy'
  failed: boolean
  retryable: boolean
  /** Push only: the subscription it went to. */
  subscriptionId?: string
}

export type Attempt = { mode: 'push'; body: string; subscriptionId: string } & PushResult

export type OpenNotice = { noticeId: number; movement: NoticeMovement; history: AttemptRecord[] }

/** A subscription as the outbox holds it: opened, and named by a row id that is not a secret. */
export type StoredSubscription = { id: string; subscription: PushSubscription }

/**
 * The queue of one user's notices. Append-only: every attempt is a new row. Each call is one
 * short database transaction, so nothing here is open while a message is being sent.
 */
export interface Outbox {
  /** Recent notices, oldest first, each with what was already tried. Sent ones included. */
  owed(): Promise<OpenNotice[]>
  /** Records one attempt at a notice. */
  recordAttempt(noticeId: number, attempt: Attempt): Promise<void>
  /** The user's push subscriptions, opened. */
  subscriptions(): Promise<StoredSubscription[]>
  /** Deletes a subscription: the push service said it is gone. */
  dropSubscription(id: string): Promise<void>
}

/** Runs `fn` in one short transaction on one user's outbox. */
export type WithOutbox = <T>(fn: (outbox: Outbox) => Promise<T>) => Promise<T>

export const MAX_ATTEMPTS = 4

/**
 * Whether to push a notice to one subscription, from the notice's history alone:
 * - a notice with any legacy attempt is finished: the former notifier sent it or closed it on
 *   purpose, and a new subscription must not replay it;
 * - a subscription that already got it, failed for good or used up its attempts is skipped;
 * - one that failed temporarily is tried again;
 * - one with no attempt yet gets the notice only while no subscription has received it, so a
 *   device added later does not replay what the person already saw on another.
 */
export function planPush(
  history: readonly AttemptRecord[],
  subscriptionId: string,
): 'send' | 'skip' {
  if (history.some((a) => a.mode === 'legacy')) return 'skip'
  const pushes = history.filter((a) => a.mode === 'push')
  const mine = pushes.filter((a) => a.subscriptionId === subscriptionId)
  if (mine.some((a) => !a.failed) || mine.length >= MAX_ATTEMPTS) return 'skip'
  const last = mine.at(-1)
  if (!last) return pushes.some((a) => !a.failed) ? 'skip' : 'send'
  return last.retryable ? 'send' : 'skip'
}

/**
 * Sends every notice that is still owed. Safe to run at any time, from anywhere: what a notice
 * needs comes from its recorded history alone, so a second run after the first sends nothing.
 * Reads the owed notices in one transaction, sends outside any, and records each attempt in
 * its own, so a slow provider never holds the user's database lock (erasure waits on it).
 * Two runs at the very same moment can both send a notice; the second attempt is recorded too.
 * A push to a subscription the push service calls gone is recorded and the subscription deleted.
 */
export async function flushNotices(withOutbox: WithOutbox, sender: PushSender): Promise<Attempt[]> {
  const { owed, subscriptions } = await withOutbox(async (outbox) => ({
    owed: await outbox.owed(),
    subscriptions: await outbox.subscriptions(),
  }))
  const made: Attempt[] = []
  for (const notice of owed) {
    made.push(...(await flushPush(withOutbox, sender, subscriptions, notice)))
  }
  return made
}

async function flushPush(
  withOutbox: WithOutbox,
  sender: PushSender,
  subscriptions: readonly StoredSubscription[],
  notice: OpenNotice,
): Promise<Attempt[]> {
  const made: Attempt[] = []
  for (const { id, subscription } of subscriptions) {
    if (planPush(notice.history, id) === 'skip') continue
    const payload = noticePushPayload(notice.noticeId, notice.movement)
    const result = await sender.send(subscription, payload)
    const attempt: Attempt = {
      mode: 'push',
      body: noticeText(notice.movement),
      subscriptionId: id,
      ...result,
    }
    await withOutbox(async (outbox) => {
      await outbox.recordAttempt(notice.noticeId, attempt)
      if (result.outcome === 'gone') await outbox.dropSubscription(id)
    })
    made.push(attempt)
  }
  return made
}

/**
 * Sends a test message to every subscription of the user, so they can see it arrive. Nothing
 * is recorded as an attempt (there is no notice); a subscription that is gone is deleted.
 */
export async function sendTestPush(
  withOutbox: WithOutbox,
  sender: PushSender,
  payload: PushPayload,
): Promise<{ sent: number; gone: number; failed: number }> {
  const subscriptions = await withOutbox((outbox) => outbox.subscriptions())
  const count = { sent: 0, gone: 0, failed: 0 }
  for (const { id, subscription } of subscriptions) {
    const result = await sender.send(subscription, payload)
    if (result.outcome === 'sent') count.sent++
    else if (result.outcome === 'failed') count.failed++
    else {
      count.gone++
      await withOutbox((outbox) => outbox.dropSubscription(id))
    }
  }
  return count
}
