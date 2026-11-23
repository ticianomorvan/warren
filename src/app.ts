import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AuthRoutes } from './auth/routes'
import type { Config } from './config'
import { log } from './log'
import type { Ingest } from './whatsapp/ingest'
import { parseWebhook } from './whatsapp/payload'
import { safeEqual, validSignature } from './whatsapp/signature'
import type { Worker } from './whatsapp/worker'

const MAX_BODY = 1_000_000

export interface AppOptions {
  ingest: Ingest
  config: Pick<Config, 'WHATSAPP_VERIFY_TOKEN' | 'META_APP_SECRET'>
  worker: Worker
  /** The OAuth server's routes for MCP (docs/history/mcp-spec.md); without them none of its paths exist. */
  auth?: AuthRoutes
  /** `/mcp`: the MCP endpoint (its door, origin check and tools). Without it the path does not exist. */
  mcp?: (req: IncomingMessage, res: ServerResponse) => Promise<void>
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

/** Plain node:http: a few routes do not need a framework. */
export function createApp(o: AppOptions): Server {
  const { ingest, config, worker } = o

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
    const senders = [...new Set(messages.map((m) => m.from))]

    // Persist before answering: after the 200 Meta will not send this again. Every message goes in as `pending`; the worker decides
    // whether it is answered. If the batch fails halfway, the rows already stored are still processed now, and Meta's retry brings the rest.
    const fresh: typeof messages = []
    try {
      for (const m of messages) if (await ingest.message(m)) fresh.push(m)
      for (const s of statuses) await ingest.status(s)
    } catch (err) {
      void worker.kick(senders)
      throw err
    }

    send(res, 200)
    // The first signal, on receipt: for each message stored for the first time, before its lane has a turn.
    void worker.acknowledge(fresh)
    // A retried batch has rows that are already stored but still pending: the lanes claim them too.
    void worker.kick(senders)
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
    if (url.pathname === '/mcp' && o.mcp) return o.mcp(req, res)
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
