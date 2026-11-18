import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import type { PushPayload, PushResult, PushSender, PushSubscription } from '../push'

/*
 * Web Push written with node:crypto: RFC 8030 (the POST), RFC 8291 (aes128gcm message
 * encryption) and RFC 8292 (VAPID, ES256). About a hundred lines instead of a dependency on
 * the path that holds the VAPID private key. `web-push` is the fallback if a vector ever fails.
 */

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const fromB64u = (text: string) => Buffer.from(text, 'base64url')

/** Record size 4096, one record. A push service accepts at most 4096 bytes in all. */
const RECORD_SIZE = 4096
const HEADER_BYTES = 16 + 4 + 1 + 65
const TAG_BYTES = 16
/** What fits: the record, minus the header, the tag and the one delimiter octet. */
export const MAX_PLAINTEXT = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Buffer, length: number) =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

/** RFC 8291 section 3.3 and 3.4: the content key and nonce both sides derive. */
function contentKeys(
  shared: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
) {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(shared, authSecret, keyInfo, 32)
  return {
    cek: hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    nonce: hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  }
}

export type EncryptInput = {
  plaintext: Uint8Array
  /** The browser's `p256dh` and `auth`, base64url. */
  p256dh: string
  auth: string
  /** The sender's ephemeral key and the salt. Random unless a test fixes them. */
  ephemeral?: { privateKey: Uint8Array; publicKey: Uint8Array }
  salt?: Uint8Array
}

function ephemeralKeyPair() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() }
}

/** The body of the POST: RFC 8291 section 4 header, then one aes128gcm record. */
export function encryptPayload(input: EncryptInput): Buffer {
  const uaPublic = fromB64u(input.p256dh)
  const authSecret = fromB64u(input.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('bad p256dh')
  if (authSecret.length !== 16) throw new Error('bad auth secret')
  if (input.plaintext.length > MAX_PLAINTEXT) throw new Error('payload too large')

  const as = input.ephemeral ?? ephemeralKeyPair()
  const salt = Buffer.from(input.salt ?? randomBytes(16))
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(as.privateKey)
  const { cek, nonce } = contentKeys(
    ecdh.computeSecret(uaPublic),
    authSecret,
    uaPublic,
    as.publicKey,
    salt,
  )

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 closes the last (here, only) record.
  const record = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(input.plaintext), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header[20] = as.publicKey.length
  return Buffer.concat([header, Buffer.from(as.publicKey), record])
}

/**
 * The receiver's side (RFC 8291 section 3.4), for tests: what a browser does with the body.
 * Not used by the app.
 */
export function decryptPayload(
  body: Uint8Array,
  receiver: { privateKey: Uint8Array; publicKey: Uint8Array; auth: Uint8Array },
): Buffer {
  const buf = Buffer.from(body)
  const salt = buf.subarray(0, 16)
  const idLength = buf[20] ?? 0
  const asPublic = buf.subarray(21, 21 + idLength)
  const record = buf.subarray(21 + idLength)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(receiver.privateKey)
  const { cek, nonce } = contentKeys(
    ecdh.computeSecret(asPublic),
    receiver.auth,
    receiver.publicKey,
    asPublic,
    salt,
  )
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(record.subarray(record.length - TAG_BYTES))
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - TAG_BYTES)),
    decipher.final(),
  ])
  const end = padded.lastIndexOf(0x02)
  if (end === -1) throw new Error('no padding delimiter')
  return padded.subarray(0, end)
}

export type VapidKeys = {
  /** The 65-byte uncompressed public key, base64url: what the browser subscribes with. */
  publicKey: string
  /** The 32-byte private scalar, base64url. */
  privateKey: string
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error('unexpected key format')
  const point = Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x), fromB64u(jwk.y)])
  return { publicKey: b64u(point), privateKey: jwk.d }
}

function vapidPrivateKey(keys: VapidKeys) {
  const point = fromB64u(keys.publicKey)
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('bad VAPID public key')
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33)),
      d: keys.privateKey,
    },
  })
}

/** RFC 8292: an ES256 JWT naming the push service's origin, valid for at most 24 hours. */
export function vapidJwt(
  keys: VapidKeys,
  claims: { audience: string; subject: string; now: Date; ttlSeconds?: number },
): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const ttl = Math.min(claims.ttlSeconds ?? 12 * 3600, 24 * 3600)
  const exp = Math.floor(claims.now.getTime() / 1000) + ttl
  const body = b64u(Buffer.from(JSON.stringify({ aud: claims.audience, exp, sub: claims.subject })))
  const signature = createSign('SHA256')
    .update(`${header}.${body}`)
    .sign({ key: vapidPrivateKey(keys), dsaEncoding: 'ieee-p1363' })
  return `${header}.${body}.${b64u(signature)}`
}

export type WebPushConfig = VapidKeys & {
  /** A `mailto:` or `https:` contact for the push service operator (VAPID `sub`). */
  subject: string
  fetchFn?: typeof fetch
  clock?: () => Date
}

/** Seconds a push service keeps an undelivered message: the notice window, 24 hours. */
const TTL_SECONDS = 24 * 3600

/** Sends through the browser vendor's push service. Never throws, and logs nothing. */
export function webPushSender(config: WebPushConfig): PushSender {
  const fetchFn = config.fetchFn ?? fetch
  const clock = config.clock ?? (() => new Date())
  return {
    async send(subscription: PushSubscription, payload: PushPayload): Promise<PushResult> {
      let request: { url: string; init: RequestInit }
      try {
        const jwt = vapidJwt(config, {
          audience: new URL(subscription.endpoint).origin,
          subject: config.subject,
          now: clock(),
        })
        const body = encryptPayload({
          plaintext: Buffer.from(JSON.stringify(payload), 'utf8'),
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        })
        request = {
          url: subscription.endpoint,
          init: {
            method: 'POST',
            headers: {
              TTL: String(TTL_SECONDS),
              Urgency: 'high',
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              Authorization: `vapid t=${jwt}, k=${config.publicKey}`,
            },
            body: new Uint8Array(body),
            signal: AbortSignal.timeout(10_000),
          },
        }
      } catch {
        // A malformed subscription or a bad key fails the same way on every try.
        return { outcome: 'failed', retryable: false, status: null }
      }
      let res: Response
      try {
        res = await fetchFn(request.url, request.init)
      } catch {
        // A network error or timeout is temporary.
        return { outcome: 'failed', retryable: true, status: null }
      }
      // The body is never read: it is the vendor's, and holds nothing we need.
      await res.body?.cancel().catch(() => {})
      if (res.ok) return { outcome: 'sent' }
      if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status }
      return {
        outcome: 'failed',
        retryable: res.status === 429 || res.status >= 500,
        status: res.status,
      }
    },
  }
}
