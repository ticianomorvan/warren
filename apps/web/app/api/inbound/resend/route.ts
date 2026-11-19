import { errorTag, handleResendWebhook } from '@warren/core'
import { after } from 'next/server'
import { resendWebhookDeps } from '@/lib/intake'
import { sendOwedNotices } from '@/lib/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Resend calls this when a mail reaches Warren's inbound address. The address is public,
 * so nothing here is trusted until the webhook signature and then the bank's DKIM pass.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text()
  try {
    const result = await handleResendWebhook(resendWebhookDeps(), body, {
      id: request.headers.get('svix-id'),
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    })
    // Also on a redelivery, so a notice that could not go out earlier gets another try. After
    // the response: Resend is answered at once, and the function stays alive until the pushes
    // are sent (maxDuration above). `sendOwedNotices` never throws.
    // Which route found the user; no address or content. It shows when the legacy To-header route
    // can be removed (slice 6 spec), and a wrong WARREN_INBOUND_DOMAIN as legacy-only routing.
    if (result.body.routedBy) console.info('inbound routed by', result.body.routedBy)
    const userId = result.body.userId
    if (result.status === 200 && typeof userId === 'string') after(() => sendOwedNotices(userId))
    return Response.json(result.body, { status: result.status })
  } catch (error) {
    // Logged without mail content. A 500 makes Resend retry later.
    console.error('inbound/resend failed:', errorTag(error))
    return Response.json({ error: 'internal' }, { status: 500 })
  }
}
