import { handleKapsoWebhook } from '@warren/core'
import { env } from '@/lib/env'
import { noticeTenancy, whatsAppSender } from '@/lib/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Kapso calls this with what WhatsApp reports about Warren's messages (sent, delivered,
 * read, failed). Nothing is trusted until the signature over the raw body passes.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text()
  try {
    const sender = whatsAppSender()
    const kapso = env.kapso()
    if (!sender || !kapso) return Response.json({ error: 'not configured' }, { status: 503 })
    const result = await handleKapsoWebhook(
      {
        tenancy: noticeTenancy(),
        sender,
        senderUserId: kapso.userId,
        webhookSecret: env.kapsoWebhookSecret(),
      },
      body,
      {
        signature: request.headers.get('x-webhook-signature'),
        event: request.headers.get('x-webhook-event'),
      },
    )
    return Response.json(result.body, { status: result.status })
  } catch (error) {
    // Logged without message content. A non-200 makes Kapso retry.
    console.error('inbound/kapso failed:', error instanceof Error ? error.message : 'unknown error')
    return Response.json({ error: 'internal' }, { status: 500 })
  }
}
