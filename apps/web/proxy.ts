import type { NextRequest } from 'next/server'
import { auth } from './lib/auth'
import { guardSession } from './lib/session-guard'

/** Webhooks and the auth routes themselves are outside the matcher. */
export function proxy(request: NextRequest) {
  return guardSession(request, auth())
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon.ico).*)'],
}
