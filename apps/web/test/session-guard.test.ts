import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'
import { guardSession, type SessionLookup } from '../lib/session-guard'

const COOKIE = 'better-auth.session_token=abc'
const request = (path: string, withCookie = true) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: withCookie ? { cookie: COOKIE } : {},
  })

const lookup = (found: { cookies?: string[]; session: unknown } | Error): SessionLookup => ({
  api: {
    getSession: vi.fn(async () => {
      if (found instanceof Error) throw found
      const headers = new Headers()
      for (const c of found.cookies ?? []) headers.append('set-cookie', c)
      return { headers, response: found.session }
    }),
  },
})

describe('guardSession', () => {
  it('sends a signed-out person to /sign-in', async () => {
    const res = await guardSession(request('/', false), lookup({ session: null }))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/sign-in')
  })

  it('does not look the session up when there is no cookie', async () => {
    const auth = lookup({ session: null })
    await guardSession(request('/', false), auth)
    expect(auth.api.getSession).not.toHaveBeenCalled()
  })

  it('lets a signed-in person through, and sends them away from /sign-in', async () => {
    const auth = lookup({ session: { user: { id: 'u' } } })
    expect((await guardSession(request('/'), auth)).headers.get('location')).toBeNull()
    const away = await guardSession(request('/sign-in'), auth)
    expect(away.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('copies the cookies of a refreshed session onto the response, redirect or not', async () => {
    const refreshed = [
      'better-auth.session_token=new; Path=/; HttpOnly',
      'better-auth.session_data=x; Path=/',
    ]
    const auth = lookup({ session: { user: { id: 'u' } }, cookies: refreshed })
    expect((await guardSession(request('/'), auth)).headers.getSetCookie()).toEqual(refreshed)
    expect((await guardSession(request('/sign-in'), auth)).headers.getSetCookie()).toEqual(
      refreshed,
    )
  })

  it('passes on the cookie that clears an expired session', async () => {
    const cleared = ['better-auth.session_token=; Max-Age=0; Path=/']
    const res = await guardSession(request('/'), lookup({ session: null, cookies: cleared }))
    expect(res.headers.get('location')).toBe('http://localhost:3000/sign-in')
    expect(res.headers.getSetCookie()).toEqual(cleared)
  })

  it('does not answer 500 when the lookup fails: /sign-in still opens, a private page redirects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const down = lookup(new Error('connection refused to db.internal'))
    const signIn = await guardSession(request('/sign-in'), down)
    expect(signIn.status).toBe(200)
    expect(signIn.headers.get('location')).toBeNull()
    const home = await guardSession(request('/'), down)
    expect(home.status).toBe(307)
    expect(home.headers.get('location')).toBe('http://localhost:3000/sign-in')
  })
})
