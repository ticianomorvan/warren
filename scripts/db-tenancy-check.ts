/**
 * Proves, on a real branch through the pooler, that Postgres keeps users apart.
 *
 *   pnpm db:tenancy-check <warren_app url> --owner <owner direct url> [--auth <warren_auth url>] [--negative]
 *
 * It makes two throwaway users with a row in every table, then runs the same code as
 * `pnpm test` (packages/db/src/tenancy-check.ts) over one connection:
 *   - the catalog: row-level security, policies and keys on every table, and the grants;
 *   - as warren_app, user A reads only A's rows and B only B's, on every table, with no user it
 *     reads nothing, and it cannot insert another user's row;
 *   - two parallel asUser calls on a pool of one connection do not leak the user context;
 *   - as warren_auth (when given), no ledger table is readable.
 * --negative drops one policy first, runs the check, and passes only if the check FAILS, then
 * puts the policy back.
 *
 * Run it on a Neon branch of production, never on production: it writes fixture rows, and the
 * append-only tables keep them. It takes URLs only from its arguments, and never reads
 * apps/web/.env.local. The users' keys are wrapped by a throwaway master key.
 */
import { randomBytes } from 'node:crypto'
import { masterKeysFromEnv } from '@warren/core'
import { createDatabase, createPool } from '@warren/db'
import { runTenancyCheck, withPolicyDropped } from '@warren/db/tenancy-check'
import { die, flag, has, positionals } from './lib'

const appUrl = positionals(['owner', 'auth'])[0]
const ownerUrl = flag('owner')
if (!appUrl || !ownerUrl) {
  die(
    'usage: pnpm db:tenancy-check <warren_app url> --owner <owner url> [--auth <url>] [--negative]',
  )
}
const masters = masterKeysFromEnv({ WARREN_MASTER_KEY: randomBytes(32).toString('base64') })
// A pool of one: every call queues on the same session, as it does behind the Neon pooler.
const pools = {
  app: createPool(appUrl, 1),
  owner: createPool(ownerUrl, 1),
  auth: flag('auth') ? createPool(flag('auth') as string, 1) : null,
}
const owner = createDatabase(pools.owner, masters)
const options = {
  owner,
  app: createDatabase(pools.app, masters),
  ...(pools.auth ? { auth: createDatabase(pools.auth, masters) } : {}),
}

const run = () => runTenancyCheck(options)
const checks = has('negative')
  ? await withPolicyDropped(owner, 'mail_delivery', 'mail_delivery_select', run)
  : await run()
await Promise.all([pools.app.end(), pools.owner.end(), pools.auth?.end()])

for (const c of checks)
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : `\n       ${c.detail}`}`)
const failed = checks.filter((c) => !c.ok).length
if (has('negative')) {
  console.log(
    failed > 0
      ? `\nnegative run: the check failed as it should (${failed})`
      : '\nnegative run: the check PASSED with a policy dropped, so it proves nothing',
  )
  process.exit(failed > 0 ? 0 : 1)
}
console.log(
  failed === 0
    ? `\nall ${checks.length} checks passed`
    : `\n${failed} of ${checks.length} checks failed`,
)
process.exit(failed === 0 ? 0 : 1)
