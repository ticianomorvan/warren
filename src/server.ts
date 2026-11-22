import Anthropic from '@anthropic-ai/sdk'
import { warmUp } from './agent'
import { createApp } from './app'
import { createAuth } from './auth/config'
import { createLinks } from './auth/link'
import { createAuthRoutes } from './auth/routes'
import { loadConfig } from './config'
import { connect, migrate } from './db'
import { keepAliveFetch } from './http'
import { log } from './log'
import { createProcessor } from './process'
import { createReminderSender } from './reminders/send'
import { createStore } from './store'
import { createTranscriber } from './transcribe'
import { createGraph } from './whatsapp/graph'

const MAX_ATTEMPTS = 5
const config = loadConfig()
const sql = connect(config.DATABASE_URL)
await migrate(sql)

const store = createStore(sql, { staleMs: 120_000, maxAttempts: MAX_ATTEMPTS })
const graph = createGraph({
  version: config.GRAPH_API_VERSION,
  phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
  token: config.WHATSAPP_ACCESS_TOKEN,
})
const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, fetch: keepAliveFetch() })
// The sign-in and OAuth server for MCP exist only when PUBLIC_URL is set (the config then requires the rest).
const links = config.auth ? createLinks(sql) : undefined
const auth =
  config.auth && links
    ? createAuthRoutes({
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
    : undefined
const processor = createProcessor({
  store,
  signIn: config.auth !== undefined,
  graph,
  allowed: config.ALLOWED_WA_IDS,
  maxAttempts: MAX_ATTEMPTS,
  client,
  helpContact: config.HELP_CONTACT,
  transcriber: config.OPENROUTER_API_KEY
    ? createTranscriber({ apiKey: config.OPENROUTER_API_KEY })
    : undefined,
})
const reminders = createReminderSender({ sql, graph, template: config.REMINDER_TEMPLATE })
const server = createApp({ store, config, processor, auth })

server.listen(config.PORT, () => log('listening', { port: config.PORT }))

// The first request after a tool change compiles the tool grammar (~10 s): do it before anyone writes.
warmUp(client, 'haiku').then(
  () => log('agent_warm'),
  (err) => log('agent_warm_failed', { error: String(err) }, 'error'),
)

// Startup sweep, then every 30 s. One process only: the claim keeps two sweeps from double-sending,
// but only one replica is supported.
const tick = () =>
  Promise.all([
    processor.sweep().catch((err) => log('sweep_error', { error: String(err) }, 'error')),
    reminders.sweep().catch((err) => log('reminder_sweep_error', { error: String(err) }, 'error')),
  ])
void tick()
const timer = setInterval(tick, 30_000)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('shutdown', { signal })
    clearInterval(timer)
    server.close()
    // Messages still parsing go back to `pending` for the next process; replies already being sent
    // finish, so a deploy does not leave rows `unknown`.
    Promise.all([processor.stop(10_000), reminders.stop()])
      .then(() => sql.end({ timeout: 5 }))
      .finally(() => process.exit(0))
  })
}
