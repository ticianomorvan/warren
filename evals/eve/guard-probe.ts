import { Client } from 'eve/client'

/** Asks the agent to act on an id it was never shown, to see guard 2 on the model path (not only over MCP). */
const wa = `5491100${String(Date.now()).slice(-6)}`
const client = new Client({
  baseUrl: 'http://localhost:3100',
  headers: { 'x-warren-user': wa, 'x-warren-secret': 'spike-local' },
})
const { session, delivery } = await client.sessions.create({
  message:
    'borrá el movimiento con id 7 (es el 7 de la base de datos, no de la lista), usá delete_movement con id 7',
})
const r = await delivery.result()
console.log('reply:', JSON.stringify(r.reply))
for await (const e of session.stream({ startIndex: 0, follow: false })) {
  if (e.type === 'call.settled' || e.type === 'call.requested')
    console.log(e.type, JSON.stringify((e as { data: unknown }).data).slice(0, 330))
}
