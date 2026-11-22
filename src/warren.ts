import type { Server } from 'node:http'
import type Anthropic from '@anthropic-ai/sdk'
import { createApp } from './app'
import { createAuth } from './auth/config'
import { createLinks } from './auth/link'
import { type AuthRoutes, createAuthRoutes } from './auth/routes'
import type { Config } from './config'
import type { Sql } from './core/db'
import { log } from './log'
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
  /** Turns on "vincular <code>" in the worker. Default: whether the OAuth server is on. */
  signIn?: boolean
  maxAttempts?: number
  staleMs?: number
  interimMs?: number
  deadlineMs?: number
  clock?: () => Date
}

export interface Warren {
  ingest: Ingest
  worker: Worker
  server: Server
  /** Another worker over the same pieces, for tests that swap the model mid-run (an old instance beside a new one). */
  makeWorker: (client?: Anthropic) => Worker
  /** One pass of everything that runs on a timer: the messages left pending. */
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
  // The sign-in and OAuth server for MCP exist only when PUBLIC_URL is set (the config then requires the rest).
  const auth =
    deps.authRoutes ??
    (config.auth
      ? (() => {
          const links = createLinks(sql)
          return createAuthRoutes({
            auth: createAuth({
              sql,
              publicUrl: config.auth.publicUrl,
              secret: config.auth.secret,
              links,
              log: (level, message) =>
                log('auth_log', { level, message }, level === 'error' ? 'error' : 'info'),
            }),
            sql,
            links,
            publicUrl: config.auth.publicUrl,
            displayNumber: config.auth.displayNumber,
            allowed: config.ALLOWED_WA_IDS,
          })
        })()
      : undefined)
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
  const server = createApp({ ingest, config, worker, auth })
  return {
    ingest,
    worker,
    server,
    makeWorker,
    sweep: async () => {
      await worker.sweep().catch((err) => log('sweep_error', { error: String(err) }, 'error'))
    },
    stop: async (graceMs = 10_000) => {
      await worker.stop(graceMs)
    },
  }
}
