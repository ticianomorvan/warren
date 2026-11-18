import { describe, expect, it } from 'vitest'
import { authOrigins } from '../lib/auth-origin'

describe('authOrigins', () => {
  it('uses BETTER_AUTH_URL in production and locally', () => {
    expect(authOrigins({ BETTER_AUTH_URL: 'https://warren.example' })).toEqual({
      baseURL: 'https://warren.example',
      trustedOrigins: [],
    })
    expect(
      authOrigins({
        VERCEL_ENV: 'production',
        VERCEL_URL: 'warren-abc.vercel.app',
        BETTER_AUTH_URL: 'https://warren.example',
      }).baseURL,
    ).toBe('https://warren.example')
  })

  it("derives a preview's origin from the deployment, and trusts its branch alias", () => {
    expect(
      authOrigins({
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'warren-abc123.vercel.app',
        VERCEL_BRANCH_URL: 'warren-git-feat-sign-in.vercel.app',
        BETTER_AUTH_URL: 'https://warren.example',
      }),
    ).toEqual({
      baseURL: 'https://warren-abc123.vercel.app',
      trustedOrigins: ['https://warren-git-feat-sign-in.vercel.app'],
    })
  })

  it('needs no BETTER_AUTH_URL on a preview, and asks for it everywhere else', () => {
    expect(authOrigins({ VERCEL_ENV: 'preview', VERCEL_URL: 'w.vercel.app' }).baseURL).toBe(
      'https://w.vercel.app',
    )
    expect(() => authOrigins({})).toThrow(/BETTER_AUTH_URL/)
  })
})
