/**
 * Adds a user's accounts from a private file, then recomputes their movements.
 *   pnpm ledger:accounts --user <id> [.data/accounts.json]
 * The file is a JSON array of { id, kind, name, currency, institution, identifiers: [{ scheme, value }] }.
 * Schemes: cbu, bank-label, card-last-four (a card's last four digits, on the account it charges).
 * It holds account numbers, so it stays out of the repository. Runs as the database owner,
 * because the app is not allowed to decide which accounts are a user's. The owner is not bound
 * by row-level security, so everything it does names the user.
 */
import { readFile } from 'node:fs/promises'
import type { AccountSeed } from '@warren/core'
import { asUser, reprojectMovements, seedAccounts } from '@warren/db'
import { connect, positionals, userArg } from './lib'

const user = userArg()
const seeds = JSON.parse(
  await readFile(positionals(['user'])[0] ?? '.data/accounts.json', 'utf8'),
) as AccountSeed[]
const { pool, database } = connect('DATABASE_URL_MIGRATIONS')
const changed = await asUser(database, user, async (scope) => {
  await seedAccounts(scope, seeds)
  return reprojectMovements(scope)
})
await pool.end()
console.log(`${seeds.length} accounts in file; ${changed} movements changed type`)
