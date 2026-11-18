import { createHash } from 'node:crypto'

/**
 * Deterministic event ids: the same source always yields the same id, so recording a mail
 * twice is a no-op at the database.
 */
export function eventId(kind: string, key: string): string {
  const h = createHash('sha256').update(`warren:${kind}:${key}`).digest('hex')
  const variant = ((Number.parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`
}
