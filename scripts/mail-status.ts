/** Lists the latest mails Warren received and what it decided.  pnpm mail:status [n] */
import { createDb, createPool, recentMail } from '@warren/db'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL (apps/web/.env.local is read automatically)')
  process.exit(2)
}
const pool = createPool(url)
const rows = await recentMail(createDb(pool), Number(process.argv[2] ?? 20))
await pool.end()

if (rows.length === 0) console.log('No mail received yet.')
console.table(
  rows.map((r) => ({
    received: r.receivedAt.toISOString().slice(0, 19).replace('T', ' '),
    mail: r.sha256.slice(0, 8),
    status: r.verdict ?? 'unchecked',
    parse: r.parse === 'parsed' ? (r.template ?? '') : (r.parseReason ?? ''),
    why: [r.reason, r.detail].filter(Boolean).join(': '),
    sender: r.senderId ?? r.fromAddress ?? '',
    subject: (r.subject ?? '').slice(0, 40),
    kb: Math.round(r.bytes / 1024),
    tries: r.attempts,
  })),
)
