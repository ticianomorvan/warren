/**
 * Web Push, as the notices see it. A browser hands the app a subscription (an endpoint on the
 * browser vendor's push service and two keys); sending is a small encrypted POST. The vendor
 * is behind this port: the hosted implementation is `adapters/web-push.ts`, the test one is
 * `memoryPushSender` below.
 */

/** What a browser's `PushSubscription.toJSON()` holds. Keys are base64url. */
export type PushSubscription = {
  /** A bearer capability URL: whoever has it can push to the person. Never logged. */
  endpoint: string
  /** The browser's public key, 65 bytes (uncompressed P-256 point). */
  p256dh: string
  /** The browser's 16-byte authentication secret. */
  auth: string
}

const B64URL = /^[A-Za-z0-9_-]+$/

/**
 * Reads a subscription a browser sent (`PushSubscription.toJSON()`), or null when it is not
 * one worth storing. The server will POST to this URL, so it must look like a push service
 * and not like something inside a network: https, no credentials, the default port, and a
 * host name (not an address, not `localhost`). The keys must have the shape of a P-256 point
 * and a 16-byte secret.
 */
export function parseSubscription(input: unknown): PushSubscription | null {
  if (typeof input !== 'object' || input === null) return null
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: Record<string, unknown> | null }
  const p256dh = keys?.p256dh
  const auth = keys?.auth
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return null
  if (typeof p256dh !== 'string' || !B64URL.test(p256dh)) return null
  if (typeof auth !== 'string' || !B64URL.test(auth)) return null
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(p256dh, 'base64url')[0] !== 4) {
    return null
  }
  if (Buffer.from(auth, 'base64url').length !== 16) return null
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  const host = url.hostname
  const isAddress = /^[\d.]+$/.test(host) || host.includes(':')
  const local = host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  if (isAddress || local) return null
  return { endpoint: url.href, p256dh, auth }
}

/** What the service worker shows. `tag` makes a repeat replace the earlier notification. */
export type PushPayload = { title: string; body: string; tag: string; url: string }

export type PushResult =
  | { outcome: 'sent' }
  /** 404 or 410: the subscription is dead and should be deleted. */
  | { outcome: 'gone'; status: number }
  | { outcome: 'failed'; retryable: boolean; status: number | null }

export interface PushSender {
  /** Never throws: a failure is a result. */
  send(subscription: PushSubscription, payload: PushPayload): Promise<PushResult>
}

/** Delivers to nobody: records what it was asked and answers from a script. For tests. */
export function memoryPushSender(
  answer: (subscription: PushSubscription) => PushResult = () => ({ outcome: 'sent' }),
): PushSender & { sent: { subscription: PushSubscription; payload: PushPayload }[] } {
  const sent: { subscription: PushSubscription; payload: PushPayload }[] = []
  return {
    sent,
    async send(subscription, payload) {
      sent.push({ subscription, payload })
      return answer(subscription)
    },
  }
}
