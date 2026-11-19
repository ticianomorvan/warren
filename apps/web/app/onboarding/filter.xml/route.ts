import { gmailFilterXml, inboundAddressOf } from '@warren/core'
import { asUser, inboundAddressFor } from '@warren/db'
import { database } from '@/lib/db'
import { env } from '@/lib/env'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * The Gmail filter for the signed-in person: their bank senders, forwarded to their own Warren
 * address. Signed-in only (the proxy sends strangers to /sign-in; this is the check that counts).
 */
export async function GET() {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })
  const token = await asUser(database(), session.user.id, inboundAddressFor)
  return new Response(gmailFilterXml(inboundAddressOf(token, env.inboundDomain()), new Date()), {
    headers: {
      'content-type': 'application/atom+xml; charset=utf-8',
      'content-disposition': 'attachment; filename="warren-filtro.xml"',
      'cache-control': 'private, no-store',
    },
  })
}
