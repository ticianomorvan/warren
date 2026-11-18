/**
 * Prints the value-free skeleton of a user's stored mail from one sender: tag structure, with
 * text shown only where every mail of a layout has the same text, and shape classes elsewhere.
 *   pnpm mail:skeleton --user <id> --sender <senderId> [--subject <regex>]
 * Reads the sealed raw files from the Blob store, so it needs store credentials:
 *   pnpm dlx vercel env pull .vercel/.env.development.local
 * It also reads the user's name and email as warren_auth (DATABASE_URL_AUTH), to keep them,
 * their mailbox addresses and the parts of those out of the output; without that URL it refuses.
 * Prints the skeleton only: no headers, addresses, ids, subjects or per-value counts. Skipped
 * mail is reported on stderr as counts, and only when a skeleton was printed.
 */
import { decodeSubject, forbiddenTokens, htmlPart, SkeletonError, skeleton } from '@warren/core'
import { asUser, userContext, userIdentity, verifiedMailOf } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'
import { connect, connectKeyless, die, flag, userArg } from './lib'

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
if (!process.env.DATABASE_URL_AUTH) {
  die('Set DATABASE_URL_AUTH: the skeleton needs the user name to keep it out of the output.')
}

const auth = connectKeyless('DATABASE_URL_AUTH')
const identity = await userIdentity(auth.database, user)
await auth.pool.end()
if (!identity) die('No such user.')

const { pool, database } = connect('DATABASE_URL')
const skipped = { mismatched: 0, missing: 0, noHtml: 0 }
const { htmls, mailboxes } = await asUser(database, user, async (scope) => {
  const ctx = await userContext(scope, rawStore())
  const out: string[] = []
  for (const mail of await verifiedMailOf(scope, sender)) {
    if (subjectFilter && !subjectFilter.test(decodeSubject(mail.subject))) continue
    const raw = await ctx.store.get(mail.pathname)
    if (!raw) skipped.missing++
    else if (ctx.mailId(raw) !== mail.mailId) skipped.mismatched++
    else {
      const html = await htmlPart(raw)
      if (html) out.push(html)
      else skipped.noHtml++
    }
  }
  return { htmls: out, mailboxes: ctx.mailboxes }
})
await pool.end()

const forbidden = forbiddenTokens([identity.email, identity.name, ...mailboxes])
try {
  console.log(skeleton(htmls, { forbidden }))
} catch (error) {
  if (error instanceof SkeletonError) die(error.message)
  throw error
}
const { mismatched, missing, noHtml } = skipped
if (mismatched + missing + noHtml > 0) {
  console.error(
    `Skipped: ${mismatched} with a mismatched id, ${missing} with no file, ${noHtml} with no html part.`,
  )
}
