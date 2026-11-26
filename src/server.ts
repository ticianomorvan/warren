import { loadConfig } from './config'
import { connect, migrate, schemaDir } from './core/db'
import { log } from './log'
import { createWarren } from './warren'

const config = loadConfig()
const sql = connect(config.DATABASE_URL)
await migrate(sql, schemaDir)

const { server } = createWarren({
  sql,
  config,
  // A deploy from GitHub has a commit; a `railway up` has none; both have a deployment id.
  build:
    [process.env.RAILWAY_GIT_COMMIT_SHA, process.env.RAILWAY_DEPLOYMENT_ID]
      .filter(Boolean)
      .join(' ') || undefined,
})

server.listen(config.PORT, () => log('listening', { port: config.PORT }))

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('shutdown', { signal })
    // Stops taking connections and lets the requests in flight finish; a turn is one transaction, so none is left half-done.
    server.close(() => {
      sql.end({ timeout: 5 }).finally(() => process.exit(0))
    })
    // A keep-alive connection could hold the close open: past the drain Railway gives, leave.
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
