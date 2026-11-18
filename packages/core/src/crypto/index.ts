import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Sealing: how personal data is kept so that erasing a user means destroying one key.
 *
 * Each user has a random 32-byte data key. It seals the user's personal columns and raw mail
 * with AES-256-GCM. The data key itself is stored wrapped by a master key from the environment
 * (no cloud KMS: the no-vendor rule). Everything here is `node:crypto`.
 *
 * A sealed value is `version(1) || nonce(12) || ciphertext || tag(16)`. The associated data
 * binds a value to the row it belongs to, so a sealed value copied to another row, or another
 * user, no longer opens.
 */

export const SEAL_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export class SealError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealError'
  }
}

function checkKey(key: Uint8Array) {
  if (key.byteLength !== KEY_BYTES) throw new SealError(`key must be ${KEY_BYTES} bytes`)
}

/** A fresh random data key for a user. */
export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

const aadBytes = (aad: string) =>
  Buffer.concat([Buffer.from([SEAL_VERSION]), Buffer.from(aad, 'utf8')])

/** Encrypts `plaintext` under `key`, bound to `aad` (for example `<user id>:event:<event id>`). */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  checkKey(key)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aadBytes(aad))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([SEAL_VERSION]), nonce, body, cipher.getAuthTag()])
}

/** Reverses `seal`. Throws `SealError` for a wrong key, wrong `aad` or any change to the bytes. */
export function open(key: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  checkKey(key)
  if (sealed.byteLength < 1 + NONCE_BYTES + TAG_BYTES) throw new SealError('sealed value too short')
  if (sealed[0] !== SEAL_VERSION) throw new SealError(`unknown seal version ${sealed[0]}`)
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength)
  const nonce = buf.subarray(1, 1 + NONCE_BYTES)
  const tag = buf.subarray(buf.length - TAG_BYTES)
  const body = buf.subarray(1 + NONCE_BYTES, buf.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(aadBytes(aad))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new SealError('cannot open sealed value')
  }
}

/** A purpose-bound key derived from the data key, so one key never serves two uses. */
export function subkey(dataKey: Uint8Array, label: string): Buffer {
  checkKey(dataKey)
  return Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), `warren:${label}`, KEY_BYTES))
}

/**
 * A mail's identity inside one user's ledger: HMAC-SHA256 of the raw bytes under a subkey.
 * A plain hash of a known bank mail would let anyone with database access confirm that a user
 * received it; this one means nothing without the key, and is gone when the key is.
 */
export function mailId(dataKey: Uint8Array, raw: Uint8Array): string {
  return createHmac('sha256', subkey(dataKey, 'mail-id')).update(raw).digest('hex')
}

/** The master keys that wrap users' data keys. Old versions stay readable while rotating. */
export type MasterKeys = { current: number; keys: ReadonlyMap<number, Buffer> }

function keyFromBase64(name: string, value: string): Buffer {
  const key = Buffer.from(value, 'base64')
  // Canonical, padded base64 only: a value cut short at its padding would still decode.
  if (key.byteLength !== KEY_BYTES || key.toString('base64') !== value) {
    throw new SealError(`${name} must be 32 bytes, base64`)
  }
  return key
}

/**
 * Reads `WARREN_MASTER_KEY` (32 bytes, base64) as the current key, at the version given by
 * `WARREN_MASTER_KEY_VERSION` (default 1). `WARREN_MASTER_KEY_PREVIOUS` may list older ones as
 * `version=base64` pairs separated by commas, so wrapped keys made under them still open.
 */
export function masterKeysFromEnv(env: Record<string, string | undefined>): MasterKeys {
  const raw = env.WARREN_MASTER_KEY
  if (!raw) throw new SealError('Missing environment variable WARREN_MASTER_KEY')
  const current = Number(env.WARREN_MASTER_KEY_VERSION ?? '1')
  if (!Number.isInteger(current) || current < 1) throw new SealError('bad master key version')
  const keys = new Map<number, Buffer>([[current, keyFromBase64('WARREN_MASTER_KEY', raw)]])
  for (const pair of (env.WARREN_MASTER_KEY_PREVIOUS ?? '').split(',').filter(Boolean)) {
    // Split on the first '=' only: base64 padding is made of '=' signs.
    const eq = pair.indexOf('=')
    const version = eq === -1 ? '' : pair.slice(0, eq).trim()
    const value = eq === -1 ? '' : pair.slice(eq + 1).trim()
    const n = Number(version)
    if (!value || !Number.isInteger(n) || n < 1 || keys.has(n)) {
      throw new SealError('bad WARREN_MASTER_KEY_PREVIOUS')
    }
    keys.set(n, keyFromBase64('WARREN_MASTER_KEY_PREVIOUS', value))
  }
  return { current, keys }
}

/** Wraps a user's data key for storage. The user id is the associated data. */
export function wrapDataKey(masters: MasterKeys, userId: string, dataKey: Uint8Array) {
  const master = masters.keys.get(masters.current)
  if (!master) throw new SealError('current master key missing')
  return { wrapped: seal(master, dataKey, userId), version: masters.current }
}

export function unwrapDataKey(
  masters: MasterKeys,
  userId: string,
  wrapped: Uint8Array,
  version: number,
): Buffer {
  const master = masters.keys.get(version)
  if (!master) throw new SealError(`no master key for wrap version ${version}`)
  return open(master, wrapped, userId)
}

/** Seals and opens with one user's key. The associated data is always prefixed by the user. */
export interface Sealer {
  seal(plaintext: Uint8Array, aad: string): Buffer
  open(sealed: Uint8Array, aad: string): Buffer
  mailId(raw: Uint8Array): string
}

export function sealerFor(userId: string, dataKey: Uint8Array): Sealer {
  return {
    seal: (plaintext, aad) => seal(dataKey, plaintext, `${userId}:${aad}`),
    open: (sealed, aad) => open(dataKey, sealed, `${userId}:${aad}`),
    mailId: (raw) => mailId(dataKey, raw),
  }
}
