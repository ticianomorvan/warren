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
 * The push services browsers use. The server POSTs to whatever endpoint a person hands it, so
 * only these hosts are accepted, never a heuristic about what looks internal: a name can point
 * anywhere (`127.0.0.1.nip.io`), and a new vendor is one line here. Checked when a subscription
 * is stored and again before every send.
 */
const PUSH_HOST_SUFFIXES = [
  '.push.services.mozilla.com', // Firefox: updates.push.services.mozilla.com
  '.push.apple.com', // Safari: web.push.apple.com
  '.notify.windows.com', // Edge, through WNS
  '.wns.windows.com',
]

export function isPushHost(hostname: string): boolean {
  // One trailing dot is the same name (`fcm.googleapis.com.`); two is not a name.
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'fcm.googleapis.com' || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/**
 * Whether an endpoint is one the server may POST to: https on the default port, no
 * credentials, and a host on the push-service allow-list.
 */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  return isPushHost(url.hostname)
}

/**
 * Reads a subscription a browser sent (`PushSubscription.toJSON()`), or null when it is not
 * one worth storing: an endpoint on a push service (`isPushEndpoint`), and keys with the shape
 * of a P-256 point and a 16-byte secret.
 */
export function parseSubscription(input: unknown): PushSubscription | null {
  if (typeof input !== 'object' || input === null) return null
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: Record<string, unknown> | null }
  const p256dh = keys?.p256dh
  const auth = keys?.auth
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return null
  if (typeof p256dh !== 'string' || !B64URL.test(p256dh)) return null
  if (typeof auth !== 'string' || !B64URL.test(auth)) return null
  const point = Buffer.from(p256dh, 'base64url')
  if (point.length !== 65 || point[0] !== 4) return null
  if (Buffer.from(auth, 'base64url').length !== 16) return null
  if (!isPushEndpoint(endpoint)) return null
  return { endpoint: new URL(endpoint).href, p256dh, auth }
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
