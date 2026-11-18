/**
 * Parses a user's verified mail that has no parse under the current templates, then records
 * parsed mail the ledger does not have yet.  pnpm mail:parse-pending --user <id>
 * Reads the sealed raw files from the Blob store, so it needs store credentials:
 *   pnpm dlx vercel env pull .vercel/.env.development.local
 * Prints ids and outcomes only.
 */
import { parsePending, recordPending } from '@warren/core'
import { asUser, userContext } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'
import { connect, userArg } from './lib'

const user = userArg()
const { pool, database } = connect('DATABASE_URL')
const [results, recorded] = await asUser(database, user, async (scope) => {
  const ctx = await userContext(scope, rawStore())
  return [await parsePending(ctx), await recordPending(ctx.ledger)] as const
})
await pool.end()

if (results.length === 0) console.log('Nothing pending.')
else
  console.table(
    results.map((r) => ({ mail: r.mailId.slice(0, 8), status: r.status, why: r.reason ?? '' })),
  )
if (recorded.length > 0)
  console.table(
    recorded.map((r) => ({ mail: r.mailId.slice(0, 8), movement: r.outcome, type: r.type })),
  )
