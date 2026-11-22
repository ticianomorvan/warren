import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type Anthropic from '@anthropic-ai/sdk'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import type { Movement } from './agent'
import { createApp } from './app'
import { type Auth, createAuth } from './auth/config'
import { createLinks } from './auth/link'
import { type AuthRoutes, createAuthRoutes } from './auth/routes'
import { connect, migrate, type Sql } from './db'
import { createProcessor } from './process'
import { createStore, type Store } from './store'
import { argentinaToday } from './time'
import type { Segment, Transcriber, Transcript } from './transcribe'
import {
  type Audio,
  checkAudio,
  checkImage,
  type Graph,
  type Image,
  MediaError,
} from './whatsapp/graph'

export const SECRET = 'app-secret'
export const AUTH_SECRET = 'test-secret-for-better-auth-0123456789abcdef'
export const DISPLAY_NUMBER = '+54 9 11 5555-0000'
export const VERIFY = 'verify-token-123'

/** The test database, set by `useDatabase`: in-process PGlite behind a socket, or a real Postgres (`real`). Migrated. */
export let sql: Sql

/** A migrated database and how to shut it down. Needs no test runner, so the scenario eval can use it. */
export async function createTestDatabase(real?: { url?: string; max?: number; schema?: string }) {
  let pg: PGlite | undefined
  let socket: PGLiteSocketServer | undefined
  let url = real?.url
  // A real Postgres can be shared by several test files: one that names a schema gets its own, rebuilt each run.
  if (url && real?.schema) {
    const admin = connect(url, { max: 1 })
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${real.schema} CASCADE; CREATE SCHEMA ${real.schema}`)
    await admin.end({ timeout: 1 })
  }
  if (!url) {
    pg = await PGlite.create()
    socket = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 10 })
    await socket.start()
    const port = (socket as unknown as { server: { address(): AddressInfo } }).server.address().port
    url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`
  }
  const db = connect(url, {
    max: real?.max ?? 1,
    ...(real?.url && real.schema ? { connection: { search_path: real.schema } } : {}),
  })
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

export function useDatabase(real?: { url?: string; max?: number; schema?: string }) {
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
    await sql`TRUNCATE link_request, auth_oauth_access_token, auth_oauth_refresh_token, auth_oauth_consent,
      auth_oauth_client_resource, auth_oauth_client_assertion, auth_oauth_resource, auth_oauth_client, auth_session,
      auth_account, auth_verification, auth_jwks, auth_user,
      fact, movement, reply, inbound_message, account RESTART IDENTITY CASCADE`
  })
}

