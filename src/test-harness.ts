import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type Anthropic from '@anthropic-ai/sdk'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { createApp } from './app'
import { connect, migrate, type Sql } from './db'
import type { Command, Movement } from './parse'
import { createProcessor } from './process'
import { createStore, type Store } from './store'
import { argentinaToday } from './time'
import type { Graph } from './whatsapp/graph'

export const SECRET = 'app-secret'
export const VERIFY = 'verify-token-123'

/** The test database, set by `useDatabase`: in-process PGlite behind a socket, or a real Postgres (`real`). Migrated. */
export let sql: Sql

/** A migrated database and how to shut it down. Needs no test runner, so the scenario eval can use it. */
export async function createTestDatabase(real?: { url: string; max: number }) {
  let pg: PGlite | undefined
  let socket: PGLiteSocketServer | undefined
  let url = real?.url
  if (!url) {
    pg = await PGlite.create()
    socket = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 10 })
    await socket.start()
    const port = (socket as unknown as { server: { address(): AddressInfo } }).server.address().port
    url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`
  }
  const db = connect(url, { max: real?.max ?? 1 })
  await migrate(db)
  await migrate(db) // idempotent
  return {
    sql: db,
    close: async () => {
      await db.end({ timeout: 1 })
      await socket?.stop()
      await pg?.close()
    },
  }
}

export function useDatabase(real?: { url: string; max: number }) {
  let close: (() => Promise<void>) | undefined
  beforeAll(async () => {
    const db = await createTestDatabase(real)
    sql = db.sql
    close = db.close
  })

  afterAll(async () => {
    await close?.()
  })

  beforeEach(async () => {
    await sql`TRUNCATE movement, reply, inbound_message, account RESTART IDENTITY CASCADE`
  })
}

export const sign = (raw: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`

export type SendFn = (n: number) => Promise<string>

/** A Graph double that records calls. `send` and `typing` can be replaced to fail or to hang. */
export function fakeGraph(o: { send?: SendFn; typing?: () => Promise<void> } = {}) {
  const calls = {
    typing: [] as string[],
    sent: [] as { to: string; body: string }[],
    attempts: 0,
  }
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

// The day comes from the message's own time (meta_ts), as in the processor, so midnight cannot flake.
export const TODAY = argentinaToday(new Date(1760000000 * 1000))
export const cafeMovement: Movement = {
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: TODAY,
  description: 'café',
  category: 'restaurantes',
  payment: 'visa',
  confidence: 'high',
}
export const cafe: Command = { type: 'log', movements: [cafeMovement] }

export type ModelFn = (signal: AbortSignal | undefined) => Promise<Command> | Command

/** An Anthropic double: `messages.parse` returns what `model` gives, or throws what it throws. */
export function fakeModel(model: ModelFn = () => cafe) {
  const calls = { n: 0 }
  const client = {
    messages: {
      parse: async (_params: unknown, options?: { signal?: AbortSignal }) => {
        calls.n++
        const parsed_output = await model(options?.signal)
        return {
          parsed_output,
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 10 },
        }
      },
    },
  } as unknown as Anthropic
  return { client, calls }
}

export async function setup(
  opts: {
    allowed?: string[]
    fake?: ReturnType<typeof fakeGraph>
    model?: ReturnType<typeof fakeModel>
    staleMs?: number
    interimMs?: number
    deadlineMs?: number
    helpContact?: string
    /** The store the processor sees; the app keeps the real one. */
    processorStore?: (store: Store) => Store
    /** A database other than the one `useDatabase` set (the scenario eval owns its own). */
    sql?: Sql
  } = {},
) {
  const fake = opts.fake ?? fakeGraph()
  const model = opts.model ?? fakeModel()
  const store = createStore(opts.sql ?? sql, { staleMs: opts.staleMs ?? 0, maxAttempts: 3 })
  const makeProcessor = (s: Store, client: Anthropic = model.client) =>
    createProcessor({
      store: s,
      graph: fake.graph,
      allowed: opts.allowed ?? ['*'],
      maxAttempts: 3,
      client,
      helpContact: opts.helpContact,
      interimMs: opts.interimMs ?? 60_000,
      deadlineMs: opts.deadlineMs ?? 120_000,
    })
  const processor = makeProcessor(opts.processorStore?.(store) ?? store)
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
    makeProcessor,
    calls: fake.calls,
    model: model.calls,
    close: () => server.close(),
  }
}

export const messageBody = (wamid: string, from = '5491100000000', extra: object = {}) =>
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

export const statusBody = (id: string, status: string, ts: number) =>
  JSON.stringify({
    entry: [{ changes: [{ value: { statuses: [{ id, status, timestamp: String(ts) }] } }] }],
  })

export const post = (base: string, body: string, signature = sign(body, SECRET)) =>
  fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
  })

export const settle = () => new Promise((r) => setTimeout(r, 150))
export const count = async (table: 'inbound_message' | 'reply' | 'account') =>
  Number((await sql.unsafe(`SELECT count(*) AS n FROM ${table}`))[0]?.n)
export const seed = (wamid: string, cols = "status = 'pending'") =>
  sql.unsafe(`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload)
    VALUES ('${wamid}', '5491100000000', 'text', 'x', '{}'::jsonb);
    UPDATE inbound_message SET ${cols} WHERE wamid = '${wamid}'`)
export const row = async (wamid: string) =>
  (await sql`SELECT * FROM inbound_message WHERE wamid = ${wamid}`)[0]

export const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}
export const doneCount = async (n: number) =>
  Number((await sql`SELECT count(*) AS n FROM inbound_message WHERE status = 'done'`)[0]?.n) === n
export const bodies = (calls: { sent: { body: string }[] }) => calls.sent.map((s) => s.body)
export const movements = () =>
  sql`SELECT direction, amount::text AS amount, currency, occurred_on::text AS on, description,
    category, payment, confidence, position FROM movement ORDER BY inbound_message_id, position`
export const gate = () => {
  let open = () => {}
  const promise = new Promise<void>((r) => {
    open = r
  })
  return { promise, open }
}
export const movement = (o: Partial<Movement> = {}): Movement => ({ ...cafeMovement, ...o })
