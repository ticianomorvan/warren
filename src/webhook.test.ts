import type { AddressInfo } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { connect, migrate, type Sql } from './db'
import { createProcessor, REPLY_NON_TEXT, REPLY_TEXT } from './process'
import { type Graph, GraphError } from './whatsapp/graph'
import { sign } from './whatsapp/signature'

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

/** A Graph double that records calls; `failWith` makes sendText throw. */
function fakeGraph(failWith?: Error) {
  const calls = { typing: [] as string[], sent: [] as { to: string; body: string }[] }
  const graph: Graph = {
    async markReadAndType(wamid) {
      calls.typing.push(wamid)
    },
    async sendText(to, body) {
      if (failWith) throw failWith
      calls.sent.push({ to, body })
      return `wamid.OUT${calls.sent.length}`
    },
  }
  return { graph, calls }
}

async function setup(opts: { allowed?: string[]; graph?: Graph; staleMs?: number } = {}) {
  const fake = fakeGraph()
  const processor = createProcessor({
    sql,
    graph: opts.graph ?? fake.graph,
    staleMs: opts.staleMs ?? 0,
    maxAttempts: 3,
  })
  const server = createApp({
    sql,
    processor,
    config: {
      WHATSAPP_VERIFY_TOKEN: VERIFY,
      META_APP_SECRET: SECRET,
      ALLOWED_WA_IDS: opts.allowed ?? [],
    },
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, server, processor, calls: fake.calls, close: () => server.close() }
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

const post = (base: string, body: string, signature = sign(body, SECRET)) =>
  fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
  })

const settle = () => new Promise((r) => setTimeout(r, 150))
const count = async (table: 'inbound_message' | 'reply') =>
  Number((await sql.unsafe(`SELECT count(*) AS n FROM ${table}`))[0]?.n)

describe('webhook', () => {
  it('rejects a bad signature with 401 and stores nothing', async () => {
    const app = await setup()
    const body = messageBody('wamid.A')
    const res = await post(app.base, body, sign(body, 'wrong-secret'))
    expect(res.status).toBe(401)
    expect((await post(app.base, body, 'sha256=zz')).status).toBe(401)
    expect((await fetch(`${app.base}/webhook`, { method: 'POST', body })).status).toBe(401)
    await settle()
    expect(await count('inbound_message')).toBe(0)
    expect(app.calls.sent).toHaveLength(0)
    app.close()
  })

  it('accepts a valid signature: 200, one row, one reply', async () => {
    const app = await setup()
    const res = await post(app.base, messageBody('wamid.B'))
    expect(res.status).toBe(200)
    await settle()
    const [row] = await sql`SELECT * FROM inbound_message`
    expect(row).toMatchObject({
      wamid: 'wamid.B',
      wa_id: '5491100000000',
      status: 'done',
      kind: 'text',
    })
    expect(row?.typing_sent_at).toBeInstanceOf(Date)
    expect(row?.reply_sent_at).toBeInstanceOf(Date)
    expect(row?.meta_ts).toEqual(new Date(1760000000 * 1000))
    expect(app.calls.typing).toEqual(['wamid.B'])
    expect(app.calls.sent).toEqual([{ to: '5491100000000', body: REPLY_TEXT }])
    const [reply] = await sql`SELECT * FROM reply`
    expect(reply).toMatchObject({ outbound_wamid: 'wamid.OUT1', inbound_wamid: 'wamid.B' })
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

  it('a crash after the 200 leaves the row open and the sweep replies exactly once', async () => {
    const app = await setup()
    // The row was persisted and the 200 returned, then the process died before sending.
    await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, received_at)
      VALUES ('wamid.G', '5491100000000', 'text', 'x', '{}'::jsonb, 'pending', now())`
    await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, attempts, claimed_at, received_at)
      VALUES ('wamid.H', '5491100000000', 'text', 'x', '{}'::jsonb, 'processing', 1, now() - interval '5 minutes', now())`
    expect(await app.processor.sweep()).toBe(2)
    expect(await app.processor.sweep()).toBe(0)
    expect(app.calls.sent).toHaveLength(2)
    const rows = await sql`SELECT status FROM inbound_message`
    expect(rows.every((r) => r.status === 'done')).toBe(true)
    app.close()
  })

  it('does not send twice when the crash came after the send', async () => {
    const app = await setup()
    await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, attempts, claimed_at, reply_sent_at, received_at)
      VALUES ('wamid.I', '5491100000000', 'text', 'x', '{}'::jsonb, 'processing', 1, now() - interval '5 minutes', now(), now())`
    await app.processor.sweep()
    expect(app.calls.sent).toHaveLength(0)
    const [row] = await sql`SELECT status FROM inbound_message`
    expect(row?.status).toBe('done')
    app.close()
  })

  it('a row another worker holds is not taken twice', async () => {
    const app = await setup({ staleMs: 60_000 })
    await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, received_at)
      VALUES ('wamid.J', '5491100000000', 'text', 'x', '{}'::jsonb, 'pending', now())`
    await Promise.all([app.processor.processOne('wamid.J'), app.processor.processOne('wamid.J')])
    expect(app.calls.sent).toHaveLength(1)
    app.close()
  })

  it('marks a permanent Graph error failed and never retries it', async () => {
    const failing = fakeGraph(new GraphError(400, '131030 recipient not allowed'))
    const app = await setup({ graph: failing.graph })
    await post(app.base, messageBody('wamid.K'))
    await settle()
    const [row] = await sql`SELECT status, error, attempts FROM inbound_message`
    expect(row).toMatchObject({ status: 'failed', attempts: 1 })
    expect(row?.error).toContain('131030')
    expect(await app.processor.sweep()).toBe(0)
    app.close()
  })

  it('retries a transient error up to the attempts cap, then fails', async () => {
    const failing = fakeGraph(new GraphError(503, 'unavailable'))
    const app = await setup({ graph: failing.graph })
    await post(app.base, messageBody('wamid.L'))
    await settle()
    await app.processor.sweep()
    await app.processor.sweep()
    await app.processor.sweep()
    const [row] = await sql`SELECT status, attempts FROM inbound_message`
    expect(row).toMatchObject({ status: 'failed', attempts: 3 })
    app.close()
  })

  it('status webhooks update the reply, in any order', async () => {
    const app = await setup()
    await post(app.base, messageBody('wamid.M'))
    await settle()
    const status = (s: string, ts: number) =>
      JSON.stringify({
        entry: [
          {
            changes: [
              { value: { statuses: [{ id: 'wamid.OUT1', status: s, timestamp: String(ts) }] } },
            ],
          },
        ],
      })
    await post(app.base, status('read', 1760000005))
    await post(app.base, status('delivered', 1760000003))
    const [reply] = await sql`SELECT * FROM reply`
    expect(reply?.delivered_at).toEqual(new Date(1760000003 * 1000))
    expect(reply?.read_at).toEqual(new Date(1760000005 * 1000))
    expect(reply?.inbound_wamid).toBe('wamid.M')
    // A status for an unknown reply is kept, not dropped.
    await post(
      app.base,
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [{ id: 'wamid.EARLY', status: 'sent', timestamp: '1760000001' }],
                },
              },
            ],
          },
        ],
      }),
    )
    expect(await count('reply')).toBe(2)
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
