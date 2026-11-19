import { randomBytes } from 'node:crypto'
import { addressesIn } from './headers'

/** Where a user's own addresses live unless `WARREN_INBOUND_DOMAIN` says otherwise. */
export const DEFAULT_INBOUND_DOMAIN = 'in.heywarren.app'

const TOKEN = /^u-[a-z2-7]{22}$/
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** `WARREN_INBOUND_DOMAIN`, trimmed and lower case, or the default when unset or blank. */
export function inboundDomain(value: string | undefined): string {
  return value?.trim().toLowerCase() || DEFAULT_INBOUND_DOMAIN
}

export const isInboundToken = (token: string): boolean => TOKEN.test(token)

/** `u-` and 22 base32 characters (110 bits) from the system's random source. */
export function newInboundToken(): string {
  // 22 bytes, one per character: 256 is a multiple of 32, so `% 32` is unbiased.
  let out = 'u-'
  for (const byte of randomBytes(22)) out += ALPHABET[byte % 32]
  return out
}

export const inboundAddressOf = (token: string, domain: string): string => `${token}@${domain}`

/**
 * The tokens named by delivered-to recipients, in order: only addresses on `domain` whose local
 * part has the token shape. Everything else is ignored, so no other string reaches the database.
 */
export function inboundTokens(recipients: readonly string[], domain: string): string[] {
  const out: string[] = []
  for (const recipient of recipients) {
    for (const address of addressesIn(recipient)) {
      const at = address.lastIndexOf('@')
      const token = address.slice(0, at)
      if (address.slice(at + 1) === domain && isInboundToken(token)) out.push(token)
    }
  }
  return out
}
