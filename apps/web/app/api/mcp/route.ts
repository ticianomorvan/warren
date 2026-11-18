import { auth, authDatabase } from '@/lib/auth'
import { mcpResourceUrl } from '@/lib/auth-config'
import { env } from '@/lib/env'
import { createMcpRoute } from '@/lib/mcp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

let route: ReturnType<typeof createMcpRoute> | undefined

// Built on first use, so a build without secrets still succeeds.
const serve = (request: Request) => {
  route ??= createMcpRoute({
    auth: auth(),
    authDatabase: authDatabase(),
    resource: mcpResourceUrl(env.authOrigins().baseURL),
  })
  return route(request)
}

export const POST = serve
export const GET = serve
export const DELETE = serve
