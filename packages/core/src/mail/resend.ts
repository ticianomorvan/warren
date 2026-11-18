import { createHmac, timingSafeEqual } from 'node:crypto'

/** Resend signs webhooks with Svix: HMAC-SHA256 over "<id>.<timestamp>.<body>". */
export type WebhookHeaders = {
  id: string | null
  timestamp: string | null
  signature: string | null
}

const TOLERANCE_SECONDS = 5 * 60

export function verifyResendWebhook(
  body: string,
  headers: WebhookHeaders,
  secret: string,
  now: Date = new Date(),
): boolean {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')
  if (key.length === 0) return false
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()
  // The header may carry several space-separated signatures: "v1,<base64> v1,<base64>"
  return signature.split(' ').some((part) => {
    const [version, value] = part.split(',')
    if (version !== 'v1' || !value) return false
    const given = Buffer.from(value, 'base64')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

export type ReceivedEvent = { emailId: string }

/** Returns null for any event other than a well-formed email.received. */
export function parseReceivedEvent(body: string): ReceivedEvent | null {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  const event = json as { type?: unknown; data?: { email_id?: unknown } }
  const emailId = event?.data?.email_id
  if (event?.type !== 'email.received' || typeof emailId !== 'string') return null
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(emailId)) return null
  return { emailId }
}

export const MAX_RAW_MAIL_BYTES = 25 * 1024 * 1024

export type ReceivedMail = { raw: Uint8Array; receivedAt: Date }

/** The webhook carries metadata only, so the raw file is fetched from Resend's API. */
export async function fetchReceivedMail(
  emailId: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<ReceivedMail> {
  const res = await fetchFn(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Resend API ${res.status} for received email`)
  const mail = (await res.json()) as { created_at?: string; raw?: { download_url?: string } | null }
  const url = mail.raw?.download_url
  if (!url?.startsWith('https://')) throw new Error('Resend API returned no raw download URL')
  const receivedAt = new Date(mail.created_at ?? '')
  if (Number.isNaN(receivedAt.getTime())) throw new Error('Resend API returned no created_at')

  const rawRes = await fetchFn(url, { signal: AbortSignal.timeout(30_000) })
  if (!rawRes.ok) throw new Error(`Raw mail download failed: ${rawRes.status}`)
  if (Number(rawRes.headers.get('content-length') ?? 0) > MAX_RAW_MAIL_BYTES) {
    throw new Error('Raw mail too large')
  }
  const raw = new Uint8Array(await rawRes.arrayBuffer())
  if (raw.byteLength === 0 || raw.byteLength > MAX_RAW_MAIL_BYTES) {
    throw new Error(`Raw mail size out of range: ${raw.byteLength}`)
  }
  return { raw, receivedAt }
}
