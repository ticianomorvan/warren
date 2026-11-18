import { type Attempt, flushNotices, kapsoSender, type WhatsAppSender } from '@warren/core'
import { createOutbox } from '@warren/db'
import { db } from './db'
import { env } from './env'

let cached: WhatsAppSender | null | undefined

/** Null until Kapso is configured, so mail intake works without the WhatsApp channel. */
export function whatsAppSender(): WhatsAppSender | null {
  if (cached !== undefined) return cached
  const kapso = env.kapso()
  cached = kapso ? kapsoSender(kapso) : null
  return cached
}

export const outbox = () => createOutbox(db())

/** Sends the notices still owed. A failure here is logged and never fails the caller. */
export async function sendOwedNotices(): Promise<Attempt[]> {
  const sender = whatsAppSender()
  if (!sender) return []
  try {
    const attempts = await flushNotices(outbox(), sender)
    for (const a of attempts) {
      if (a.outcome === 'failed') console.warn('notice not sent:', a.mode, a.errorCode, a.detail)
    }
    return attempts
  } catch (error) {
    console.error('notices failed:', error instanceof Error ? error.message : 'unknown error')
    return []
  }
}
