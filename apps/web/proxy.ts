import type { NextRequest } from 'next/server'
import { auth } from './lib/auth'
import { guardSession } from './lib/session-guard'

/**
 * Webhooks and the auth routes themselves are outside the matcher, and so is what a browser
 * fetches without a session to install the app: the service worker, the manifest and the icons.
 */
export function proxy(request: NextRequest) {
  return guardSession(request, auth())
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon\\.ico|sw\\.js|manifest\\.webmanifest|icons/).*)'],
}
