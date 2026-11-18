import { auth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** The same document at the RFC 9728 path of the MCP endpoint, where Claude looks first. */
export const GET = (request: Request) => auth().handler(request)
