import { connect } from './db'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL (for Railway, the Postgres service public URL).')
  process.exit(1)
}
const i = process.argv.indexOf('--last')
const last = i >= 0 ? Number(process.argv[i + 1]) : 100
if (!Number.isInteger(last) || last < 1) {
  console.error('--last needs a positive integer')
  process.exit(1)
}

const sql = connect(url, { max: 1 })
const rows = await sql<
  {
    typing: number | null
    reply: number | null
    delivered: number | null
    model: number | null
    type: string | null
    turns: number | null
  }[]
>`
  SELECT
    extract(epoch FROM m.typing_sent_at - m.received_at) * 1000 AS typing,
    extract(epoch FROM m.reply_sent_at - m.received_at) * 1000 AS reply,
    extract(epoch FROM r.delivered_at - m.meta_ts) * 1000 AS delivered,
    m.model_ms AS model,
    COALESCE(m.action, m.command->>'type') AS type,
    m.model_turns AS turns
  FROM (SELECT * FROM inbound_message WHERE kind = 'text' ORDER BY id DESC LIMIT ${last}) m
  LEFT JOIN reply r ON r.inbound_id = m.id`
await sql.end()

function pct(values: (number | null)[], p: number): string {
  const v = values
    .filter((x): x is number => x !== null)
    .map(Number)
    .sort((a, b) => a - b)
  if (!v.length) return 'n/a'
  return `${Math.round(v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)] as number)} ms`
}

const metric = (
  name: string,
  key: 'typing' | 'reply' | 'delivered' | 'model',
  from: (typeof rows)[number][] = rows,
) => {
  const v = from.map((r) => (r[key] === null ? null : Number(r[key])))
  const n = v.filter((x) => x !== null).length
  console.log(
    `${name.padEnd(34)} p50 ${pct(v, 50).padStart(9)}   p95 ${pct(v, 95).padStart(9)}   (n=${n})`,
  )
}

console.log(`Last ${rows.length} inbound text messages`)
metric('received -> typing sent', 'typing')
metric('received -> reply sent', 'reply')
metric('model time', 'model')
// By action (the `action` column; older rows carry their old command type).
// Targets: log p50 <= 2.0 s, p95 <= 4.0 s; correct, delete and summarize p50 <= 4 s, p95 <= 8 s.
for (const type of [...new Set(rows.map((r) => r.type ?? 'failed'))].sort()) {
  const of = rows.filter((r) => (r.type ?? 'failed') === type)
  const turns = of.flatMap((r) => (r.turns === null ? [] : [Number(r.turns)]))
  metric(`received -> reply sent, ${type}`, 'reply', of)
  if (turns.length > 0) {
    console.log(
      `${''.padEnd(34)} model turns per message: ${(turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(2)}`,
    )
  }
}
metric('meta ts -> delivered (1 s steps)', 'delivered')
