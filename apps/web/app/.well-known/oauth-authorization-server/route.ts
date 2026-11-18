import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider'
import { auth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** RFC 8414 metadata. It must advertise CIMD support, or Claude falls back to Dynamic Client Registration. */
export const GET = (request: Request) => oauthProviderAuthServerMetadata(auth())(request)
