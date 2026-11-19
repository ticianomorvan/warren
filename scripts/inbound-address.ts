/**
 * Prints a user's active inbound address, making it on the first call.  pnpm inbound:address --user <id>
 * Forward bank mail to this address: `<token>@WARREN_INBOUND_DOMAIN` (default in.heywarren.app).
 * Runs as warren_app (DATABASE_URL), under row-level security, like the app. Needs the master
 * key, because `asUser` makes the user's data key if they have none yet.
 */
import { inboundAddressOf, inboundDomain } from '@warren/core'
import { asUser, inboundAddressFor } from '@warren/db'
import { connect, userArg } from './lib'

const user = userArg()
const { pool, database } = connect('DATABASE_URL')
const token = await asUser(database, user, (scope) => inboundAddressFor(scope))
await pool.end()
console.log(inboundAddressOf(token, inboundDomain(process.env.WARREN_INBOUND_DOMAIN)))
