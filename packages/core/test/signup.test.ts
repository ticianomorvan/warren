import { describe, expect, it } from 'vitest'
import { signupPolicy } from '../src/signup'

describe('signupPolicy', () => {
  it('lets in only the listed emails, whatever their case or spacing', () => {
    const policy = signupPolicy(' Ana@Example.com, bob@example.com;\ncarla@example.com ')
    expect(policy.allows('ana@example.com')).toBe(true)
    expect(policy.allows('  BOB@example.com ')).toBe(true)
    expect(policy.allows('carla@example.com')).toBe(true)
    expect(policy.allows('mallory@example.com')).toBe(false)
  })

  it('does not match a listed email as a prefix, suffix or subaddress', () => {
    const policy = signupPolicy('ana@example.com')
    expect(policy.allows('ana@example.com.evil.test')).toBe(false)
    expect(policy.allows('xana@example.com')).toBe(false)
    expect(policy.allows('ana+1@example.com')).toBe(false)
  })

  it('closes sign-up when there is no list, an empty one, or one with no email in it', () => {
    for (const list of [undefined, '', '  ', '*', 'everyone']) {
      expect(signupPolicy(list).allows('ana@example.com')).toBe(false)
    }
  })
})
