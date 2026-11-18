import { describe, expect, it } from 'vitest'
import { config } from '../proxy'

// Next compiles the matcher with path-to-regexp; as a regular expression it reads the same.
const matched = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path)

describe('proxy matcher', () => {
  it('guards the pages', () => {
    expect(matched('/')).toBe(true)
    expect(matched('/movements')).toBe(true)
    expect(matched('/sign-in')).toBe(true)
  })

  it('leaves discovery, the consent page and the API alone', () => {
    expect(matched('/.well-known/oauth-authorization-server')).toBe(false)
    expect(matched('/.well-known/oauth-authorization-server/api/auth')).toBe(false)
    expect(matched('/.well-known/oauth-protected-resource/api/mcp')).toBe(false)
    expect(matched('/oauth/consent')).toBe(false)
    expect(matched('/api/mcp')).toBe(false)
    expect(matched('/api/auth/oauth2/token')).toBe(false)
  })
})
