/**
 * Runs mail that arrived before its mailbox was registered through intake again.
 *   pnpm mail:replay-unrouted [--dry-run]
 *
 * Mail addressed to nobody's mailbox is dropped with only a content-free note (provider id and
 * arrival time), because nothing of it may be kept for no one. Once the mailbox exists, this
 * fetches those Resend ids again, with their original arrival time, and runs each through the
 * same intake as live mail. Marks nothing: a delivery that now routes is recorded under its
 * user, and leaves the list once its mail has a final verdict (verified or rejected), so running
 * it twice does the work once. A delivery that ends 'retry' (DNS trouble), 'unrouted' (still no
 * mailbox) or failed (Resend cannot return it any more) stays listed, and the command exits 1:
 * run it again.
 *
 * Two connections: the owner (DATABASE_URL_MIGRATIONS) only lists the unrouted deliveries, which
 * the app role cannot read; intake itself runs as warren_app (DATABASE_URL), under row-level
 * security. Needs RESEND_API_KEY and the Blob store (see mail:parse-pending).
 */
import {
  defaultTxtResolver,
  fetchReceivedMail,
  type IntakeDeps,
  replayIncomplete,
  replayUnrouted,
  SENDERS,
} from '@warren/core'
import { createTenancy, system } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'
import { connect, die, has } from './lib'

const apiKey = process.env.RESEND_API_KEY
if (!apiKey) die('Set RESEND_API_KEY (the key the webhook uses to fetch received mail).')

const owner = connect('DATABASE_URL_MIGRATIONS')
// Only Resend deliveries can be fetched again here.
const pending = await system.pendingUnrouted(owner.database, 'resend')
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

console.table(
  results.map((r) => ({ delivery: r.providerId, outcome: r.outcome, error: r.error ?? '' })),
)
const tally = new Map<string, number>()
for (const r of results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1)
console.log(Object.fromEntries(tally))
// Not final yet (retry, no mailbox yet, not fetchable): say so, and let the next run try again.
const unfinished = results.filter(replayIncomplete).length
if (unfinished > 0) {
  console.error(
    `${unfinished} deliver${unfinished === 1 ? 'y is' : 'ies are'} not final: run it again`,
  )
  process.exit(1)
}
