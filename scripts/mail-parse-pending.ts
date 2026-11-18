/**
 * Parses verified mail that has no parse under the current templates, then records parsed
 * mail the ledger does not have yet.  pnpm mail:parse-pending
 * Reads the raw files from the Blob store, so it needs store credentials:
 *   pnpm dlx vercel env pull .vercel/.env.development.local
 * Prints hashes and outcomes only.
 */
import { parsePending, recordPending } from '@warren/core'
import { createDb, createLedger, createMailLog, createPool } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL (apps/web/.env.local is read automatically)')
  process.exit(2)
}
const pool = createPool(url)
const db = createDb(pool)
const results = await parsePending({ store: rawStore(), log: createMailLog(db) })
const recorded = await recordPending(createLedger(db))
await pool.end()

if (results.length === 0) console.log('Nothing pending.')
else
  console.table(
    results.map((r) => ({ mail: r.sha256.slice(0, 8), status: r.status, why: r.reason ?? '' })),
  )
if (recorded.length > 0)
  console.table(
    recorded.map((r) => ({ mail: r.mailSha256.slice(0, 8), movement: r.outcome, type: r.type })),
  )
