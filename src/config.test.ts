import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

const env = { DATABASE_URL: 'postgres://x' }
const auth = {
  PUBLIC_URL: 'https://heywarren.app',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
}

describe('loadConfig', () => {
  it('needs only the database: without PUBLIC_URL there is no sign-in, no web and no /mcp', () => {
    const config = loadConfig(env)
    expect(config.auth).toBeUndefined()
    expect(config.PORT).toBe(3000)
  })

  it('turns the auth server on, whole, with PUBLIC_URL and the rest', () => {
    expect(loadConfig({ ...env, ...auth }).auth).toEqual({
      publicUrl: 'https://heywarren.app',
      secret: 'x'.repeat(32),
      google: { clientId: 'id', clientSecret: 'secret' },
    })
  })

  it.each(['BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])(
    'refuses PUBLIC_URL without %s, naming the variable and never its value',
    (name) => {
      const { [name]: _gone, ...rest } = auth as Record<string, string>
      expect(() => loadConfig({ ...env, ...rest })).toThrow(name)
    },
  )

  it('refuses a short secret and a public URL that is not an origin', () => {
    expect(() => loadConfig({ ...env, ...auth, BETTER_AUTH_SECRET: 'short' })).toThrow(
      'BETTER_AUTH_SECRET',
    )
    expect(() => loadConfig({ ...env, ...auth, PUBLIC_URL: 'http://heywarren.app' })).toThrow(
      'PUBLIC_URL',
    )
  })
})