export const sign = (raw: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`

export type SendFn = (n: number) => Promise<string>

/** A photo or voice note the fake Graph serves under a media id: its bytes, or the error its download raises. */
export type FakeMedia = Uint8Array | Error

/**
 * A Graph double that records calls. `send` and `typing` can be replaced to fail or to hang; `media`
 * holds the photos by media id. A photo goes through the same limits as the real download (`checkImage`).
 */
export function fakeGraph(
  o: {
    send?: SendFn
    typing?: () => Promise<void>
    media?: Record<string, FakeMedia>
    /** Holds a download until it resolves. */
    download?: () => Promise<void>
  } = {},
) {
  const calls = {
    typing: [] as string[],
    sent: [] as { to: string; body: string }[],
    downloads: [] as string[],
    /** The abort signal each download was given: the message's own deadline. */
    signals: [] as (AbortSignal | undefined)[],
    attempts: 0,
  }
  const graph: Graph = {
    async markReadAndType(wamid) {
      calls.typing.push(wamid)
      await o.typing?.()
    },
    async fetchImage(mediaId): Promise<Image> {
      calls.downloads.push(mediaId)
      await o.download?.()
      const media = o.media?.[mediaId]
      if (media === undefined) throw new MediaError('unavailable', 'no such media')
      if (media instanceof Error) throw media
      return checkImage(media)
    },
    async fetchAudio(mediaId, signal): Promise<Audio> {
      calls.downloads.push(mediaId)
      calls.signals.push(signal)
      await o.download?.()
      const media = o.media?.[mediaId]
      if (media === undefined) throw new MediaError('unavailable', 'no such media')
      if (media instanceof Error) throw media
      return checkAudio(media)
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

/** The bytes of a tiny Ogg file: enough to pass the fake Graph's limits (`checkAudio` reads the type from them). */
export const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0])

/** One segment the way the service measures a good, clear one (Ticiano's real notes: -0.18 to -0.25, 0.76 to 1.06). */
export const CLEAR: Segment = {
  start: 0,
  end: 4,
  avg_logprob: -0.2,
  compression_ratio: 1,
  no_speech_prob: 0.005,
}
/** What the service gives for a note: the text and its one segment, clear unless `segment` says otherwise. */
export const heard = (text: string, segment: Partial<Segment> = {}): Transcript => ({
  text: ` ${text}`,
  segments: [{ ...CLEAR, ...segment }],
})

/** A transcription answer: what is heard, an error to throw, or a function (to hold or inspect the call). */
export type FakeHeard = Transcript | Error | ((signal?: AbortSignal) => Promise<Transcript>)

/** A transcription double that records what it was given. A list answers call by call, the last one for the rest. */
export function fakeTranscriber(answer: FakeHeard | FakeHeard[] = heard('café 3500')) {
  const calls: { audio: Audio }[] = []
  const transcriber: Transcriber = {
    async transcribe(audio, signal) {
      calls.push({ audio })
      const now = Array.isArray(answer) ? (answer[calls.length - 1] ?? answer.at(-1)) : answer
      const result = typeof now === 'function' ? await now(signal) : now
      if (result === undefined) throw new Error('no answer scripted')
      if (result instanceof Error) throw result
      return result
    },
  }
  return { transcriber, calls }
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
/** One tool call a scripted model makes. */
export type ToolCall = { name: string; input: unknown }
export const logCall = (...movements: Movement[]): ToolCall => ({
  name: 'log_movements',
  input: { movements, text: null },
})
/** The model answers in its own words. */
export const replyCall = (text: string): ToolCall => ({ name: 'reply', input: { text } })
/** The model asks for the canned help text. */
export const helpCall: ToolCall = { name: 'help', input: {} }
/** What a model returns for "café 3500". */
export const cafe: ToolCall[] = [logCall(cafeMovement)]

/** What a scripted model sees of one request: its number (from 1) and the params the loop sent. */
export type ModelRequest = { n: number; params: Anthropic.MessageCreateParamsNonStreaming }
/** One model turn: the tool calls it makes. */
export type ModelFn = (
  signal: AbortSignal | undefined,
  request: ModelRequest,
) => Promise<ToolCall[]> | ToolCall[]

/**
 * An Anthropic double: `messages.create` answers each request with the tool calls `model` gives, or
 * throws what it throws. `requests` keeps every request the loop sent, to look at its context.
 */
export function fakeModel(model: ModelFn = () => cafe) {
  const calls = { n: 0 }
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []
  const client = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal },
      ) => {
        calls.n++
        requests.push(structuredClone(params))
        const turn = await model(options?.signal, { n: calls.n, params })
        return {
          content: turn.map((c, k) => ({
            type: 'tool_use',
            id: `toolu_${calls.n}_${k}`,
            name: c.name,
            input: c.input,
          })),
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 10 },
        }
      },
    },
  } as unknown as Anthropic
  return { client, calls, requests }
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
    transcriber?: Transcriber
    /** The store the processor sees; the app keeps the real one. */
    processorStore?: (store: Store) => Store
    /** A database other than the one `useDatabase` set (the scenario eval owns its own). */
    sql?: Sql
    /** Turns on the OAuth server and the sign-in, on the test server's own origin (`auth.test.ts`). */
    auth?: { fetchClient?: Parameters<typeof createAuth>[0]['fetchClientMetadataResource'] }
  } = {},
) {
  const fake = opts.fake ?? fakeGraph()
  const model = opts.model ?? fakeModel()
  const store = createStore(opts.sql ?? sql, { staleMs: opts.staleMs ?? 0, maxAttempts: 3 })
  const links = opts.auth ? createLinks(opts.sql ?? sql) : undefined
  const makeProcessor = (s: Store, client: Anthropic = model.client) =>
    createProcessor({
      store: s,
      signIn: opts.auth !== undefined,
      graph: fake.graph,
      allowed: opts.allowed ?? ['*'],
      maxAttempts: 3,
      client,
      helpContact: opts.helpContact,
      transcriber: opts.transcriber,
      interimMs: opts.interimMs ?? 60_000,
      deadlineMs: opts.deadlineMs ?? 120_000,
    })
  const processor = makeProcessor(opts.processorStore?.(store) ?? store)
  // The OAuth server's issuer is the server's own origin, which is known only once it listens.
  let routes: AuthRoutes | undefined
  const server = createApp({
    store,
    processor,
    config: { WHATSAPP_VERIFY_TOKEN: VERIFY, META_APP_SECRET: SECRET },
    ...(opts.auth
      ? { auth: (req, res, url) => routes?.(req, res, url) ?? Promise.resolve(false) }
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
