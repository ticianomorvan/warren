import { Client } from 'eve/client'

/**
 * Where the time of an eve turn goes: reads the event timestamps of a few turns and prints, per turn, the
 * model calls, the tool, and the gaps between them (checkpoint and scheduling overhead).
 */
const wa = `5491100${String(Date.now()).slice(-6)}`
const client = new Client({
  baseUrl: 'http://localhost:3100',
  headers: { 'x-warren-user': wa, 'x-warren-secret': 'spike-local' },
})
const texts = ['café 1900', 'subte 1200 y súper 9.500', 'el café fue 2100', 'cuánto gasté hoy']
const { session, delivery } = await client.sessions.create({ message: texts[0] ?? '' })
await delivery.result()
for (const t of texts.slice(1)) await (await session.send(t)).result()
type Ev = {
  type: string
  scope?: { turnId?: string }
  data: Record<string, unknown>
  meta: { at: string }
}
const events: Ev[] = []
for await (const e of session.stream({ startIndex: 0, follow: false }))
  events.push(e as unknown as Ev)
const at = (e: Ev) => Date.parse(e.meta.at)
const turns = [
  ...new Set(events.filter((e) => e.type === 'turn.started').map((e) => e.scope?.turnId)),
]
for (const [i, id] of turns.entries()) {
  const ev = events.filter(
    (e) =>
      e.scope?.turnId === id ||
      [
        'model.requested',
        'model.started',
        'model.settled',
        'call.started',
        'call.settled',
        'usage.recorded',
      ].includes(e.type),
  )
  const turnStart = events.find((e) => e.type === 'turn.started' && e.scope?.turnId === id)
  const turnEnd = events.find((e) => e.type === 'turn.settled' && e.scope?.turnId === id)
  if (!turnStart || !turnEnd) continue
  const start = at(turnStart)
  const rows = events
    .filter(
      (e) =>
        at(e) >= start &&
        at(e) <= at(turnEnd) &&
        [
          'model.requested',
          'model.started',
          'model.settled',
          'call.started',
          'call.settled',
        ].includes(e.type),
    )
    .map((e) => `${at(e) - start}ms ${e.type}`)
  console.log(`turn ${i} "${texts[i]}": ${at(turnEnd) - start} ms total\n  ${rows.join('\n  ')}`)
  void ev
}
