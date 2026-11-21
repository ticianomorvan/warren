import { startFakeGraph } from './fake-graph'
import { postWebhook, webhookBody } from './webhook'

const graph = await startFakeGraph(3199)
const t0 = performance.now()
const res = await postWebhook(
  'http://localhost:3100',
  webhookBody({
    wamid: `wamid.t${Date.now()}`,
    from: '5491100000009',
    timestamp: Math.floor(Date.now() / 1000),
    message: { type: 'text', text: { body: process.argv[2] ?? 'café 3500' } },
  }),
)
console.log('webhook', res.status, Math.round(performance.now() - t0), 'ms')
const end = Date.now() + 25000
while (Date.now() < end && !graph.sent.some((s) => s.kind === 'text'))
  await new Promise((r) => setTimeout(r, 25))
for (const s of graph.sent) console.log(Math.round(s.at - t0), 'ms', JSON.stringify(s))
await graph.close()
