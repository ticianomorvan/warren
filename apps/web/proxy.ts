import { getSessionCookie } from 'better-auth/cookies'
import { type NextRequest, NextResponse } from 'next/server'
import { auth } from './lib/auth'

const PUBLIC_PAGES = ['/sign-in', '/sign-up']

/**
 * Sends people without a session to /sign-in, and people with one away from it. The session is
 * checked against the database with `auth.api.getSession`; the cookie alone proves nothing, so
 * it is only used to skip that lookup when there is no cookie at all. Webhooks and the auth
 * routes themselves are outside the matcher.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const hasCookie = getSessionCookie(request) !== null
  const session = hasCookie ? await auth().api.getSession({ headers: request.headers }) : null
  const isPublic = PUBLIC_PAGES.includes(pathname)

  if (!session && !isPublic) return NextResponse.redirect(new URL('/sign-in', request.url))
  if (session && isPublic) return NextResponse.redirect(new URL('/', request.url))
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon.ico).*)'],
}
