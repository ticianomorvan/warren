import Anthropic from '@anthropic-ai/sdk'
import { createApp } from './app'
import { loadConfig } from './config'
import { connect, migrate } from './db'
import { log } from './log'
import { createProcessor } from './process'
import { createStore } from './store'
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
const processor = createProcessor({
  store,
  graph,
  allowed: config.ALLOWED_WA_IDS,
  maxAttempts: MAX_ATTEMPTS,
  client: new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }),
  helpContact: config.HELP_CONTACT,
})
const server = createApp({ store, config, processor })

server.listen(config.PORT, () => log('listening', { port: config.PORT }))

// Startup sweep, then every 30 s. One process only: the claim keeps two sweeps from double-sending,
// but only one replica is supported.
const tick = () =>
  processor.sweep().catch((err) => log('sweep_error', { error: String(err) }, 'error'))
void tick()
const timer = setInterval(tick, 30_000)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('shutdown', { signal })
    clearInterval(timer)
    server.close()
    // Let replies already being sent finish, so a deploy does not leave rows `unknown`.
    processor
      .drain(10_000)
      .then(() => sql.end({ timeout: 5 }))
      .finally(() => process.exit(0))
  })
}
