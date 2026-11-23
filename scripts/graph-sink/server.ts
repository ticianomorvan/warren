/**
 * A stand-in for Meta's Graph API, for staging and the probe. It accepts the calls Warren makes (send text, send
 * template, read-and-typing, media lookup and download), records each one, and lets the probe read what was sent.
 * Node built-ins only; nothing here reaches a real phone.
 *
 *   POST /:version/:phoneId/messages   send, typing and read (Graph's shapes; answers a fake wamid)
 *   GET  /:version/:mediaId            media lookup, answers the url of a fixture
 *   GET  /media/:name                  the fixture bytes (voice.ogg, receipt.png)
 *   GET  /sent?since=N                 what was recorded after sequence N (needs SINK_TOKEN)
 *   GET  /health
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Sent {
  seq: number
  at: string
  kind: 'text' | 'template' | 'typing'
  to?: string
  /** Text: the body. Template: its name and parameters as JSON. Typing: the wamid it was for. */
  body: string
  wamid?: string
}

const FIXTURES: Record<string, { file: string; type: string }> = {
  'fixture-voice': { file: 'voice.ogg', type: 'audio/ogg' },
  'fixture-photo': { file: 'receipt.png', type: 'image/png' },
}
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function createSink(opts: { token: string }) {
  if (!opts.token)
    throw new Error('SINK_TOKEN is required: /sent shows every message the sink recorded')
  const log: Sent[] = []
  let seq = 0
  const record = (s: Omit<Sent, 'seq' | 'at'>) => {
    log.push({ seq: ++seq, at: new Date().toISOString(), ...s })
  }
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    let n = 0
    for await (const c of req) {
      n += (c as Buffer).length
      if (n > 1_000_000) throw new Error('too big')
      chunks.push(c as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'sink'}`)
    const path = url.pathname
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true })
    if (req.method === 'GET' && path === '/sent') {
      if (req.headers.authorization !== `Bearer ${opts.token}`)
        return json(res, 401, { error: 'unauthorized' })
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      return json(res, 200, { last: seq, sent: log.filter((s) => s.seq > since) })
    }
    const media = /^\/media\/([\w.-]+)$/.exec(path)
    if (req.method === 'GET' && media) {
      const f = Object.values(FIXTURES).find((x) => x.file === media[1])
      if (!f) return json(res, 404, { error: 'no such media' })
      res.writeHead(200, { 'content-type': f.type }).end(readFileSync(join(dir, f.file)))
      return
    }
    const lookup = /^\/v\d+\.\d+\/([\w-]+)$/.exec(path)
    if (req.method === 'GET' && lookup) {
      const f = FIXTURES[lookup[1] as string]
      if (!f) return json(res, 404, { error: { message: 'unknown media', code: 100 } })
      const proto = req.headers['x-forwarded-proto'] ?? 'http'
      return json(res, 200, {
        url: `${proto}://${req.headers.host}/media/${f.file}`,
        mime_type: f.type,
        file_size: readFileSync(join(dir, f.file)).length,
      })
    }
    if (req.method === 'POST' && /^\/v\d+\.\d+\/[\w-]+\/messages$/.test(path)) {
      let b: Record<string, any>
      try {
        b = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: { message: 'bad json', code: 100 } })
      }
      if (b.status === 'read') {
        record({ kind: 'typing', body: String(b.message_id) })
        return json(res, 200, { success: true })
      }
      const wamid = `wamid.SINK${Date.now().toString(36)}${seq}`
      if (b.type === 'text')
        record({ kind: 'text', to: b.to, body: String(b.text?.body ?? ''), wamid })
      else if (b.type === 'template') {
        const params = (b.template?.components?.[0]?.parameters ?? []).map(
          (p: { text?: string }) => p.text,
        )
        record({
          kind: 'template',
          to: b.to,
          body: JSON.stringify({ name: b.template?.name, params }),
          wamid,
        })
      } else return json(res, 400, { error: { message: 'unsupported type', code: 100 } })
      return json(res, 200, { messaging_product: 'whatsapp', messages: [{ id: wamid }] })
    }
    json(res, 404, { error: 'not found' })
  }

  return createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'sink error' })
      else res.end()
    })
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4000)
  createSink({ token: process.env.SINK_TOKEN ?? '' }).listen(port, () =>
    console.log(`graph-sink on ${port}`),
  )
}
