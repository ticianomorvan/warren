/**
 * Runs mail that arrived before its mailbox was registered through intake again.
 *   pnpm mail:replay-unrouted [--dry-run]
 *
 * Mail addressed to nobody's mailbox is dropped with only a content-free note (provider id and
 * arrival time), because nothing of it may be kept for no one. Once the mailbox exists, this
 * fetches those Resend ids again, with their original arrival time, and runs each through the
 * same intake as live mail. Marks nothing: a delivery that now routes is recorded under its
 * user, and deliveries with a recorded delivery are left out of the list, so running it twice
 * does the work once. A delivery Resend cannot return any more is reported and stays listed.
 *
 * Two connections: the owner (DATABASE_URL_MIGRATIONS) only lists the unrouted deliveries, which
 * the app role cannot read; intake itself runs as warren_app (DATABASE_URL), under row-level
 * security. Needs RESEND_API_KEY and the Blob store (see mail:parse-pending).
 */
import {
  defaultTxtResolver,
  fetchReceivedMail,
  type IntakeDeps,
  replayUnrouted,
  SENDERS,
} from '@warren/core'
import { createTenancy, system } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'
import { connect, die, has } from './lib'

const apiKey = process.env.RESEND_API_KEY
if (!apiKey) die('Set RESEND_API_KEY (the key the webhook uses to fetch received mail).')

const owner = connect('DATABASE_URL_MIGRATIONS')
const pending = await system.pendingUnrouted(owner.database)
await owner.pool.end()
console.log(`${pending.length} unrouted deliver${pending.length === 1 ? 'y' : 'ies'} to replay`)
if (pending.length === 0 || has('dry-run')) process.exit(0)

const app = connect('DATABASE_URL')
const deps: IntakeDeps = {
  tenancy: createTenancy(app.database, rawStore()),
  resolver: defaultTxtResolver,
  senders: SENDERS,
  maxDateSkewMinutes: 120,
}
const results = await replayUnrouted(deps, pending, (id) => fetchReceivedMail(id, apiKey))
await app.pool.end()

console.table(results.map((r) => ({ delivery: r.providerId, outcome: r.outcome })))
const tally = new Map<string, number>()
for (const r of results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1)
console.log(Object.fromEntries(tally))
// Still unrouted (no mailbox yet) or not fetchable: say so, and let the next run try again.
if (results.some((r) => r.outcome === 'failed')) process.exit(1)
