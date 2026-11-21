import { createApp } from './app'
import { loadConfig } from './config'
import { connect, migrate } from './db'
import { log } from './log'
import { createProcessor } from './process'
import { createGraph } from './whatsapp/graph'

const config = loadConfig()
const sql = connect(config.DATABASE_URL)
await migrate(sql)

const graph = createGraph({
  version: config.GRAPH_API_VERSION,
  phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
  token: config.WHATSAPP_ACCESS_TOKEN,
})
const processor = createProcessor({ sql, graph, staleMs: 30_000, maxAttempts: 5 })
const server = createApp({ sql, config, processor })

// Startup sweep, then every 30 s. One process only: two sweeps would race on the same rows
// (the atomic claim keeps them from double-sending, but only one replica is supported).
const tick = () => processor.sweep().catch((err) => log('sweep_error', { error: String(err) }))
await tick()
const timer = setInterval(tick, 30_000)

server.listen(config.PORT, () => log('listening', { port: config.PORT }))

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer)
    server.close(() => sql.end({ timeout: 5 }).then(() => process.exit(0)))
  })
}
