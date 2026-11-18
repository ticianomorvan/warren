import type { NextRequest } from 'next/server'
import { auth } from './lib/auth'
import { guardSession } from './lib/session-guard'

/**
 * Webhooks and the auth routes themselves are outside the matcher, and so is what a browser
 * fetches without a session to install the app: the service worker, the manifest and the icons.
 * So are the OAuth discovery documents (`/.well-known/`, which an agent fetches with no session)
 * and the consent page (`/oauth/`), which checks the session itself: its signed query must reach
 * /sign-in, and the guard would drop it.
 */
export function proxy(request: NextRequest) {
  return guardSession(request, auth())
}

export const config = {
  matcher: [
    '/((?!api/|_next/|\\.well-known/|oauth/|favicon\\.ico|sw\\.js|manifest\\.webmanifest|icons/).*)',
  ],
}
