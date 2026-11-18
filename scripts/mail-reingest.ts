/**
 * Replays one user's raw mail from an archived database through the current intake, so a
 * ledger rebuilt from scratch holds the same mail, sealed under the user's key.
 *
 *   pnpm mail:reingest --user <id> --from <archive url>
 *
 * The archive is a Neon branch of the old, single-owner database: plaintext tables
 * (inbound_mail, blob_file, mail_delivery, mail_verdict, mail_parse). It is only read.
 * Each raw file is read from the old Blob path, checked against its SHA-256, then goes through
 * the same intake as live mail: sealed, recorded, verified, parsed, ledgered. Rule 4 still
 * decides, so the user's mailbox must be registered first (pnpm mailbox:add).
 *
 * `receivedAt` comes from the archive, so the date-skew check judges the original arrival. DKIM
 * keys come from the archived verdicts when it has them, so a bank key rotated since does not
 * reject old mail. Safe to run again: mail already done is a 'duplicate'.
 *
 * It ends by comparing the archive's verified and parsed counts with what the new ledger holds,
 * and names every mail that differs. It deletes nothing: the old content-addressed blobs go
 * only after those counts check out.
 */
import {
  defaultTxtResolver,
  type IntakeDeps,
  intakeForUser,
  SENDERS,
  sha256Hex,
  type TxtResolver,
} from '@warren/core'
import { asUser, createPool, createTenancy, mailCounts, recentMail } from '@warren/db'
import { rawStore } from '../apps/web/lib/raw-store'
import { connect, die, flag, userArg } from './lib'

const user = userArg()
const archiveUrl = flag('from')
if (!archiveUrl) die('usage: pnpm mail:reingest --user <id> --from <archive url>')

type ArchivedMail = {
  sha256: string
  received_at: Date
  pathname: string
  verified: boolean
  parsed: boolean
}
const archive = createPool(archiveUrl, 1)
const mails = (
  await archive.query<ArchivedMail>(`
    select i.sha256, i.received_at, b.pathname,
           coalesce((select v.verdict = 'verified' from mail_verdict v
                     where v.mail_sha256 = i.sha256 and v.verdict in ('verified', 'rejected')
                     order by v.id desc limit 1), false) as verified,
           exists (select 1 from mail_parse p where p.mail_sha256 = i.sha256 and p.status = 'parsed') as parsed
    from inbound_mail i join blob_file b on b.sha256 = i.sha256
    order by i.received_at, i.sha256`)
).rows
const deliveries = (
  await archive.query<{ mail_sha256: string; provider: string; provider_id: string }>(
    'select mail_sha256, provider, provider_id from mail_delivery order by recorded_at',
  )
).rows
const keys = (
  await archive.query<{ name: string; record: string }>(`
    select distinct on (selector, signing_domain)
           selector || '._domainkey.' || signing_domain as name, key_record as record
    from mail_verdict
    where verdict = 'verified' and key_record is not null and key_record <> ''
    order by selector, signing_domain, id desc`)
).rows
await archive.end()

// What the bank's key was when the mail was verified; live DNS for anything else.
const archived = new Map(keys.map((k) => [k.name.toLowerCase(), k.record]))
const resolver: TxtResolver = async (name, rrtype) => {
  const record = archived.get(name.toLowerCase())
  return record ? [[record]] : defaultTxtResolver(name, rrtype)
}
const { pool, database } = connect('DATABASE_URL')
const files = rawStore()
const deps: IntakeDeps = {
  tenancy: createTenancy(database, files),
  resolver,
  senders: SENDERS,
  maxDateSkewMinutes: 120,
}
/** For each archived mail: its id in the new ledger (null when the raw file is gone), and what intake said. */
const replayed = new Map<string, { mailId: string | null; note: string }>()

for (const mail of mails) {
  const raw = await files.get(mail.pathname)
  if (!raw || sha256Hex(raw) !== mail.sha256) {
    replayed.set(mail.sha256, { mailId: null, note: 'raw file missing or changed' })
    continue
  }
  const own = deliveries.filter((d) => d.mail_sha256 === mail.sha256)
  const list = own.length > 0 ? own : [{ provider: 'reingest', provider_id: mail.sha256 }]
  for (const [i, d] of list.entries()) {
    const result = await intakeForUser(deps, user, {
      raw,
      provider: d.provider,
      providerId: d.provider_id,
      receivedAt: mail.received_at,
    })
    if (i === 0 && result.mailId) {
      const note = [result.outcome, result.reason ?? result.parseReason].filter(Boolean).join(': ')
      replayed.set(mail.sha256, { mailId: result.mailId, note })
    }
  }
}

// Judge by what the new ledger holds, not by what this run did, so a rerun says the same.
const now = await asUser(database, user, async (scope) => ({
  counts: await mailCounts(scope),
  rows: new Map((await recentMail(scope, 1_000_000)).map((r) => [r.mailId, r])),
}))
await pool.end()

const archiveVerified = mails.filter((m) => m.verified).length
const archiveParsed = mails.filter((m) => m.parsed).length
console.log({
  archive: { mails: mails.length, verified: archiveVerified, parsed: archiveParsed },
  now: now.counts,
})
const different = mails.filter((m) => {
  const id = replayed.get(m.sha256)?.mailId
  const row = id ? now.rows.get(id) : undefined
  return (
    !row || (row.verdict === 'verified') !== m.verified || (row.parse === 'parsed') !== m.parsed
  )
})
if (
  different.length === 0 &&
  now.counts.verified === archiveVerified &&
  now.counts.parsed === archiveParsed
) {
  console.log('Counts match: every archived mail is verified and parsed as it was.')
} else {
  console.log(`${different.length} mail(s) differ from the archive:`)
  console.table(
    different.map((m) => {
      const id = replayed.get(m.sha256)?.mailId
      const row = id ? now.rows.get(id) : undefined
      return {
        archive_mail: m.sha256.slice(0, 8),
        received: m.received_at.toISOString().slice(0, 19).replace('T', ' '),
        was: `${m.verified ? 'verified' : 'not verified'}, ${m.parsed ? 'parsed' : 'not parsed'}`,
        now: row
          ? `${row.verdict ?? 'unchecked'}${row.reason ? `: ${row.reason}` : ''}, ${row.parse ?? 'not parsed'}`
          : (replayed.get(m.sha256)?.note ?? 'not replayed'),
      }
    }),
  )
  process.exit(1)
}
