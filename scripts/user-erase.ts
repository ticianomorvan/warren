/**
 * Erases a user: deletes their key, mailboxes, accounts and identifiers, movements, movement
 * sources and notices (the erasure set, packages/db/src/tables.ts), writes
 * the tombstone, then deletes their files. Their append-only rows stay as ciphertext no one can
 * open. Every other user's chain still verifies. Marking the user row itself erased, and
 * ending their sessions, belongs to the auth side (warren_auth).
 *   pnpm user:erase --user <id> --confirm
 * Connects as warren_eraser (DATABASE_URL_ERASER), which can do nothing else.
 *
 * Safe to run again: for a user already erased it only sweeps their files. Do that if the first
 * run failed after the commit, or to catch a file an intake in flight stored after the sweep
 * (that intake deletes its own file when it finds the user erased, but only best effort).
 */
import { eraseUser } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'
import { connect, die, has, userArg } from './lib'

const user = userArg()
if (!has('confirm')) die(`This destroys user ${user}'s key for good. Pass --confirm to go ahead.`)
const { pool, database } = connect('DATABASE_URL_ERASER')
const report = await eraseUser(database, user, rawStore())
await pool.end()
console.log(report)
