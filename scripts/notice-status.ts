/** Lists a user's latest notices with where each one stands.  pnpm notice:status --user <id> [n] */
import { asUser, recentNotices } from '@warren/db'
import { connect, positionals, userArg } from './lib'

const user = userArg()
const { pool, database } = connect('DATABASE_URL')
const rows = await asUser(database, user, (scope) =>
  recentNotices(scope, Number(positionals(['user'])[0] ?? 20)),
)
await pool.end()

if (rows.length === 0) console.log('No notices yet.')
// Never an endpoint: the subscription is shown as the first characters of its id.
console.table(
  rows.map((n) => ({
    notice: n.noticeId,
    created: n.createdAt.toISOString().slice(0, 16).replace('T', ' '),
    attempts: n.attempts,
    last: n.lastMode ? `${n.lastMode}: ${n.lastOutcome}` : 'not tried',
    subscription: n.lastSubscription ?? '',
    status: n.lastStatus ?? '',
  })),
)
