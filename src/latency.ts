import { connect } from './db'
import { fetchLatencyRows, renderLatency } from './latency-report'

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
const rows = await fetchLatencyRows(sql, last)
await sql.end()
for (const l of renderLatency(rows)) console.log(l)
