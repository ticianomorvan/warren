/**
 * Adds the owner's accounts from a private file, then recomputes movements.
 *   pnpm ledger:accounts [.data/accounts.json]
 * The file is a JSON array of { id, kind, name, currency, institution, identifiers: [{ scheme, value }] }.
 * It holds account numbers, so it stays out of the repository. Runs as the database owner,
 * because the app is not allowed to decide which accounts are the owner's.
 */
import { readFile } from 'node:fs/promises'
import type { AccountSeed } from '@warren/core'
import { createDb, createPool, reprojectMovements, seedAccounts } from '@warren/db'

const url = process.env.DATABASE_URL_MIGRATIONS
if (!url) {
  console.error('Set DATABASE_URL_MIGRATIONS (apps/web/.env.local is read automatically)')
  process.exit(2)
}
const seeds = JSON.parse(
  await readFile(process.argv[2] ?? '.data/accounts.json', 'utf8'),
) as AccountSeed[]
const pool = createPool(url)
const db = createDb(pool)
await seedAccounts(db, seeds)
const changed = await reprojectMovements(db)
await pool.end()
console.log(`${seeds.length} accounts in file; ${changed} movements changed type`)
