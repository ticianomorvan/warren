import { createHmac, timingSafeEqual } from 'node:crypto'

/** Meta's code for "more than 24 hours since the recipient last wrote": only templates pass. */
export const WINDOW_CLOSED = 131047

export type SendResult =
  | { outcome: 'sent'; wamid: string }
  | { outcome: 'failed'; errorCode: number | null; retryable: boolean; detail: string }

export interface WhatsAppSender {
  sendText(body: string): Promise<SendResult>
  /** Present when an approved template is configured; it works outside the 24-hour window. */
  sendTemplate?: (parameter: string) => Promise<SendResult>
}

export type KapsoConfig = {
  apiKey: string
  phoneNumberId: string
  /** Recipient, digits only. Warren writes to its owner and to nobody else. */
  to: string
  /** Approved template with one body variable, e.g. { name: 'movement_notice', language: 'es_AR' }. */
  template?: { name: string; language: string } | undefined
  fetchFn?: typeof fetch
}

const RETRYABLE_STATUS = new Set([409, 423, 429])

/** Sends through Kapso, which mirrors Meta's Cloud API. Never throws: a failure is a result. */
export function kapsoSender(config: KapsoConfig): WhatsAppSender {
  const fetchFn = config.fetchFn ?? fetch
  const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${config.phoneNumberId}/messages`

  async function send(message: Record<string, unknown>): Promise<SendResult> {
    let res: Response
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'X-API-Key': config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: config.to, ...message }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.name : 'network'
      return { outcome: 'failed', errorCode: null, retryable: true, detail }
    }
    const json = (await res.json().catch(() => null)) as {
      messages?: { id?: unknown }[]
      error?: { code?: unknown; message?: unknown }
    } | null
    if (res.ok) {
      const wamid = json?.messages?.[0]?.id
      if (typeof wamid === 'string' && wamid) return { outcome: 'sent', wamid }
      // Probably delivered, so it must not be sent again.
      return { outcome: 'failed', errorCode: null, retryable: false, detail: 'no-message-id' }
    }
    const code = typeof json?.error?.code === 'number' ? json.error.code : null
    const reason = typeof json?.error?.message === 'string' ? json.error.message : ''
    return {
      outcome: 'failed',
      errorCode: code,
      retryable: res.status >= 500 || RETRYABLE_STATUS.has(res.status),
      detail: `http-${res.status}${reason ? `: ${reason.slice(0, 200)}` : ''}`,
    }
  }

  const template = config.template
  return {
    sendText: (body) => send({ type: 'text', text: { body, preview_url: false } }),
    ...(template
      ? {
          sendTemplate: (parameter: string) =>
            send({
              type: 'template',
              template: {
                name: template.name,
                language: { code: template.language },
                components: [{ type: 'body', parameters: [{ type: 'text', text: parameter }] }],
              },
            }),
        }
      : {}),
  }
}

/** Kapso signs the raw body with HMAC-SHA256 and sends it as hex in X-Webhook-Signature. */
export function verifyKapsoWebhook(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !secret || !/^[0-9a-f]{64}$/i.test(signature)) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected)
}

export type DeliveryStatus = {
  wamid: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  errorCode: number | null
  occurredAt: Date
}

const STATUS_EVENTS: Record<string, DeliveryStatus['status']> = {
  'whatsapp.message.sent': 'sent',
  'whatsapp.message.delivered': 'delivered',
  'whatsapp.message.read': 'read',
  'whatsapp.message.failed': 'failed',
}

type MetaStatus = { status?: unknown; timestamp?: unknown; errors?: { code?: unknown }[] }
type KapsoMessageEvent = {
  message?: { id?: unknown; timestamp?: unknown; kapso?: { statuses?: MetaStatus[] } }
}

/** Reads delivery statuses out of a Kapso webhook body. Other events give an empty list. */
export function parseKapsoStatuses(body: string, eventName: string | null): DeliveryStatus[] {
  const status = eventName ? STATUS_EVENTS[eventName] : undefined
  if (!status) return []
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return []
  }
  const batch = json as { batch?: unknown; data?: unknown }
  const items = (batch?.batch === true && Array.isArray(batch.data) ? batch.data : [json]) as
    | KapsoMessageEvent[]
    | null[]
  const out: DeliveryStatus[] = []
  for (const item of items) {
    const wamid = item?.message?.id
    if (typeof wamid !== 'string' || !wamid || wamid.length > 256) continue
    const entry = item?.message?.kapso?.statuses?.findLast?.((s) => s?.status === status)
    const seconds = Number(entry?.timestamp ?? item?.message?.timestamp)
    const code = entry?.errors?.[0]?.code
    out.push({
      wamid,
      status,
      errorCode: typeof code === 'number' ? code : null,
      occurredAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(),
    })
  }
  return out
}
