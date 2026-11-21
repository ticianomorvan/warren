import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** What the agent sent to "WhatsApp", with the wall time it arrived at (performance.now). */
export type Sent =
  | { kind: 'typing'; at: number; messageId: string }
  | { kind: 'read'; at: number; messageId: string }
  | { kind: 'text'; at: number; to: string; body: string }

export interface FakeGraph {
  url: string
  sent: Sent[]
  /** Media the agent may download: id to bytes. */
  media: Map<string, { mime: string; data: Buffer }>
  close(): Promise<void>
}

/**
 * A Meta Graph double for the Chat SDK adapter: it records sends, typing indicators and read receipts and
 * serves media. Nothing here ever reaches Meta.
 */
export async function startFakeGraph(port = 0): Promise<FakeGraph> {
  const sent: Sent[] = []
  const media = new Map<string, { mime: string; data: Buffer }>()
  let n = 0
  const server: Server = createServer(async (req, res) => {
    const at = performance.now()
    const url = new URL(req.url ?? '/', 'http://x')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    // GET /v25.0/<mediaId> (metadata) and GET /media/<mediaId> (bytes)
    if (req.method === 'GET') {
      const id = url.pathname.split('/').pop() ?? ''
      const file = media.get(id)
      if (!file) {
        res.statusCode = 404
        return json({ error: { message: 'no media' } })
      }
      if (url.pathname.startsWith('/media/')) {
        res.setHeader('content-type', file.mime)
        return res.end(file.data)
      }
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      return json({
        url: `${base}/media/${id}`,
        mime_type: file.mime,
        id,
        file_size: file.data.length,
      })
    }
    const body = raw ? JSON.parse(raw) : {}
    if (body.status === 'read') {
      sent.push({ kind: body.typing_indicator ? 'typing' : 'read', at, messageId: body.message_id })
      return json({ success: true })
    }
    if (body.type === 'text' || body.text) {
      sent.push({ kind: 'text', at, to: body.to, body: body.text?.body ?? '' })
      return json({
        messaging_product: 'whatsapp',
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: `wamid.OUT${++n}` }],
      })
    }
    return json({ success: true })
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, sent, media, close: () => new Promise((r) => server.close(() => r())) }
}
