import { createECDH, createPublicKey, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decryptPayload,
  encryptPayload,
  generateVapidKeys,
  MAX_PLAINTEXT,
  type PushPayload,
  parseSubscription,
  vapidJwt,
  webPushSender,
} from '../src/notify'

const b64u = (text: string) => Buffer.from(text.replace(/\s+/g, ''), 'base64url')
const toB64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

// RFC 8291 Appendix A, with whitespace removed.
const RFC = {
  plaintext: b64u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  asPublic: b64u(
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ),
  asPrivate: b64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: b64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
  salt: b64u('DGv6ra1nlYgDCS1FRnbzlw'),
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  // The 86-octet header, then the ciphertext, as printed in the RFC.
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  // The whole POST body, as printed in section 5 (not the two parts above joined as text:
  // an 86-octet header does not end on a base64 boundary).
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

describe('RFC 8291 aes128gcm encryption', () => {
  it('reproduces the Appendix A vector byte for byte', () => {
    const body = encryptPayload({
      plaintext: RFC.plaintext,
      p256dh: RFC.uaPublic,
      auth: RFC.auth,
      ephemeral: { privateKey: RFC.asPrivate, publicKey: RFC.asPublic },
      salt: RFC.salt,
    })
    expect(Buffer.from(RFC.plaintext).toString()).toBe('When I grow up, I want to be a watermelon')
    expect(toB64u(body.subarray(0, 86))).toBe(RFC.header)
    expect(body.subarray(86).equals(b64u(RFC.ciphertext))).toBe(true)
    expect(toB64u(body)).toBe(RFC.message)
  })

  it('decrypts the RFC message with the receiver private key', () => {
    const body = b64u(RFC.message)
    const text = decryptPayload(body, {
      privateKey: RFC.uaPrivate,
      publicKey: b64u(RFC.uaPublic),
      auth: b64u(RFC.auth),
    })
    expect(text.toString()).toBe('When I grow up, I want to be a watermelon')
  })

  it('round-trips a random message with fresh keys, salt and ephemeral key', () => {
    const receiver = createECDH('prime256v1')
    receiver.generateKeys()
    const auth = Buffer.from('0123456789abcdef')
    const message = Buffer.from(JSON.stringify({ title: 'Compra con tarjeta', body: 'ñ → €' }))
    const first = encryptPayload({
      plaintext: message,
      p256dh: toB64u(receiver.getPublicKey()),
      auth: toB64u(auth),
    })
    const again = encryptPayload({
      plaintext: message,
      p256dh: toB64u(receiver.getPublicKey()),
      auth: toB64u(auth),
    })
    expect(first.equals(again)).toBe(false)
    expect(first.readUInt32BE(16)).toBe(4096)
    expect(first[20]).toBe(65)
    const opened = decryptPayload(first, {
      privateKey: receiver.getPrivateKey(),
      publicKey: receiver.getPublicKey(),
      auth,
    })
    expect(opened.equals(message)).toBe(true)
  })

  it('does not open for another receiver, and refuses a payload that does not fit', () => {
    const receiver = createECDH('prime256v1')
    receiver.generateKeys()
    const other = createECDH('prime256v1')
    other.generateKeys()
    const auth = Buffer.alloc(16, 7)
    const body = encryptPayload({
      plaintext: Buffer.from('hola'),
      p256dh: toB64u(receiver.getPublicKey()),
      auth: toB64u(auth),
    })
    expect(() =>
      decryptPayload(body, {
        privateKey: other.getPrivateKey(),
        publicKey: other.getPublicKey(),
        auth,
      }),
    ).toThrow()
    const fits = Buffer.alloc(MAX_PLAINTEXT, 0x61)
    const args = { p256dh: toB64u(receiver.getPublicKey()), auth: toB64u(auth) }
    expect(encryptPayload({ plaintext: fits, ...args })).toHaveLength(4096)
    expect(() => encryptPayload({ plaintext: Buffer.alloc(MAX_PLAINTEXT + 1), ...args })).toThrow(
      'payload too large',
    )
  })
})

describe('RFC 8292 VAPID', () => {
  const keys = generateVapidKeys()
  const now = new Date('2026-11-18T12:00:00Z')

  it('makes a 65-byte public key and a 32-byte private scalar', () => {
    expect(b64u(keys.publicKey)).toHaveLength(65)
    expect(b64u(keys.publicKey)[0]).toBe(0x04)
    expect(b64u(keys.privateKey)).toHaveLength(32)
  })

  it('signs an ES256 JWT that verifies with the public key, with the right claims', () => {
    const jwt = vapidJwt(keys, {
      audience: 'https://fcm.googleapis.com',
      subject: 'mailto:ops@example.invalid',
      now,
    })
    const [header, body, signature] = jwt.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    })
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
      sub: 'mailto:ops@example.invalid',
    })
    const point = b64u(keys.publicKey)
    const publicKey = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: toB64u(point.subarray(1, 33)),
        y: toB64u(point.subarray(33)),
      },
    })
    const sig = Buffer.from(signature, 'base64url')
    expect(sig).toHaveLength(64)
    const verify = (data: string, s: Buffer) =>
      createVerify('SHA256').update(data).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, s)
    expect(verify(`${header}.${body}`, sig)).toBe(true)
    expect(verify(`${header}.${body}x`, sig)).toBe(false)
  })

  it('never lives longer than 24 hours', () => {
    const jwt = vapidJwt(keys, {
      audience: 'https://x',
      subject: 'mailto:a@b.c',
      now,
      ttlSeconds: 10 ** 7,
    })
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString())
    expect(claims.exp - Math.floor(now.getTime() / 1000)).toBe(24 * 3600)
  })
})

