import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INBOUND_DOMAIN,
  inboundAddressOf,
  inboundDomain,
  inboundTokens,
  isInboundToken,
  newInboundToken,
} from '../src/mail/inbound-address'

describe('inbound address', () => {
  it('makes u- plus 22 lower-case base32 characters, different each time', () => {
    const tokens = new Set(Array.from({ length: 200 }, newInboundToken))
    expect(tokens.size).toBe(200)
    for (const token of tokens) expect(token).toMatch(/^u-[a-z2-7]{22}$/)
  })

  it('builds the address on the configured domain, defaulting to in.heywarren.app', () => {
    expect(inboundDomain(undefined)).toBe(DEFAULT_INBOUND_DOMAIN)
    expect(inboundDomain('  ')).toBe('in.heywarren.app')
    expect(inboundDomain(' In.Example.Test ')).toBe('in.example.test')
    expect(inboundAddressOf('u-aaaaaaaaaaaaaaaaaaaaaa', 'in.heywarren.app')).toBe(
      'u-aaaaaaaaaaaaaaaaaaaaaa@in.heywarren.app',
    )
  })

  it('finds tokens only on the domain and in the token shape', () => {
    const t = 'u-abcdefghijklmnopqrstuv'
    expect(isInboundToken(t)).toBe(true)
    expect(isInboundToken(`${t}a`)).toBe(false)
    expect(isInboundToken('u-abcdefghijklmnopqrstu1')).toBe(false)
    expect(
      inboundTokens(
        [`Warren <${t}@in.heywarren.app>`, `${t}@other.test`, 'x@in.heywarren.app'],
        'in.heywarren.app',
      ),
    ).toEqual([t])
  })
})
