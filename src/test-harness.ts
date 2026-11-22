import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createTestDatabase, sql, useDatabase } from '../test/db'
import { cafeMovement, fakeGraph, fakeModel } from '../test/fakes'
import { until } from '../test/until'
import type { Movement } from './agent'
import { type Auth, createAuth } from './auth/config'
import { createLinks } from './auth/link'
import { type AuthRoutes, createAuthRoutes } from './auth/routes'
import type { Sql } from './core/db'
import type { Store } from './store'
import type { Transcriber } from './transcribe'
import { createWarren } from './warren'

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
    /** The store the processor sees; the app keeps the real one. */
    processorStore?: (store: Store) => Store
    /** A database other than the one `useDatabase` set (the scenario eval owns its own). */
    sql?: Sql
    /** Turns on the OAuth server and the sign-in, on the test server's own origin (`auth.test.ts`). */
    auth?: { fetchClient?: Parameters<typeof createAuth>[0]['fetchClientMetadataResource'] }
    /** The clock the MCP tools read "today" from. */
    now?: () => Date
    /** The processor's clock (see `ProcessorOptions.clock`): a fixed past one by default, so a message's own time is "now". */
    clock?: () => Date
  } = {},
) {
  const fake = opts.fake ?? fakeGraph()
  const model = opts.model ?? fakeModel()
  const links = opts.auth ? createLinks(opts.sql ?? sql) : undefined
  // The OAuth server's issuer is the server's own origin, which is known only once it listens.
  let routes: AuthRoutes | undefined
  const { store, processor, makeProcessor, server } = createWarren({
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
    maxAttempts: 3,
    staleMs: opts.staleMs ?? 0,
    // Made-up message times (2025, 2026): the clock is before all of them, so a message's own time is "now" for a reminder.
    clock: opts.clock ?? (() => new Date(1760000000 * 1000)),
    interimMs: opts.interimMs ?? 60_000,
    deadlineMs: opts.deadlineMs ?? 120_000,
    ...(opts.processorStore ? { wrapStore: opts.processorStore } : {}),
    ...(opts.auth
      ? { authRoutes: (req, res, url) => routes?.(req, res, url) ?? Promise.resolve(false) }
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
      allowed: opts.allowed ?? ['*'],
      ...(opts.now ? { now: opts.now } : {}),
    })
  }
  return {
    auth,
    links,
    base,
    port,
    store,
    processor,
    makeProcessor,
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

export const settle = () => new Promise((r) => setTimeout(r, 150))
export const count = async (table: 'inbound_message' | 'reply' | 'account') =>
  Number((await sql.unsafe(`SELECT count(*) AS n FROM ${table}`))[0]?.n)
export const seed = (wamid: string, cols = "status = 'pending'") =>
  sql.unsafe(`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload)
    VALUES ('${wamid}', '5491100000000', 'text', 'x', '{}'::jsonb);
    UPDATE inbound_message SET ${cols} WHERE wamid = '${wamid}'`)
export const row = async (wamid: string) =>
  (await sql`SELECT * FROM inbound_message WHERE wamid = ${wamid}`)[0]

export { until }
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