describe('webPushSender', () => {
  const vapid = generateVapidKeys()
  const receiver = createECDH('prime256v1')
  receiver.generateKeys()
  const auth = Buffer.alloc(16, 9)
  const subscription = {
    endpoint: 'https://updates.push.example/wpush/v2/abc123',
    p256dh: toB64u(receiver.getPublicKey()),
    auth: toB64u(auth),
  }
  const payload: PushPayload = { title: 'T', body: 'B', tag: 'notice-1', url: '/movements' }
  const config = {
    ...vapid,
    subject: 'mailto:ops@example.invalid',
    clock: () => new Date('2026-11-18T12:00:00Z'),
  }

  function answering(status: number) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status })
    }) as unknown as typeof fetch
    return { calls, fetchFn }
  }

  it('posts the encrypted message with the RFC 8030 and RFC 8292 headers', async () => {
    const { calls, fetchFn } = answering(201)
    expect(await webPushSender({ ...config, fetchFn }).send(subscription, payload)).toEqual({
      outcome: 'sent',
    })
    const call = calls[0]
    expect(call?.url).toBe(subscription.endpoint)
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.TTL).toBe('86400')
    expect(headers.Urgency).toBe('high')
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(headers.Authorization ?? '')
    expect(match?.[2]).toBe(vapid.publicKey)
    const claims = JSON.parse(Buffer.from(match?.[1]?.split('.')[1] ?? '', 'base64url').toString())
    expect(claims.aud).toBe('https://updates.push.example')
    expect(claims.sub).toBe('mailto:ops@example.invalid')
    const text = decryptPayload(call?.init.body as Uint8Array, {
      privateKey: receiver.getPrivateKey(),
      publicKey: receiver.getPublicKey(),
      auth,
    })
    expect(JSON.parse(text.toString())).toEqual(payload)
  })

  it.each([
    [200, { outcome: 'sent' }],
    [201, { outcome: 'sent' }],
    [404, { outcome: 'gone', status: 404 }],
    [410, { outcome: 'gone', status: 410 }],
    [429, { outcome: 'failed', retryable: true, status: 429 }],
    [500, { outcome: 'failed', retryable: true, status: 500 }],
    [503, { outcome: 'failed', retryable: true, status: 503 }],
    [400, { outcome: 'failed', retryable: false, status: 400 }],
    [401, { outcome: 'failed', retryable: false, status: 401 }],
    [413, { outcome: 'failed', retryable: false, status: 413 }],
  ])('maps a %i answer to %j', async (status, expected) => {
    const { fetchFn } = answering(status)
    expect(await webPushSender({ ...config, fetchFn }).send(subscription, payload)).toEqual(
      expected,
    )
  })

  it('treats a network error as temporary and a malformed subscription as final', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await webPushSender({ ...config, fetchFn: down }).send(subscription, payload)).toEqual({
      outcome: 'failed',
      retryable: true,
      status: null,
    })
    const { calls, fetchFn } = answering(201)
    const broken = { ...subscription, p256dh: 'AAAA' }
    expect(await webPushSender({ ...config, fetchFn }).send(broken, payload)).toEqual({
      outcome: 'failed',
      retryable: false,
      status: null,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('parseSubscription', () => {
  const keys = {
    p256dh:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }
  const ok = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }

  it('reads what a browser sends', () => {
    expect(parseSubscription(ok)).toEqual({ endpoint: ok.endpoint, ...keys })
    // `expirationTime` and other fields are ignored.
    expect(parseSubscription({ ...ok, expirationTime: null })).not.toBeNull()
  })

  it.each([
    ['not an object', null],
    ['http', { ...ok, endpoint: 'http://fcm.googleapis.com/x' }],
    ['credentials', { ...ok, endpoint: 'https://user:pw@fcm.googleapis.com/x' }],
    ['a port', { ...ok, endpoint: 'https://fcm.googleapis.com:8443/x' }],
    ['an ip address', { ...ok, endpoint: 'https://169.254.169.254/latest' }],
    ['an ipv6 address', { ...ok, endpoint: 'https://[::1]/x' }],
    ['localhost', { ...ok, endpoint: 'https://localhost/x' }],
    ['a single-label host', { ...ok, endpoint: 'https://internal/x' }],
    ['no url', { ...ok, endpoint: 'nope' }],
    ['a huge url', { ...ok, endpoint: `https://fcm.googleapis.com/${'a'.repeat(3000)}` }],
    ['short p256dh', { ...ok, keys: { ...keys, p256dh: 'AAAA' } }],
    ['short auth', { ...ok, keys: { ...keys, auth: 'AAAA' } }],
    ['no keys', { endpoint: ok.endpoint }],
  ])('refuses %s', (_name, input) => {
    expect(parseSubscription(input)).toBeNull()
  })
})
