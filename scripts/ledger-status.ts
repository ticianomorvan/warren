/** Lists a user's latest movements.  pnpm ledger:status --user <id> [n] */
import { asUser, recentMovements } from '@warren/db'
import { connect, positionals, userArg } from './lib'

const user = userArg()
const { pool, database } = connect('DATABASE_URL')
const rows = await asUser(database, user, (scope) =>
  recentMovements(scope, Number(positionals(['user'])[0] ?? 20)),
)
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
