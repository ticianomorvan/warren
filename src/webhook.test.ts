import { createHmac } from 'node:crypto'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { connect, migrate, type Sql } from './db'
import { createProcessor, REPLY_NON_TEXT, REPLY_TEXT } from './process'
import { createStore } from './store'
import { type Graph, GraphError } from './whatsapp/graph'
import { validSignature } from './whatsapp/signature'

const SECRET = 'app-secret'
const VERIFY = 'verify-token-123'

let pg: PGlite
let socket: PGLiteSocketServer
let sql: Sql

beforeAll(async () => {
  pg = await PGlite.create()
  socket = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 10 })
  await socket.start()
  const port = (socket as unknown as { server: { address(): AddressInfo } }).server.address().port
  sql = connect(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 })
  await migrate(sql)
  await migrate(sql) // idempotent
})

afterAll(async () => {
  await sql.end({ timeout: 1 })
  await socket.stop()
  await pg.close()
})

beforeEach(async () => {
  await sql`TRUNCATE reply, inbound_message RESTART IDENTITY CASCADE`
})

const sign = (raw: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`

type SendFn = (n: number) => Promise<string>

/** A Graph double that records calls. `send` and `typing` can be replaced to fail or to hang. */
function fakeGraph(o: { send?: SendFn; typing?: () => Promise<void> } = {}) {
  const calls = { typing: [] as string[], sent: [] as { to: string; body: string }[], attempts: 0 }
  const graph: Graph = {
    async markReadAndType(wamid) {
      calls.typing.push(wamid)
      await o.typing?.()
    },
    async sendText(to, body) {
      calls.attempts++
      const id = o.send ? await o.send(calls.attempts) : `wamid.OUT${calls.attempts}`
      calls.sent.push({ to, body })
      return id
    },
  }
  return { graph, calls }
}

async function setup(
  opts: { allowed?: string[]; fake?: ReturnType<typeof fakeGraph>; staleMs?: number } = {},
) {
  const fake = opts.fake ?? fakeGraph()
  const store = createStore(sql, { staleMs: opts.staleMs ?? 0, maxAttempts: 3 })
  const processor = createProcessor({
    store,
    graph: fake.graph,
    allowed: opts.allowed ?? ['*'],
    maxAttempts: 3,
  })
  const server = createApp({
    store,
    processor,
    config: { WHATSAPP_VERIFY_TOKEN: VERIFY, META_APP_SECRET: SECRET },
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    store,
    processor,
    calls: fake.calls,
    close: () => server.close(),
  }
}

const messageBody = (wamid: string, from = '5491100000000', extra: object = {}) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: wamid,
                  from,
                  timestamp: '1760000000',
                  type: 'text',
                  text: { body: 'café 3500' },
                  ...extra,
                },
              ],
            },
          },
        ],
      },
    ],
  })

const statusBody = (id: string, status: string, ts: number) =>
  JSON.stringify({
    entry: [{ changes: [{ value: { statuses: [{ id, status, timestamp: String(ts) }] } }] }],
  })

const post = (base: string, body: string, signature = sign(body, SECRET)) =>
  fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
  })

const settle = () => new Promise((r) => setTimeout(r, 150))
const count = async (table: 'inbound_message' | 'reply') =>
  Number((await sql.unsafe(`SELECT count(*) AS n FROM ${table}`))[0]?.n)
const seed = (wamid: string, cols = "status = 'pending'") =>
  sql.unsafe(`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload)
    VALUES ('${wamid}', '5491100000000', 'text', 'x', '{}'::jsonb);
    UPDATE inbound_message SET ${cols} WHERE wamid = '${wamid}'`)
const row = async (wamid: string) =>
  (await sql`SELECT * FROM inbound_message WHERE wamid = ${wamid}`)[0]

describe('webhook', () => {
  it('rejects a bad signature with 401 and stores nothing', async () => {
    const app = await setup()
    const body = messageBody('wamid.A')
    expect((await post(app.base, body, sign(body, 'wrong-secret'))).status).toBe(401)
    expect((await post(app.base, body, 'sha256=zz')).status).toBe(401)
    expect((await post(app.base, body, `sha256=${'0'.repeat(63)}`)).status).toBe(401)
    expect((await fetch(`${app.base}/webhook`, { method: 'POST', body })).status).toBe(401)
    await settle()
    expect(await count('inbound_message')).toBe(0)
    expect(app.calls.sent).toHaveLength(0)
    app.close()
  })

  it('validSignature accepts only 64 hex digits of the right HMAC', () => {
    const raw = Buffer.from('{}')
    expect(validSignature(raw, sign('{}', SECRET), SECRET)).toBe(true)
    expect(
      validSignature(raw, sign('{}', SECRET).toUpperCase().replace('SHA256', 'sha256'), SECRET),
    ).toBe(true)
    expect(validSignature(raw, `${sign('{}', SECRET)}00`, SECRET)).toBe(false)
    expect(validSignature(raw, undefined, SECRET)).toBe(false)
  })

  it('answers an unparsable URL with 400 and keeps serving', async () => {
    const app = await setup()
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: app.port, path: '//[' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(400)
    expect((await fetch(`${app.base}/health`)).status).toBe(200)
    app.close()
  })

  it('answers an oversized body with 413', async () => {
    const app = await setup()
    const res = await post(app.base, 'x'.repeat(1_100_000))
    expect(res.status).toBe(413)
    expect(await count('inbound_message')).toBe(0)
    app.close()
  })

  it('accepts a valid signature: 200, one row, one reply', async () => {
    const app = await setup()
    const res = await post(app.base, messageBody('wamid.B'))
    expect(res.status).toBe(200)
    await settle()
    const r = await row('wamid.B')
    expect(r).toMatchObject({ wa_id: '5491100000000', status: 'done', kind: 'text', attempts: 1 })
    expect(r?.typing_sent_at).toBeInstanceOf(Date)
    expect(r?.send_started_at).toBeInstanceOf(Date)
    expect(r?.reply_sent_at).toBeInstanceOf(Date)
    expect(r?.meta_ts).toEqual(new Date(1760000000 * 1000))
    expect(app.calls.typing).toEqual(['wamid.B'])
    expect(app.calls.sent).toEqual([{ to: '5491100000000', body: REPLY_TEXT }])
    const [reply] = await sql`SELECT * FROM reply`
    expect(reply).toMatchObject({ outbound_wamid: 'wamid.OUT1', inbound_id: r?.id })
    app.close()
  })

  it('dedupes a wamid delivered twice: one row, one reply', async () => {
    const app = await setup()
    const body = messageBody('wamid.C')
    expect((await post(app.base, body)).status).toBe(200)
    expect((await post(app.base, body)).status).toBe(200)
    await settle()
    expect(await count('inbound_message')).toBe(1)
    expect(app.calls.sent).toHaveLength(1)
    app.close()
  })

  it('processes rows a retried batch finds already stored and still pending', async () => {
    const app = await setup()
    await seed('wamid.RB') // stored by a batch that failed halfway
    expect((await post(app.base, messageBody('wamid.RB'))).status).toBe(200)
    await settle()
    expect((await row('wamid.RB'))?.status).toBe('done')
    expect(app.calls.sent).toHaveLength(1)
    app.close()
  })

  it('answers a non-text message with the short text reply', async () => {
    const app = await setup()
    await post(
      app.base,
      messageBody('wamid.D', '5491100000000', { type: 'image', text: undefined }),
    )
    await settle()
    expect(app.calls.sent).toEqual([{ to: '5491100000000', body: REPLY_NON_TEXT }])
    expect(await count('inbound_message')).toBe(1)
    app.close()
  })

  it('answers nobody when the allowlist is empty, and everybody with *', async () => {
    const none = await setup({ allowed: [] })
    await post(none.base, messageBody('wamid.N1'))
    await settle()
    expect((await row('wamid.N1'))?.status).toBe('ignored')
    expect(none.calls.sent).toHaveLength(0)
    none.close()

    const all = await setup({ allowed: ['*'] })
    await post(all.base, messageBody('wamid.N2'))
    await settle()
    expect((await row('wamid.N2'))?.status).toBe('done')
    all.close()
  })

  it('records but does not answer senders outside the allowlist', async () => {
    const app = await setup({ allowed: ['5491155550000'] })
    await post(app.base, messageBody('wamid.E', '5491100000000'))
    await post(app.base, messageBody('wamid.F', '5491155550000'))
    await settle()
    const rows = await sql`SELECT wamid, status FROM inbound_message ORDER BY id`
    expect(rows.map((r) => [r.wamid, r.status])).toEqual([
      ['wamid.E', 'ignored'],
      ['wamid.F', 'done'],
    ])
    expect(app.calls.sent.map((s) => s.to)).toEqual(['5491155550000'])
    app.close()
  })
})

describe('recovery', () => {
  it('a crash after the 200 leaves the row open and the sweep replies exactly once', async () => {
    const app = await setup()
    await seed('wamid.G')
    await seed(
      'wamid.H',
      "status = 'processing', attempts = 1, claimed_at = now() - interval '5 minutes'",
    )
    expect(await app.processor.sweep()).toBe(2)
    expect(await app.processor.sweep()).toBe(0)
    expect(app.calls.sent).toHaveLength(2)
    expect((await sql`SELECT status FROM inbound_message`).every((r) => r.status === 'done')).toBe(
      true,
    )
    app.close()
  })

  it('killed between a successful send and the commit: unknown, never sent again', async () => {
    const app = await setup()
    await seed(
      'wamid.I',
      "status = 'processing', attempts = 1, claimed_at = now() - interval '5 minutes', send_started_at = now() - interval '5 minutes'",
    )
    await app.processor.sweep()
    await app.processor.sweep()
    expect(app.calls.sent).toHaveLength(0)
    const r = await row('wamid.I')
    expect(r?.status).toBe('unknown')
    expect(r?.error).toContain('unknown')
    app.close()
  })

  it('an abort after Meta accepted the message is unknown and is not retried', async () => {
    const fake = fakeGraph({
      send: async () => {
        throw new DOMException('timeout', 'TimeoutError')
      },
    })
    const app = await setup({ fake })
    await post(app.base, messageBody('wamid.J'))
    await settle()
    expect((await row('wamid.J'))?.status).toBe('unknown')
    await app.processor.sweep()
    expect(fake.calls.attempts).toBe(1)
    app.close()
  })

  it('a 5xx or a 200 without an id on send is unknown, not retried', async () => {
    const fake = fakeGraph({
      send: async (n) => {
        throw n === 1 ? new GraphError(503, 'unavailable') : new GraphError(200, 'no message id')
      },
    })
    const app = await setup({ fake })
    await post(app.base, messageBody('wamid.K1'))
    await post(app.base, messageBody('wamid.K2'))
    await settle()
    expect((await row('wamid.K1'))?.status).toBe('unknown')
    expect((await row('wamid.K2'))?.status).toBe('unknown')
    await app.processor.sweep()
    expect(fake.calls.attempts).toBe(2)
    app.close()
  })

  it('a rate limit (4xx) proves nothing was sent: retried, then succeeds', async () => {
    const fake = fakeGraph({
      send: async (n) => {
        if (n === 1) throw new GraphError(400, 'pair rate limit', 131056)
        return 'wamid.OUTX'
      },
    })
    const app = await setup({ fake })
    await post(app.base, messageBody('wamid.L'))
    await settle()
    expect(await row('wamid.L')).toMatchObject({ status: 'pending', send_started_at: null })
    await app.processor.sweep()
    expect(await row('wamid.L')).toMatchObject({ status: 'done', attempts: 2 })
    expect(fake.calls.sent).toHaveLength(1)
    app.close()
  })

  it('a permanent error code fails at once; an auth error (190) is retried', async () => {
    const fake = fakeGraph({
      send: async (n) => {
        throw n === 1
          ? new GraphError(400, 'not allowed', 131026)
          : new GraphError(401, 'token', 190)
      },
    })
    const app = await setup({ fake })
    await post(app.base, messageBody('wamid.M1'))
    await settle()
    await post(app.base, messageBody('wamid.M2'))
    await settle()
    expect((await row('wamid.M1'))?.status).toBe('failed')
    expect((await row('wamid.M2'))?.status).toBe('pending')
    // M2 keeps failing with 190 until the attempts cap, then ends as failed.
    await app.processor.sweep()
    await app.processor.sweep()
    await app.processor.sweep()
    expect(await row('wamid.M2')).toMatchObject({ status: 'failed', attempts: 3 })
    app.close()
  })

  it('classifies Graph error codes', () => {
    const e = (http: number, code?: number) => new GraphError(http, 'x', code)
    for (const code of [100, 131026, 131047, 131051]) expect(e(400, code).retryable).toBe(false)
    for (const code of [4, 80007, 130429, 131048, 131056, 190])
      expect(e(400, code).retryable).toBe(true)
    expect(e(503).retryable).toBe(true)
    expect(e(429).retryable).toBe(true)
    expect(e(400, 999999).retryable).toBe(false)
    expect(e(401, 190).alert).toBe(true)
    expect(e(400, 4).alert).toBe(false)
    expect(e(400).notSent).toBe(true)
    expect(e(503).notSent).toBe(false)
    expect(e(200).notSent).toBe(false)
  })

  it('a slow worker whose row was taken over cannot send again or reopen the row', async () => {
    let release = () => {}
    const slow = new Promise<void>((r) => {
      release = r
    })
    let first = true
    const fake = fakeGraph({
      typing: async () => {
        if (first) {
          first = false
          await slow // worker A hangs before it starts to send
        }
      },
    })
    const app = await setup({ fake })
    await seed('wamid.S')
    const a = app.processor.kick(['wamid.S'])
    await settle()
    await app.processor.sweep() // B: the row is stale (staleMs 0), takes it over and finishes
    expect(await row('wamid.S')).toMatchObject({ status: 'done', attempts: 2 })
    release()
    await a
    expect(fake.calls.sent).toHaveLength(1)
    expect((await row('wamid.S'))?.status).toBe('done')

    // And a late failure from A's claim is refused.
    const stale = {
      id: Number((await row('wamid.S'))?.id),
      wamid: 'wamid.S',
      wa_id: 'x',
      kind: 'text',
      attempts: 1,
    }
    expect(await app.store.settle(stale, 'pending', 'late')).toBe(false)
    expect(await app.store.recordSendStarted(stale)).toBe(false)
    expect((await row('wamid.S'))?.status).toBe('done')
    app.close()
  })

  it('ends rows that ran out of attempts instead of leaving them open', async () => {
    const app = await setup()
    await seed('wamid.X1', "status = 'pending', attempts = 3")
    await seed(
      'wamid.X2',
      "status = 'processing', attempts = 3, claimed_at = now() - interval '5 minutes'",
    )
    await app.processor.sweep()
    expect((await row('wamid.X1'))?.status).toBe('failed')
    expect((await row('wamid.X2'))?.status).toBe('failed')
    expect(app.calls.sent).toHaveLength(0)
    app.close()
  })

  it('a row another worker holds is not taken twice', async () => {
    const app = await setup({ staleMs: 60_000 })
    await seed('wamid.Y')
    await Promise.all([app.processor.kick(['wamid.Y']), app.processor.kick(['wamid.Y'])])
    expect(app.calls.sent).toHaveLength(1)
    app.close()
  })

  it('drain waits for replies in flight, up to its limit', async () => {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fake = fakeGraph({
      send: async () => {
        await gate
        return 'wamid.OUTD'
      },
    })
    const app = await setup({ fake })
    await seed('wamid.Z')
    const work = app.processor.kick(['wamid.Z'])
    await settle()
    const t0 = Date.now()
    await app.processor.drain(100) // gives up
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90)
    expect((await row('wamid.Z'))?.status).toBe('processing')
    const drained = app.processor.drain(5000)
    release()
    await drained
    await work
    expect((await row('wamid.Z'))?.status).toBe('done')
    app.close()
  })
})

describe('status webhooks and verification', () => {
  it('update the reply atomically, in any order', async () => {
    const app = await setup()
    await post(app.base, messageBody('wamid.T'))
    await settle()
    await post(app.base, statusBody('wamid.OUT1', 'read', 1760000005))
    expect((await sql`SELECT * FROM reply`)[0]?.delivered_at).toEqual(new Date(1760000005 * 1000))
    await post(app.base, statusBody('wamid.OUT1', 'delivered', 1760000003))
    const [reply] = await sql`SELECT * FROM reply`
    expect(reply?.delivered_at).toEqual(new Date(1760000003 * 1000))
    expect(reply?.read_at).toEqual(new Date(1760000005 * 1000))
    expect(reply?.inbound_id).toBe((await row('wamid.T'))?.id)
    // A status for an unknown reply is kept, not dropped.
    await post(app.base, statusBody('wamid.EARLY', 'sent', 1760000001))
    await post(app.base, statusBody('wamid.EARLY', 'failed', 1760000002))
    expect(await count('reply')).toBe(2)
    expect(
      (await sql`SELECT failed_at FROM reply WHERE outbound_wamid = 'wamid.EARLY'`)[0]?.failed_at,
    ).toEqual(new Date(1760000002 * 1000))
    app.close()
  })

  it('verifies the subscription only with the right token', async () => {
    const app = await setup()
    const q = (token: string, mode = 'subscribe') =>
      fetch(`${app.base}/webhook?hub.mode=${mode}&hub.verify_token=${token}&hub.challenge=12345`)
    const ok = await q(VERIFY)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('12345')
    expect((await q('nope')).status).toBe(403)
    expect((await q(VERIFY, 'other')).status).toBe(403)
    expect((await fetch(`${app.base}/health`)).status).toBe(200)
    app.close()
  })
})
