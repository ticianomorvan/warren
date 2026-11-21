import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Config } from './config'
import type { Sql } from './db'
import { log } from './log'
import type { Processor } from './process'
import { parseWebhook } from './whatsapp/payload'
import { validSignature } from './whatsapp/signature'

const MAX_BODY = 1_000_000

export interface AppOptions {
  sql: Sql
  config: Pick<Config, 'WHATSAPP_VERIFY_TOKEN' | 'META_APP_SECRET' | 'ALLOWED_WA_IDS'>
  processor: Processor
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function send(res: ServerResponse, status: number, body = '', type = 'text/plain'): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

const seconds = (n: number | undefined) => (n === undefined ? null : new Date(n * 1000))

/** Plain node:http: three routes do not need a framework. */
export function createApp(o: AppOptions): Server {
  const { sql, config, processor } = o

  async function verify(url: URL, res: ServerResponse) {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token') ?? ''
    const challenge = url.searchParams.get('hub.challenge') ?? ''
    if (mode === 'subscribe' && safeEqual(token, config.WHATSAPP_VERIFY_TOKEN)) {
      return send(res, 200, challenge)
    }
    send(res, 403)
  }

  async function receive(req: IncomingMessage, res: ServerResponse) {
    const receivedAt = new Date()
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
    const allowed = config.ALLOWED_WA_IDS
    const fresh: string[] = []

    // Persist before answering: after the 200 Meta will not send this again.
    for (const m of messages) {
      const permitted = allowed.length === 0 || allowed.includes(m.from)
      const [row] = await sql<{ wamid: string }[]>`
        INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, meta_ts, received_at)
        VALUES (${m.id}, ${m.from}, ${m.type}, ${m.text?.body ?? null}, ${sql.json(m.raw as never)},
                ${permitted ? 'pending' : 'ignored'}, ${seconds(m.timestamp)}, ${receivedAt})
        ON CONFLICT (wamid) DO NOTHING
        RETURNING wamid`
      if (!row) continue
      log('message_received', { wamid: m.id, kind: m.type, permitted })
      if (permitted) fresh.push(m.id)
    }
    for (const s of statuses) {
      const at = seconds(s.timestamp) ?? new Date()
      await sql`
        INSERT INTO reply (outbound_wamid, delivered_at, read_at, failed_at)
        VALUES (${s.id},
                ${s.status === 'delivered' ? at : null},
                ${s.status === 'read' ? at : null},
                ${s.status === 'failed' ? at : null})
        ON CONFLICT (outbound_wamid) DO UPDATE SET
          delivered_at = LEAST(reply.delivered_at, EXCLUDED.delivered_at),
          read_at = COALESCE(reply.read_at, EXCLUDED.read_at),
          failed_at = COALESCE(reply.failed_at, EXCLUDED.failed_at)`
      // A read implies it was delivered; Meta may skip the delivered event.
      if (s.status === 'read') {
        await sql`UPDATE reply SET delivered_at = COALESCE(delivered_at, ${at}) WHERE outbound_wamid = ${s.id}`
      }
    }

    send(res, 200)
    for (const wamid of fresh) {
      processor
        .processOne(wamid)
        .catch((err) => log('process_crash', { wamid, error: String(err) }))
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route =
      url.pathname === '/health' && req.method === 'GET'
        ? async () => send(res, 200, 'ok')
        : url.pathname === '/webhook' && req.method === 'GET'
          ? () => verify(url, res)
          : url.pathname === '/webhook' && req.method === 'POST'
            ? () => receive(req, res)
            : async () => send(res, 404)
    route().catch((err) => {
      log('request_error', { error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) send(res, 500)
    })
  })
}
