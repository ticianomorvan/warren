import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type Anthropic from '@anthropic-ai/sdk'
import { createApp } from './app'
import { createAuth } from './auth/config'
import { createLinks } from './auth/link'
import { type AuthRoutes, createAuthRoutes } from './auth/routes'
import type { Config } from './config'
import type { Sql } from './core/db'
import { createReminderSender, type ReminderSender } from './domain/reminders/send'
import { log } from './log'
import { createDoor } from './mcp/door'
import { createMcpEndpoint } from './mcp/endpoint'
import type { Transcriber } from './transcribe'
import type { Graph } from './whatsapp/graph'
import { createIngest, type Ingest } from './whatsapp/ingest'
import { createWorker, type Worker } from './whatsapp/worker'

/** What Warren needs from outside. The server gives real ones; tests and the scenario eval give doubles. */
export interface WarrenDeps {
  sql: Sql
  config: Pick<
    Config,
    | 'WHATSAPP_VERIFY_TOKEN'
    | 'META_APP_SECRET'
    | 'ALLOWED_WA_IDS'
    | 'HELP_CONTACT'
    | 'REMINDER_TEMPLATE'
  > & { auth?: Config['auth'] }
  graph: Graph
  client: Anthropic
  transcriber?: Transcriber | undefined
  /** Ready-made OAuth routes (tests late-bind them to the server's own origin); else built from `config.auth`. */
  authRoutes?: AuthRoutes
  /** The ready-made `/mcp` handler, late-bound the same way. */
  mcp?: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** Turns on "vincular <code>" in the worker. Default: whether the OAuth server is on. */
  signIn?: boolean
  maxAttempts?: number
  staleMs?: number
  interimMs?: number
  deadlineMs?: number
  clock?: () => Date
  /** The host of `/mcp` and the OAuth server; default `config.auth`'s. A function, so a test can bind it after it listens. */
  publicHost?: () => string
  /** The deploy's identity, shown by `/health` so the cutover and the probe can tell which version answers. */
  build?: string
}

export interface Warren {
  ingest: Ingest
  worker: Worker
  /** Sends the reminders that are due; `sweep` runs it on the tick. */
  reminders: ReminderSender
  server: Server
  /** Another worker over the same pieces, for tests that swap the model mid-run (an old instance beside a new one). */
  makeWorker: (client?: Anthropic) => Worker
  /** One pass over the messages left pending (a row the old instance handed back at SIGTERM): `server.ts` runs it every few seconds. */
  sweepMessages: () => Promise<void>
  /** One pass over the reminders that are due: `server.ts` runs it every 30 s. */
  sweepReminders: () => Promise<void>
  /** Both, for tests and the eval. */
  sweep: () => Promise<void>
  /** Stops taking work and lets what is in flight finish (a deploy, or the end of a test). */
  stop: (graceMs?: number) => Promise<void>
}

/**
 * The one place the pieces are wired together: the ingest, the worker, the OAuth server and the HTTP app. `src/server.ts`, the tests and the scenario eval all start Warren here, so
 * what they run is what production runs. It listens to nothing and starts no timer.
 */
export function createWarren(deps: WarrenDeps): Warren {
  const { sql, config } = deps
  const maxAttempts = deps.maxAttempts ?? 5
  const ingest = createIngest(sql, { allowed: config.ALLOWED_WA_IDS })
  // The sign-in, the OAuth server and `/mcp` exist only when PUBLIC_URL is set (the config then requires the rest).
  let auth = deps.authRoutes
  let mcp = deps.mcp
  if (!auth && config.auth) {
    const links = createLinks(sql)
    const instance = createAuth({
      sql,
      publicUrl: config.auth.publicUrl,
      secret: config.auth.secret,
      links,
      log: (level, message) =>
        log('auth_log', { level, message }, level === 'error' ? 'error' : 'info'),
    })
    auth = createAuthRoutes({
      auth: instance,
      sql,
      links,
      publicUrl: config.auth.publicUrl,
      displayNumber: config.auth.displayNumber,
    })
    mcp = createMcpEndpoint({
      door: createDoor({
        auth: instance,
        sql,
        publicUrl: config.auth.publicUrl,
        allowed: config.ALLOWED_WA_IDS,
      }),
      sql,
      publicUrl: config.auth.publicUrl,
      ...(deps.clock ? { now: deps.clock } : {}),
    })
  }
  const makeWorker = (client: Anthropic = deps.client) =>
    createWorker({
      sql,
      signIn: deps.signIn ?? auth !== undefined,
      graph: deps.graph,
      allowed: config.ALLOWED_WA_IDS,
      maxAttempts,
      staleMs: deps.staleMs ?? 120_000,
      client,
      helpContact: config.HELP_CONTACT,
      transcriber: deps.transcriber,
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.interimMs !== undefined ? { interimMs: deps.interimMs } : {}),
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    })
  const worker = makeWorker()
  const reminders = createReminderSender({
    sql,
    graph: deps.graph,
    allowed: config.ALLOWED_WA_IDS,
    template: config.REMINDER_TEMPLATE,
    ...(deps.clock ? { now: deps.clock } : {}),
  })
  const server = createApp({
    ingest,
    config,
    worker,
    ...(deps.build ? { build: deps.build } : {}),
    ...(deps.publicHost
      ? { publicHost: deps.publicHost }
      : config.auth
        ? { publicHost: () => new URL(config.auth?.publicUrl ?? '').host }
        : {}),
    ...(auth ? { auth } : {}),
    ...(mcp ? { mcp } : {}),
  })
  const sweepMessages = () =>
    worker.sweep().then(
      () => {},
      (err) => log('sweep_error', { error: String(err) }, 'error'),
    )
  const sweepReminders = () =>
    reminders.sweep().then(
      () => {},
      (err) => log('reminder_sweep_error', { error: String(err) }, 'error'),
    )
  return {
    ingest,
    worker,
    reminders,
    server,
    makeWorker,
    sweepMessages,
    sweepReminders,
    // Independent: a failing reminder sweep never holds back the messages, nor the other way round.
    sweep: async () => {
      await Promise.all([sweepMessages(), sweepReminders()])
    },
    stop: async (graceMs = 10_000) => {
      await Promise.all([worker.stop(graceMs), reminders.stop(graceMs)])
    },
  }
}
