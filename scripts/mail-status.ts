/**
 * Lists a user's latest mails and what Warren decided, then adds them up.
 *   pnpm mail:status --user <id> [n]
 * Connects as warren_app (DATABASE_URL), so row-level security shows only that user's rows.
 */
import { asUser, mailCounts, recentMail } from '@warren/db'
import { connect, positionals, userArg } from './lib'

const user = userArg()
const { pool, database } = connect('DATABASE_URL')
const [rows, counts] = await asUser(database, user, async (scope) => [
  await recentMail(scope, Number(positionals(['user'])[0] ?? 20)),
  await mailCounts(scope),
])
await pool.end()

if (!rows || rows.length === 0) console.log('No mail received yet.')
console.table(
  (rows ?? []).map((r) => ({
    received: r.receivedAt.toISOString().slice(0, 19).replace('T', ' '),
    mail: r.mailId.slice(0, 8),
    status: r.verdict ?? 'unchecked',
    parse: r.parse === 'parsed' ? (r.template ?? '') : (r.parseReason ?? ''),
    why: [r.reason, r.detail].filter(Boolean).join(': '),
    sender: r.senderId ?? r.fromAddress ?? '',
    subject: (r.subject ?? '').slice(0, 40),
    kb: Math.round(r.bytes / 1024),
    tries: r.attempts,
  })),
)
console.log(counts)
