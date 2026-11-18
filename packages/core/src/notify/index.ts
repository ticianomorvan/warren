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

/** The queue of notices owed to the owner. Append-only: every attempt is a new row. */
export interface Outbox {
  /**
   * Calls `handle` for each recent notice, oldest first, and records the attempt it returns.
   * Only one drain runs at a time, so a notice is never sent by two callers at once.
   */
  drain(handle: (notice: OpenNotice) => Promise<Attempt | null>): Promise<Attempt[]>
  /** Records a status for a message Warren sent. False when the message is not Warren's. */
  recordStatus(status: DeliveryStatus): Promise<boolean>
}

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

/** Sends every notice that is still owed. Safe to run at any time, from anywhere. */
export async function flushNotices(outbox: Outbox, sender: WhatsAppSender): Promise<Attempt[]> {
  return outbox.drain(async (notice) => {
    const plan = planAttempt(notice.history, sender.sendTemplate !== undefined)
    if (plan === 'done' || plan === 'give-up') return null
    if (plan === 'template' && sender.sendTemplate) {
      const body = noticeOneLine(notice.movement)
      return { mode: 'template', body, ...(await sender.sendTemplate(body)) }
    }
    const body = noticeText(notice.movement)
    return { mode: 'text', body, ...(await sender.sendText(body)) }
  })
}

export type KapsoWebhookDeps = { outbox: Outbox; sender: WhatsAppSender; webhookSecret: string }

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
  let failed = false
  for (const status of statuses) {
    if (!(await deps.outbox.recordStatus(status))) continue
    recorded++
    failed ||= status.status === 'failed'
  }
  const resent = failed ? (await flushNotices(deps.outbox, deps.sender)).length : 0
  return { status: 200, body: { recorded, resent } }
}
