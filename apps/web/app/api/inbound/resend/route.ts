import { errorTag, handleResendWebhook } from '@warren/core'
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
    // Also on a redelivery, so a notice that could not go out earlier gets another try.
    const userId = result.body.userId
    if (result.status === 200 && typeof userId === 'string') await sendOwedNotices(userId)
    return Response.json(result.body, { status: result.status })
  } catch (error) {
    // Logged without mail content. A 500 makes Resend retry later.
    console.error('inbound/resend failed:', errorTag(error))
    return Response.json({ error: 'internal' }, { status: 500 })
  }
}
