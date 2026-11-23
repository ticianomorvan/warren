import { createHmac } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTestDatabase, sql, useDatabase } from '../test/db'
import { cafeMovement, fakeGraph, fakeModel, type ToolCall } from '../test/fakes'
import { until } from '../test/until'
import { type Auth, createAuth } from './auth/config'
import { createLinks } from './auth/link'
import { type AuthRoutes, createAuthRoutes } from './auth/routes'
import type { Movement } from './core/commands'
import type { Sql } from './core/db'
import { commit } from './core/turn'
import { createDoor } from './mcp/door'
import { createMcpEndpoint } from './mcp/endpoint'
import type { Transcriber } from './transcribe'
import { createWarren } from './warren'
import { accountFor } from './whatsapp/ingest'

/**
 * v1's harness: what the old tests import. The pieces live in `test/` now (db, fakes, until); this file
 * keeps `setup` and the v1 helpers, and re-exports the rest until the slices that rewrite those tests.
 */
export * from '../test/fakes'
export { createTestDatabase, sql, useDatabase }

export const SECRET = 'app-secret'
export const AUTH_SECRET = 'test-secret-for-better-auth-0123456789abcdef'
export const DISPLAY_NUMBER = '+54 9 11 5555-0000'
export const VERIFY = 'verify-token-123'

