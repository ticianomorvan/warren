import Anthropic from '@anthropic-ai/sdk'
import { warmUp } from './agent/loop'
import { loadConfig } from './config'
import { connect, migrate, schemaDir } from './core/db'
import { keepAliveFetch } from './http'
import { log } from './log'
import { createTranscriber } from './transcribe'
import { createWarren } from './warren'
import { createGraph } from './whatsapp/graph'

const MAX_ATTEMPTS = 5
const config = loadConfig()
const sql = connect(config.DATABASE_URL)
await migrate(sql, schemaDir)

const graph = createGraph({
  version: config.GRAPH_API_VERSION,
  phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
  token: config.WHATSAPP_ACCESS_TOKEN,
})
const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, fetch: keepAliveFetch() })
const { server, sweepMessages, sweepReminders, stop } = createWarren({
  sql,
  config,
  graph,
  client,
  // A deploy from GitHub has a commit; a `railway up` has none; both have a deployment id.
  build:
    [process.env.RAILWAY_GIT_COMMIT_SHA, process.env.RAILWAY_DEPLOYMENT_ID]
      .filter(Boolean)
      .join(' ') || undefined,
  maxAttempts: MAX_ATTEMPTS,
  staleMs: 120_000,
  transcriber: config.OPENROUTER_API_KEY
    ? createTranscriber({ apiKey: config.OPENROUTER_API_KEY })
    : undefined,
})

server.listen(config.PORT, () => log('listening', { port: config.PORT }))

// Writes the prompt cache and opens the connection, so the first person's message pays for neither.
warmUp(client, 'haiku').then(
  () => log('agent_warm'),
  (err) => log('agent_warm_failed', { error: String(err) }, 'error'),
)

// Startup sweep, then the messages every 5 s and the reminders every 30 s. A message the old instance of a deploy handed back at SIGTERM
// waits at most one message tick; the three queries of a message sweep read only the open rows' partial index. Two processes (a deploy's
// overlap) are safe: the claim takes a sender's oldest due row only when no older one is held, so the new instance never overtakes the old one's.
void sweepMessages()
void sweepReminders()
const timers = [setInterval(sweepMessages, 5_000), setInterval(sweepReminders, 30_000)]

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('shutdown', { signal })
    for (const t of timers) clearInterval(t)
    server.close()
    // Messages still parsing go back to `pending` for the next process; replies already being sent
    // finish, so a deploy does not leave rows `unknown`.
    stop(10_000)
      .then(() => sql.end({ timeout: 5 }))
      .finally(() => process.exit(0))
  })
}
