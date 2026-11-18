import {
  type DeliveryStatus,
  parseKapsoStatuses,
  type SendResult,
  verifyKapsoWebhook,
  type WhatsAppSender,
  WINDOW_CLOSED,
} from './kapso'
import { type NoticeMovement, noticeOneLine, noticeText } from './text'

export * from './kapso'
export * from './text'

export type AttemptMode = 'text' | 'template'

/** One past attempt at sending a notice, with any failure reported later by WhatsApp. */
export type AttemptRecord = {
  mode: AttemptMode
  failed: boolean
  errorCode: number | null
  retryable: boolean
}

export type Attempt = { mode: AttemptMode; body: string } & SendResult

export type OpenNotice = { noticeId: number; movement: NoticeMovement; history: AttemptRecord[] }

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
}

/** Runs `fn` in one short transaction on one user's outbox. */
export type WithOutbox = <T>(fn: (outbox: Outbox) => Promise<T>) => Promise<T>

export const MAX_ATTEMPTS = 4

/** What to do next for a notice, from its history alone. */
export function planAttempt(
  history: readonly AttemptRecord[],
  templateAvailable: boolean,
): AttemptMode | 'done' | 'give-up' {
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
 * Sends every notice that is still owed. Safe to run at any time, from anywhere: what a notice
 * needs comes from its recorded history alone, so a second run after the first sends nothing.
 * Reads the owed notices in one transaction, sends outside any, and records each attempt in
 * its own, so a slow provider never holds the user's database lock (erasure waits on it).
 * Two runs at the very same moment can both send a notice; the second attempt is recorded too.
 */
export async function flushNotices(
  withOutbox: WithOutbox,
  sender: WhatsAppSender,
): Promise<Attempt[]> {
  const owed = await withOutbox((outbox) => outbox.owed())
  const made: Attempt[] = []
  for (const notice of owed) {
    const plan = planAttempt(notice.history, sender.sendTemplate !== undefined)
    if (plan === 'done' || plan === 'give-up') continue
    let attempt: Attempt
    if (plan === 'template' && sender.sendTemplate) {
      const body = noticeOneLine(notice.movement)
      attempt = { mode: 'template', body, ...(await sender.sendTemplate(body)) }
    } else {
      const body = noticeText(notice.movement)
      attempt = { mode: 'text', body, ...(await sender.sendText(body)) }
    }
    await withOutbox((outbox) => outbox.recordAttempt(notice.noticeId, attempt))
    made.push(attempt)
  }
  return made
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
    ? (await flushNotices((fn) => deps.withOutbox(deps.senderUserId, fn), deps.sender)).length
    : 0
  return { status: 200, body: { recorded, resent } }
}
