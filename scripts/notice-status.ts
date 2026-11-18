/** Lists the latest notices and where each one stands.  pnpm notice:status [n] */
import { createDb, createPool, recentNotices } from '@warren/db'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL (apps/web/.env.local is read automatically)')
  process.exit(2)
}
const pool = createPool(url)
const rows = await recentNotices(createDb(pool), Number(process.argv[2] ?? 20))
await pool.end()

if (rows.length === 0) console.log('No notices yet.')
console.table(
  rows.map((n) => ({
    notice: n.noticeId,
    created: n.createdAt.toISOString().slice(0, 16).replace('T', ' '),
    attempts: n.attempts,
    last: n.lastMode ? `${n.lastMode}: ${n.lastOutcome}` : 'not tried',
    detail: n.lastDetail ?? '',
    delivery: n.delivery ?? '',
  })),
)
