/** Lists the latest movements.  pnpm ledger:status [n] */
import { createDb, createPool, recentMovements } from '@warren/db'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL (apps/web/.env.local is read automatically)')
  process.exit(2)
}
const pool = createPool(url)
const rows = await recentMovements(createDb(pool), Number(process.argv[2] ?? 20))
await pool.end()

if (rows.length === 0) console.log('No movements yet.')
console.table(
  rows.map((m) => ({
    date: `${m.date}${m.time ? ` ${m.time.slice(0, 5)}` : ''}`,
    dir: m.direction,
    amount: `${m.currency} ${Number(m.amount).toFixed(2)}`,
    account: m.accountId ?? '?',
    counterparty: m.counterAccountId ?? m.counterpartyName ?? m.counterpartyAccount ?? '',
    type: m.type,
    mails: m.sources,
  })),
)
