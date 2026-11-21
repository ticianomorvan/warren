import { createHmac, timingSafeEqual } from 'node:crypto'

/** `X-Hub-Signature-256` is `sha256=` plus the HMAC-SHA256 of the raw body with the app secret. */
export function validSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice(7), 'hex')
  const expected = createHmac('sha256', secret).update(raw).digest()
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function sign(raw: Buffer | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
}
