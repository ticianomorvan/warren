import { createHmac, timingSafeEqual } from 'node:crypto'

/** Constant-time equality that is also safe for inputs of different lengths. */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** `X-Hub-Signature-256` is `sha256=` plus the HMAC-SHA256 of the raw body with the app secret. */
export function validSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  const hex = header?.startsWith('sha256=') ? header.slice(7) : ''
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false
  return safeEqual(Buffer.from(hex, 'hex'), createHmac('sha256', secret).update(raw).digest())
}
