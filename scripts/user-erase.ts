/**
 * Erases a user. First, as warren_auth (DATABASE_URL_AUTH), it deletes their sessions and
 * credentials, marks the user row erased and scrubs its email and name, so they can no longer
 * sign in. Then, as warren_eraser (DATABASE_URL_ERASER), it deletes their key, mailboxes,
 * accounts and identifiers, movements, movement sources and notices (the erasure set,
 * packages/db/src/tables.ts), writes the tombstone, and deletes their files. Their append-only
 * rows stay as ciphertext no one can open. Every other user's chain still verifies.
 *   pnpm user:erase --user <id> --confirm
 * Needs no master key. Each role can do nothing beyond this.
 *
 * Safe to run again: for a user already erased it only sweeps their files. Do that if the first
 * run failed after the commit, or to catch a file an intake in flight stored after the sweep
 * (that intake deletes its own file when it finds the user erased, but only best effort).
 */
import { eraseUser } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'
import { connectKeyless, die, has, userArg } from './lib'

const user = userArg()
if (!has('confirm')) die(`This destroys user ${user}'s key for good. Pass --confirm to go ahead.`)
const eraser = connectKeyless('DATABASE_URL_ERASER')
const auth = connectKeyless('DATABASE_URL_AUTH')
try {
  console.log(await eraseUser({ eraser: eraser.database, auth: auth.database }, user, rawStore()))
} finally {
  await Promise.all([eraser.pool.end(), auth.pool.end()])
}
