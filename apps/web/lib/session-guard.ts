import { getSessionCookie } from 'better-auth/cookies'
import { type NextRequest, NextResponse } from 'next/server'

const PUBLIC_PAGES = ['/sign-in', '/sign-up']

/** The one thing the guard needs from Better Auth, so a test can stand in for it. */
export type SessionLookup = {
  api: {
    getSession(options: {
      headers: Headers
      returnHeaders: true
    }): Promise<{ headers: Headers; response: unknown }>
  }
}

/**
 * Sends people without a session to /sign-in, and people with one away from it. The session is
 * checked against the database; the cookie alone proves nothing, so it only lets the guard skip
 * that lookup when there is no cookie at all.
 *
 * Whatever cookies the lookup sets (a refreshed session, or an expired one cleared) go onto the
 * response, or the browser would never get them. If the lookup fails (the database is down) the
 * person is treated as signed out: the sign-in page still opens, and a protected page sends them
 * there, instead of the whole site answering 500.
 */
export async function guardSession(request: NextRequest, auth: SessionLookup) {
  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PAGES.includes(pathname)
  let session: unknown = null
  let cookies: string[] = []
  if (getSessionCookie(request) !== null) {
    try {
      const found = await auth.api.getSession({ headers: request.headers, returnHeaders: true })
      session = found.response
      cookies = found.headers.getSetCookie()
    } catch {
      // Not logged: the error can name the database. The next request tries again.
      console.error('session lookup failed; treating the request as signed out')
    }
  }

  const response =
    !session && !isPublic
      ? NextResponse.redirect(new URL('/sign-in', request.url))
      : session && isPublic
        ? NextResponse.redirect(new URL('/', request.url))
        : NextResponse.next()
  for (const cookie of cookies) response.headers.append('set-cookie', cookie)
  return response
}
