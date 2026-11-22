import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AuthRoutes } from './auth/routes'
import type { Config } from './config'
import { log } from './log'
import type { Processor } from './process'
import type { Store } from './store'
import { parseWebhook } from './whatsapp/payload'
import { safeEqual, validSignature } from './whatsapp/signature'

const MAX_BODY = 1_000_000

export interface AppOptions {
  store: Store
  config: Pick<Config, 'WHATSAPP_VERIFY_TOKEN' | 'META_APP_SECRET'>
  processor: Processor
  /** The OAuth server's routes for MCP (docs/mcp-spec.md); without them none of its paths exist. */
  auth?: AuthRoutes
}

/** The raw body, or null when it is over the limit. An oversized body is still read to the end. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size <= MAX_BODY) chunks.push(chunk)
  }
  return size > MAX_BODY ? null : Buffer.concat(chunks)
}

function send(res: ServerResponse, status: number, body = ''): void {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(body)
}

const seconds = (n: number | undefined) => (n === undefined ? null : new Date(n * 1000))

/** Plain node:http: a few routes do not need a framework. */
export function createApp(o: AppOptions): Server {
  const { store, config, processor } = o

  function verify(url: URL, res: ServerResponse) {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token') ?? ''
    const challenge = url.searchParams.get('hub.challenge') ?? ''
    if (mode === 'subscribe' && safeEqual(token, config.WHATSAPP_VERIFY_TOKEN)) {
      return send(res, 200, challenge)
    }
    send(res, 403)
  }

  async function receive(req: IncomingMessage, res: ServerResponse) {
    const raw = await readBody(req)
    if (!raw) return send(res, 413)
    const sig = req.headers['x-hub-signature-256']
    if (!validSignature(raw, typeof sig === 'string' ? sig : undefined, config.META_APP_SECRET)) {
      log('webhook_bad_signature')
      return send(res, 401)
    }
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return send(res, 400)
    }
    const { messages, statuses } = parseWebhook(body)
    const wamids = messages.map((m) => m.id)

    // Persist before answering: after the 200 Meta will not send this again. Every message goes in
    // as `pending`; the processor decides whether it is answered. If the batch fails halfway, the
    // rows already stored are still processed now, and Meta's retry brings the rest.
    try {
      for (const m of messages) {
        const inserted = await store.recordInbound({
          wamid: m.id,
          wa_id: m.from,
          kind: m.type,
          body: m.text?.body ?? m.image?.caption ?? null,
          raw: m.raw,
          metaTs: seconds(m.timestamp),
        })
        if (inserted) log('message_received', { wamid: m.id, kind: m.type })
      }
      for (const s of statuses) {
        const e = s.errors?.[0]
        await store.recordStatus({
          wamid: s.id,
          status: s.status,
          at: seconds(s.timestamp) ?? new Date(),
          code: e?.code,
        })
        if (s.status === 'failed') {
          log('status_failed', { outbound: s.id, code: e?.code, title: e?.title }, 'error')
        }
      }
    } catch (err) {
      void processor.kick(wamids)
      throw err
    }

    send(res, 200)
    // A retried batch has rows that are already stored but still pending: claim them too.
    void processor.kick(wamids)
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return send(res, 400)
    }
    if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, 'ok')
    if (url.pathname === '/webhook' && req.method === 'GET') return verify(url, res)
    if (url.pathname === '/webhook' && req.method === 'POST') return receive(req, res)
    if (o.auth && (await o.auth(req, res, url))) return
    send(res, 404)
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('request_error', { error: err instanceof Error ? err.message : String(err) }, 'error')
      if (!res.headersSent) send(res, 500)
    })
  })
}
