/**
 * Registers an address that forwards bank mail to a user.  pnpm mailbox:add --user <id> <address>
 * Operator only, as the database owner: sign-up never adds a mailbox, or anyone could claim a
 * victim's address and receive their forwarded bank mail. An address already registered for
 * another user is refused. Slice 6 replaces this with per-user addresses.
 */
import { system } from '@warren/db'
import { connect, die, positionals, userArg } from './lib'

const user = userArg()
const address = positionals(['user'])[0]
if (!address?.includes('@')) die('usage: pnpm mailbox:add --user <id> <address>')
const { pool, database } = connect('DATABASE_URL_MIGRATIONS')
await system.addMailbox(database, user, address)
await pool.end()
console.log('mailbox registered')