export const sign = (raw: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`

export async function setup(
  opts: {
    allowed?: string[]
    fake?: ReturnType<typeof fakeGraph>
    model?: ReturnType<typeof fakeModel>
    staleMs?: number
    interimMs?: number
    deadlineMs?: number
    helpContact?: string
    transcriber?: Transcriber
    /** A database other than the one `useDatabase` set (the scenario eval owns its own). */
    sql?: Sql
    /** Turns on the OAuth server and the sign-in, on the test server's own origin (`auth.test.ts`). */
    auth?: { fetchClient?: Parameters<typeof createAuth>[0]['fetchClientMetadataResource'] }
    /** The worker's clock (see `WorkerOptions.clock`): a fixed past one by default, so a message's own time is "now". */
    clock?: () => Date
  } = {},
) {
  const fake = opts.fake ?? fakeGraph()
  const model = opts.model ?? fakeModel()
  const links = opts.auth ? createLinks(opts.sql ?? sql) : undefined
  // The OAuth server's issuer is the server's own origin, which is known only once it listens.
  let routes: AuthRoutes | undefined
  let mcp: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const { ingest, worker, makeWorker, server } = createWarren({
    sql: opts.sql ?? sql,
    config: {
      WHATSAPP_VERIFY_TOKEN: VERIFY,
      META_APP_SECRET: SECRET,
      ALLOWED_WA_IDS: opts.allowed ?? ['*'],
      HELP_CONTACT: opts.helpContact,
      REMINDER_TEMPLATE: undefined,
    },
    graph: fake.graph,
    client: model.client,
    transcriber: opts.transcriber,
    signIn: opts.auth !== undefined,
    publicHost: () => new URL(base).host,
    maxAttempts: 3,
    staleMs: opts.staleMs ?? 60_000,
    // Made-up message times (2025, 2026): the clock is before all of them, so a message's own time is "now" for a reminder.
    clock: opts.clock ?? (() => new Date(1760000000 * 1000)),
    interimMs: opts.interimMs ?? 60_000,
    deadlineMs: opts.deadlineMs ?? 120_000,
    ...(opts.auth
      ? {
          authRoutes: (req, res, url) => routes?.(req, res, url) ?? Promise.resolve(false),
          mcp: (req, res) => mcp?.(req, res) ?? Promise.resolve(),
        }
      : {}),
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  let auth: Auth | undefined
  if (opts.auth && links) {
    const db = opts.sql ?? sql
    auth = createAuth({
      sql: db,
      publicUrl: base,
      secret: AUTH_SECRET,
      links,
      fetchClientMetadataResource: opts.auth.fetchClient,
    })
    routes = createAuthRoutes({
      auth,
      sql: db,
      links,
      publicUrl: base,
      displayNumber: DISPLAY_NUMBER,
    })
    mcp = createMcpEndpoint({
      door: createDoor({ auth, sql: db, publicUrl: base, allowed: opts.allowed ?? ['*'] }),
      sql: db,
      publicUrl: base,
      // The same fixed clock as the worker's: an MCP write and a WhatsApp message made "now" are in the same day and the undo window.
      now: opts.clock ?? (() => new Date(1760000000 * 1000)),
    })
  }
  return {
    auth,
    links,
    base,
    port,
    ingest,
    worker,
    makeWorker,
    calls: fake.calls,
    model: model.calls,
    requests: model.requests,
    close: () => server.close(),
  }
}

/** A webhook with one photo: its media id and caption, no bytes (those come from the Graph by id). */
export const photoBody = (
  wamid: string,
  mediaId: string,
  caption?: string,
  from = '5491100000000',
  timestamp = '1760000000',
) =>
  messageBody(wamid, from, {
    type: 'image',
    timestamp,
    text: undefined,
    image: { id: mediaId, mime_type: 'image/jpeg', ...(caption ? { caption } : {}) },
  })

/** A webhook with one voice note: its media id and type, no bytes. */
export const voiceBody = (
  wamid: string,
  mediaId: string,
  from = '5491100000000',
  timestamp = '1760000000',
) =>
  messageBody(wamid, from, {
    type: 'audio',
    timestamp,
    text: undefined,
    audio: { id: mediaId, mime_type: 'audio/ogg; codecs=opus', voice: true },
  })

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

/**
 * Gives the worker time to finish what it started: 150 ms, then, for up to 2 s, as long as a row it claimed in the last seconds is
 * still `processing` (a loaded machine takes longer than the fixed pause; a row seeded as abandoned has an old claim and does not wait).
 */
export async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150))
  const end = Date.now() + 2000
  while (Date.now() < end) {
    const busy = await sql`
      SELECT 1 FROM wa_message WHERE status = 'processing' AND claimed_at > now() - interval '5 seconds' LIMIT 1`
    if (busy.length === 0) return
    await new Promise((r) => setTimeout(r, 25))
  }
}
export const count = async (table: 'wa_message' | 'reply' | 'account' | 'turn' | 'movement') =>
  Number((await sql.unsafe(`SELECT count(*) AS n FROM ${table}`))[0]?.n)
/** A message row as the webhook leaves it (`pending` unless `cols` says otherwise), for a sender (default the test's usual one). */
export const seed = (wamid: string, cols = "status = 'pending'", from = '5491100000000') =>
  sql.unsafe(
    `INSERT INTO wa_message (wamid, wa_id, kind, text) VALUES ('${wamid}', '${from}', 'text', 'x');
    UPDATE wa_message SET ${cols} WHERE wamid = '${wamid}'`,
  )
export const row = async (wamid: string) =>
  (await sql`SELECT * FROM wa_message WHERE wamid = ${wamid}`)[0]

export { until }
export const doneCount = async (n: number) =>
  Number((await sql`SELECT count(*) AS n FROM wa_message WHERE status = 'done'`)[0]?.n) === n
export const bodies = (calls: { sent: { body: string }[] }) => calls.sent.map((s) => s.body)
/** The live movements, oldest first, as plain values. */
export const movements = () =>
  sql`SELECT direction, amount::text AS amount, currency, occurred_on::text AS on, description,
    category, payment, confidence FROM movement WHERE ended_at IS NULL ORDER BY id`
export const gate = () => {
  let open = () => {}
  const promise = new Promise<void>((r) => {
    open = r
  })
  return { promise, open }
}
export const movement = (o: Partial<Movement> = {}): Movement => ({ ...cafeMovement, ...o })

// ---- Fixtures of the channel tests: scripted models, seeded movements, one message in and its reply out.

/** The usual sender. */
export const WA = '5491100000000'
/** The model forgets everything the person told Warren (code asks "¿Seguro?"). */
export const forgetAll: ToolCall = { name: 'forget_all_facts', input: {} }

export type App = Awaited<ReturnType<typeof setup>>

let n = 0
export let lastWamid = ''
/** One message in, waits until its reply is out and recorded. Returns that reply. */
export async function say(
  app: App,
  o: { at?: string; text?: string; from?: string } = {},
): Promise<string> {
  const wamid = `wamid.CMD${++n}`
  lastWamid = wamid
  const before = app.calls.sent.length
  const extra = {
    ...(o.at ? { timestamp: String(Math.floor(Date.parse(o.at) / 1000)) } : {}),
    ...(o.text ? { text: { body: o.text } } : {}),
  }
  await post(app.base, messageBody(wamid, o.from ?? WA, extra))
  await until(async () => (await row(wamid))?.status === 'done')
  return bodies(app.calls)[before] ?? ''
}

/** A model that answers each call with the next turn: a list of tool calls. A bare call is a turn of one. */
export const script = (...turns: (ToolCall | ToolCall[])[]) => {
  let i = 0
  return fakeModel(() => [turns[i++] ?? []].flat())
}

/** The account of a WhatsApp id, made the way the webhook makes it. */
export const accountOfWa = (waId: string, db: Sql = sql) => accountFor(db, waId)

export type SeedRow = {
  on: string
  amount: string
  currency?: Movement['currency']
  direction?: Movement['direction']
  category?: Movement['category']
  payment?: string
  description?: string
}
/**
 * Stores movements as if earlier messages of `from` had logged them (one committed turn, at the message time of the tests). Returns
 * their ids (the `entity_id` the model sees), in order.
 */
export async function seedMovements(rows: SeedRow[], from = WA): Promise<number[]> {
  const accountId = await accountFor(sql, from)
  const movements = rows.map(
    (r): Movement => ({
      direction: r.direction ?? 'out',
      amount: r.amount,
      currency: r.currency ?? 'ARS',
      date: r.on,
      description: r.description ?? 'algo',
      category: r.category ?? 'otros',
      ...(r.payment ? { payment: r.payment } : {}),
      confidence: 'high',
    }),
  )
  await commit(sql, {
    accountId,
    channel: 'whatsapp',
    now: new Date(1759999000 * 1000),
    calls: [{ tool: 'log_movements', input: { movements } }],
    compose: () => ({ reply: 'seed' }),
  })
  const ids = await sql<{ id: number }[]>`
    SELECT entity_id::int AS id FROM movement WHERE account_id = ${accountId} ORDER BY id DESC LIMIT ${rows.length}`
  return ids.map((r) => r.id).reverse()
}
