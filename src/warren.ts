import type { Server } from 'node:http'
import type Anthropic from '@anthropic-ai/sdk'
import { createApp } from './app'
import { createAuth } from './auth/config'
import { createLinks } from './auth/link'
import { type AuthRoutes, createAuthRoutes } from './auth/routes'
import type { Config } from './config'
import type { Sql } from './core/db'
import { log } from './log'
import { createProcessor, type Processor } from './process'
import { createReminderSender } from './reminders/send'
import { createStore, type Store } from './store'
import type { Transcriber } from './transcribe'
import type { Graph } from './whatsapp/graph'

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
  /** Turns on "vincular <code>" in the processor. Default: whether the OAuth server is on. */
  signIn?: boolean
  maxAttempts?: number
  staleMs?: number
  interimMs?: number
  deadlineMs?: number
  clock?: () => Date
  /** A test's view of the store the processor sees; the app keeps the real one. */
  wrapStore?: (store: Store) => Store
}

export interface Warren {
  store: Store
  processor: Processor
  reminders: ReturnType<typeof createReminderSender>
  server: Server
  /** Another processor over the same pieces, for tests that swap the model or the store mid-run. */
  makeProcessor: (store: Store, client?: Anthropic) => Processor
  /** One pass of everything that runs on a timer: messages left pending and reminders due. */
  sweep: () => Promise<void>
  /** Stops taking work and lets what is in flight finish (a deploy, or the end of a test). */
  stop: (graceMs?: number) => Promise<void>
}

/**
 * The one place the pieces are wired together: the store, the processor, the reminder sender, the OAuth
 * server and the HTTP app. `src/server.ts`, the tests and the scenario eval all start Warren here, so
 * what they run is what production runs. It listens to nothing and starts no timer.
 */
export function createWarren(deps: WarrenDeps): Warren {
  const { sql, config } = deps
  const maxAttempts = deps.maxAttempts ?? 5
  const store = createStore(sql, { staleMs: deps.staleMs ?? 120_000, maxAttempts })
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
  const makeProcessor = (s: Store, client: Anthropic = deps.client) =>
    createProcessor({
      store: s,
      signIn: deps.signIn ?? auth !== undefined,
      graph: deps.graph,
      allowed: config.ALLOWED_WA_IDS,
      maxAttempts,
      client,
      helpContact: config.HELP_CONTACT,
      transcriber: deps.transcriber,
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.interimMs !== undefined ? { interimMs: deps.interimMs } : {}),
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    })
  const processor = makeProcessor(deps.wrapStore?.(store) ?? store)
  const reminders = createReminderSender({
    sql,
    graph: deps.graph,
    allowed: config.ALLOWED_WA_IDS,
    template: config.REMINDER_TEMPLATE,
  })
  const server = createApp({ store, config, processor, auth })
  return {
    store,
    processor,
    reminders,
    server,
    makeProcessor,
    sweep: async () => {
      await Promise.all([
        processor.sweep().catch((err) => log('sweep_error', { error: String(err) }, 'error')),
        reminders
          .sweep()
          .catch((err) => log('reminder_sweep_error', { error: String(err) }, 'error')),
      ])
    },
    stop: async (graceMs = 10_000) => {
      await Promise.all([processor.stop(graceMs), reminders.stop()])
    },
  }
}
