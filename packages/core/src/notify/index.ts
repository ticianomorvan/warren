import {
  type DeliveryStatus,
  parseKapsoStatuses,
  type SendResult,
  verifyKapsoWebhook,
  type WhatsAppSender,
  WINDOW_CLOSED,
} from './kapso'
import type { PushPayload, PushResult, PushSender, PushSubscription } from './push'
import { type NoticeMovement, noticeOneLine, noticePushPayload, noticeText } from './text'

export * from './adapters/web-push'
export * from './kapso'
export * from './push'
export * from './text'

export type AttemptMode = 'text' | 'template' | 'push'

/** One past attempt at sending a notice, with any failure reported later by WhatsApp. */
export type AttemptRecord = {
  mode: AttemptMode
  failed: boolean
  errorCode: number | null
  retryable: boolean
  /** Push only: the subscription it went to. */
  subscriptionId?: string
}

export type WhatsAppAttempt = { mode: 'text' | 'template'; body: string } & SendResult
export type PushAttempt = { mode: 'push'; body: string; subscriptionId: string } & PushResult
export type Attempt = WhatsAppAttempt | PushAttempt

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
  /** Records a status for a message Warren sent. False when the message is not Warren's. */
  recordStatus(status: DeliveryStatus): Promise<boolean>
  /** The user's push subscriptions, opened. */
  subscriptions(): Promise<StoredSubscription[]>
  /** Deletes a subscription: the push service said it is gone. */
  dropSubscription(id: string): Promise<void>
}

/** Runs `fn` in one short transaction on one user's outbox. */
export type WithOutbox = <T>(fn: (outbox: Outbox) => Promise<T>) => Promise<T>

export const MAX_ATTEMPTS = 4

type WhatsAppRecord = AttemptRecord & { mode: 'text' | 'template' }

/** What to do next for a notice over WhatsApp, from its history alone. Push attempts do not count. */
export function planAttempt(
  allHistory: readonly AttemptRecord[],
  templateAvailable: boolean,
): 'text' | 'template' | 'done' | 'give-up' {
  const history = allHistory.filter((a): a is WhatsAppRecord => a.mode !== 'push')
  if (history.some((a) => !a.failed)) return 'done'
  if (history.length >= MAX_ATTEMPTS) return 'give-up'
  const last = history.at(-1)
  if (!last) return 'text'
  if (history.some((a) => a.errorCode === WINDOW_CLOSED)) {
    const templateRefused = history.some((a) => a.mode === 'template' && !a.retryable)
    return templateAvailable && !templateRefused ? 'template' : 'give-up'
  }
  return last.retryable ? last.mode : 'give-up'
}

/**
 * Whether to push a notice to one subscription, from the notice's history alone:
 * - a subscription that already got it, failed for good or used up its attempts is skipped;
 * - one that failed temporarily is tried again;
 * - one with no attempt yet gets the notice only while no subscription has received it, so a
 *   device added later does not replay what the person already saw on another.
 */
export function planPush(
  history: readonly AttemptRecord[],
  subscriptionId: string,
): 'send' | 'skip' {
  const pushes = history.filter((a) => a.mode === 'push')
  const mine = pushes.filter((a) => a.subscriptionId === subscriptionId)
  if (mine.some((a) => !a.failed) || mine.length >= MAX_ATTEMPTS) return 'skip'
  const last = mine.at(-1)
  if (!last) return pushes.some((a) => !a.failed) ? 'skip' : 'send'
  return last.retryable ? 'send' : 'skip'
}

/** Where a notice can go. A channel left out is not tried. */
export type Channels = { whatsapp?: WhatsAppSender; push?: PushSender }

/**
 * Sends every notice that is still owed. Safe to run at any time, from anywhere: what a notice
 * needs comes from its recorded history alone, so a second run after the first sends nothing.
 * Reads the owed notices in one transaction, sends outside any, and records each attempt in
 * its own, so a slow provider never holds the user's database lock (erasure waits on it).
 * Two runs at the very same moment can both send a notice; the second attempt is recorded too.
 * A push to a subscription the push service calls gone is recorded and the subscription deleted.
 */
