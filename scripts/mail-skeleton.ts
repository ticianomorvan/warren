/**
 * Prints the value-free skeleton of a user's stored mail from one sender: tag structure, with
 * text shown only where every mail of a layout has the same text, and shape classes elsewhere.
 *   pnpm mail:skeleton --user <id> --sender <senderId> [--subject <regex>]
 * Reads the sealed raw files from the Blob store, so it needs store credentials:
 *   pnpm dlx vercel env pull .vercel/.env.development.local
 * Prints the skeleton only: no headers, addresses, ids, subjects or per-value counts.
 */
import { decodeSubject, htmlPart, SkeletonError, skeleton } from '@warren/core'
import { asUser, userContext, verifiedMailOf } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'
import { connect, die, flag, userArg } from './lib'

const user = userArg()
const sender = flag('sender')
if (!sender) die('Pass --sender <sender id>.')
const pattern = flag('subject')
let subjectFilter: RegExp | undefined
try {
  subjectFilter = pattern ? new RegExp(pattern) : undefined
} catch {
  die('--subject must be a valid regular expression.')
}

const { pool, database } = connect('DATABASE_URL')
const htmls = await asUser(database, user, async (scope) => {
  const ctx = await userContext(scope, rawStore())
  const out: string[] = []
  for (const mail of await verifiedMailOf(scope, sender)) {
    if (subjectFilter && !subjectFilter.test(decodeSubject(mail.subject))) continue
    const raw = await ctx.store.get(mail.pathname)
    if (!raw || ctx.mailId(raw) !== mail.mailId) continue
    const html = await htmlPart(raw)
    if (html) out.push(html)
  }
  return out
})
await pool.end()

try {
  console.log(skeleton(htmls))
} catch (error) {
  if (error instanceof SkeletonError) die(error.message)
  throw error
}
