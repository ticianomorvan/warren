import { toNextJsHandler } from 'better-auth/next-js'
import { auth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Resolved per request: the instance reads its environment on first use, not at build.
export const GET = (request: Request) => toNextJsHandler(auth()).GET(request)
export const POST = (request: Request) => toNextJsHandler(auth()).POST(request)
