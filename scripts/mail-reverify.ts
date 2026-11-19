/**
 * Checks again a user's mail that was rejected as `unknown-sender` under an older sender policy,
 * after a sender was added to `SENDERS`.  pnpm mail:reverify --user <id>
 * Each mail is read from its sealed file and checked against the current policy; a new verdict is
 * appended, and mail that now verifies is parsed and recorded, without a notice (it is old mail).
 * DKIM keys rotate, so some mail may no longer verify: those are counted by reason.
 * Reads the Blob store, so it needs store credentials (see mail:parse-pending).
 * Prints counts only: never a subject, an address, an id or any content.
 */
import {
  defaultTxtResolver,
  type IntakeDeps,
  inboundDomain,
  reverifyUnknownSender,
  SENDERS,
} from '@warren/core'
import { createTenancy } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'
import { connect, userArg } from './lib'

const user = userArg()
const { pool, database } = connect('DATABASE_URL')
const deps: IntakeDeps = {
  tenancy: createTenancy(database, rawStore()),
  resolver: defaultTxtResolver,
  senders: SENDERS,
  maxDateSkewMinutes: 120,
  inboundDomain: inboundDomain(process.env.WARREN_INBOUND_DOMAIN),
}
try {
  const counts = await reverifyUnknownSender(deps, user)
  console.log(
    `checked ${counts.checked}, verified ${counts.verified}, still rejected ${counts.stillRejected}`,
  )
  for (const [reason, n] of Object.entries(counts.reasons)) console.log(`  ${reason}: ${n}`)
} catch (error) {
  // The error's message can name a store path, and so an id: print its kind only. Mail checked
  // before the failure keeps its new verdict, and a rerun picks up the rest.
  console.error(`Re-verify stopped: ${error instanceof Error ? error.name : 'unknown error'}.`)
  process.exitCode = 1
} finally {
  await pool.end()
}
