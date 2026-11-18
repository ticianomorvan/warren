import { auth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** RFC 9728 metadata; the `mcp()` plugin builds it (`resource`, one authorization server). */
export const GET = (request: Request) => auth().handler(request)
