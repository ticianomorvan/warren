import { describe, expect, it } from 'vitest'
import {
  mailId,
  masterKeysFromEnv,
  newDataKey,
  open,
  SealError,
  seal,
  sealerFor,
  subkey,
  unwrapDataKey,
  wrapDataKey,
} from '../src/crypto'

const text = (s: string) => new TextEncoder().encode(s)
const MASTER = Buffer.alloc(32, 7).toString('base64')
const OLD_MASTER = Buffer.alloc(32, 9).toString('base64')

describe('seal and open', () => {
  it('round-trips and never repeats a ciphertext', () => {
    const key = newDataKey()
    const a = seal(key, text('{"amount":"1.00"}'), 'u:event:1')
    const b = seal(key, text('{"amount":"1.00"}'), 'u:event:1')
    expect(a.equals(b)).toBe(false)
    expect(open(key, a, 'u:event:1').toString()).toBe('{"amount":"1.00"}')
    // version(1) + nonce(12) + body + tag(16)
    expect(a.length).toBe(1 + 12 + '{"amount":"1.00"}'.length + 16)
    expect(a[0]).toBe(1)
  })

  it('refuses another key, another row, or any changed byte', () => {
    const key = newDataKey()
    const sealed = seal(key, text('secret'), 'u:event:1')
    expect(() => open(newDataKey(), sealed, 'u:event:1')).toThrow(SealError)
    expect(() => open(key, sealed, 'u:event:2')).toThrow(SealError)
    for (const i of [0, 5, sealed.length - 1]) {
      const bad = Buffer.from(sealed)
      bad[i] = (bad[i] ?? 0) ^ 1
      expect(() => open(key, bad, 'u:event:1')).toThrow(SealError)
    }
    expect(() => open(key, sealed.subarray(0, 20), 'u:event:1')).toThrow(SealError)
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(() => seal(Buffer.alloc(16), text('x'), 'a')).toThrow(SealError)
  })

  it("prefixes every row's associated data with the user", () => {
    const key = newDataKey()
    const a = sealerFor('user-a', key)
    const b = sealerFor('user-b', key)
    const sealed = a.seal(text('x'), 'event:1')
    expect(a.open(sealed, 'event:1').toString()).toBe('x')
    expect(() => b.open(sealed, 'event:1')).toThrow(SealError)
  })
})

describe('mail identity', () => {
  it('is a keyed hash: stable per key, different across keys, not a plain SHA-256', () => {
    const raw = text('From: bank\r\n\r\nhello')
    const k1 = newDataKey()
    const k2 = newDataKey()
    expect(mailId(k1, raw)).toBe(mailId(k1, raw))
    expect(mailId(k1, raw)).not.toBe(mailId(k2, raw))
    expect(mailId(k1, raw)).toMatch(/^[0-9a-f]{64}$/)
    expect(subkey(k1, 'mail-id').equals(subkey(k1, 'other'))).toBe(false)
  })
})

describe('master keys', () => {
  it('wraps a data key with the user id as associated data', () => {
    const masters = masterKeysFromEnv({ WARREN_MASTER_KEY: MASTER })
    const dataKey = newDataKey()
    const { wrapped, version } = wrapDataKey(masters, 'user-a', dataKey)
    expect(version).toBe(1)
    expect(unwrapDataKey(masters, 'user-a', wrapped, version).equals(dataKey)).toBe(true)
    expect(() => unwrapDataKey(masters, 'user-b', wrapped, version)).toThrow(SealError)
  })

  it('opens keys wrapped under an older master key while rotating', () => {
    const old = masterKeysFromEnv({ WARREN_MASTER_KEY: OLD_MASTER })
    const dataKey = newDataKey()
    const { wrapped, version } = wrapDataKey(old, 'user-a', dataKey)
    const rotated = masterKeysFromEnv({
      WARREN_MASTER_KEY: MASTER,
      WARREN_MASTER_KEY_VERSION: '2',
      WARREN_MASTER_KEY_PREVIOUS: `1=${OLD_MASTER}`,
    })
    expect(rotated.current).toBe(2)
    expect(unwrapDataKey(rotated, 'user-a', wrapped, version).equals(dataKey)).toBe(true)
    expect(wrapDataKey(rotated, 'user-a', dataKey).version).toBe(2)
    expect(() =>
      unwrapDataKey(masterKeysFromEnv({ WARREN_MASTER_KEY: MASTER }), 'user-a', wrapped, 1),
    ).toThrow(SealError)
  })

  it('refuses a missing or wrongly sized key', () => {
    expect(() => masterKeysFromEnv({})).toThrow(/WARREN_MASTER_KEY/)
    expect(() => masterKeysFromEnv({ WARREN_MASTER_KEY: 'AAAA' })).toThrow(/32 bytes/)
  })
})