export async function flushNotices(withOutbox: WithOutbox, channels: Channels): Promise<Attempt[]> {
  const { owed, subscriptions } = await withOutbox(async (outbox) => ({
    owed: await outbox.owed(),
    subscriptions: channels.push ? await outbox.subscriptions() : [],
  }))
  const made: Attempt[] = []
  for (const notice of owed) {
    if (channels.whatsapp) {
      made.push(...(await flushWhatsApp(withOutbox, channels.whatsapp, notice)))
    }
    if (channels.push) {
      made.push(...(await flushPush(withOutbox, channels.push, subscriptions, notice)))
    }
  }
  return made
}

async function flushPush(
  withOutbox: WithOutbox,
  sender: PushSender,
  subscriptions: readonly StoredSubscription[],
  notice: OpenNotice,
): Promise<PushAttempt[]> {
  const made: PushAttempt[] = []
  for (const { id, subscription } of subscriptions) {
    if (planPush(notice.history, id) === 'skip') continue
    const payload = noticePushPayload(notice.noticeId, notice.movement)
    const result = await sender.send(subscription, payload)
    const attempt: PushAttempt = {
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

async function flushWhatsApp(
  withOutbox: WithOutbox,
  sender: WhatsAppSender,
  notice: OpenNotice,
): Promise<WhatsAppAttempt[]> {
  const made: WhatsAppAttempt[] = []
  const hasTemplate = sender.sendTemplate !== undefined
  const plan = planAttempt(notice.history, hasTemplate)
  if (plan === 'done' || plan === 'give-up') return made
  const first = await attempt(sender, plan, notice.movement)
  await withOutbox((outbox) => outbox.recordAttempt(notice.noticeId, first))
  made.push(first)
  // A closed window moves on to the template at once, so the notice is not held until the
  // next mail arrives. Any other failure waits for the next run.
  const next = planAttempt([...notice.history, asRecord(first)], hasTemplate)
  if (first.mode === 'text' && next === 'template') {
    const second = await attempt(sender, 'template', notice.movement)
    await withOutbox((outbox) => outbox.recordAttempt(notice.noticeId, second))
    made.push(second)
  }
  return made
}

async function attempt(
  sender: WhatsAppSender,
  mode: 'text' | 'template',
  movement: NoticeMovement,
): Promise<WhatsAppAttempt> {
  if (mode === 'template' && sender.sendTemplate) {
    const body = noticeOneLine(movement)
    return { mode: 'template', body, ...(await sender.sendTemplate(body)) }
  }
  const body = noticeText(movement)
  return { mode: 'text', body, ...(await sender.sendText(body)) }
}

function asRecord(attempt: WhatsAppAttempt): AttemptRecord {
  return attempt.outcome === 'sent'
    ? { mode: attempt.mode, failed: false, errorCode: null, retryable: false }
    : {
        mode: attempt.mode,
        failed: true,
        errorCode: attempt.errorCode,
        retryable: attempt.retryable,
      }
}

/**
 * The legacy Kapso webhook (slice 3 deletes it). A status names only a WhatsApp message id, so
 * the user is found from it first (`userForWamid`), then their outbox is opened.
 */
export type KapsoWebhookDeps = {
  userForWamid(wamid: string): Promise<string | null>
  withOutbox<T>(userId: string, fn: (outbox: Outbox) => Promise<T>): Promise<T>
  sender: WhatsAppSender
  /** The one user whose notices go to the WhatsApp number. Others are recorded, not resent. */
  senderUserId: string
  webhookSecret: string
}

/**
 * Handles one Kapso webhook call: records delivery statuses of Warren's own messages, and
 * after a failure sends again whatever is still owed (through the template, when the
 * 24-hour window was closed).
 */
export async function handleKapsoWebhook(
  deps: KapsoWebhookDeps,
  body: string,
  headers: { signature: string | null; event: string | null },
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!verifyKapsoWebhook(body, headers.signature, deps.webhookSecret)) {
    return { status: 401, body: { error: 'bad signature' } }
  }
  const statuses = parseKapsoStatuses(body, headers.event)
  let recorded = 0
  let failedForSender = false
  for (const status of statuses) {
    const userId = await deps.userForWamid(status.wamid)
    if (!userId) continue
    const known = await deps.withOutbox(userId, (outbox) => outbox.recordStatus(status))
    if (!known) continue
    recorded++
    failedForSender ||=
      status.status === 'failed' && userId.toLowerCase() === deps.senderUserId.toLowerCase()
  }
  const resent = failedForSender
    ? (
        await flushNotices((fn) => deps.withOutbox(deps.senderUserId, fn), {
          whatsapp: deps.sender,
        })
      ).length
    : 0
  return { status: 200, body: { recorded, resent } }
}
