import type {
  FinalVerdict,
  MailLog,
  MailVerdict,
  NewMail,
  ParseResult,
  PendingParse,
} from '@warren/core'
import { and, desc, eq, gte, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm'
import type { Scope } from './client'
import { blobFile, inboundMail, mailbox, mailDelivery, mailParse, mailVerdict } from './schema'

// What is sealed here: a verdict's subject and detail, and a parse's operation. The associated
// data names the user (added by the scope), the table, the mail and the column.
const verdictAad = (mailId: string, column: 'subject' | 'detail') =>
  `mail_verdict:${mailId}:${column}`
const parseAad = (mailId: string, templateSetVersion: number) =>
  `mail_parse:${mailId}:${templateSetVersion}:operation`

const text = (scope: Scope, sealed: Uint8Array, aad: string) =>
  scope.open(sealed, aad).toString('utf8')

/** One user's mail log. Reads and writes run under that user's row-level security. */
export function createMailLog(scope: Scope): MailLog {
  const { tx } = scope
  /**
   * Mails whose latest verified-or-rejected verdict is a rejection for `reason`, oldest first,
   * optionally received since a date or judged under a policy older than a version.
   */
  const rejectedBy = (reason: string, beforePolicyVersion?: number, since?: Date) => {
    const latest = tx
      .selectDistinctOn([mailVerdict.mailId], {
        mailId: mailVerdict.mailId,
        verdict: mailVerdict.verdict,
        reason: mailVerdict.reason,
        policyVersion: mailVerdict.policyVersion,
      })
      .from(mailVerdict)
      .where(inArray(mailVerdict.verdict, ['verified', 'rejected']))
      .orderBy(mailVerdict.mailId, desc(mailVerdict.id))
      .as('latest')
    const filters: SQL[] = [eq(latest.verdict, 'rejected'), eq(latest.reason, reason)]
    if (beforePolicyVersion !== undefined)
      filters.push(lt(latest.policyVersion, beforePolicyVersion))
    if (since) filters.push(gte(inboundMail.receivedAt, since))
    return tx
      .select({
        mailId: latest.mailId,
        pathname: blobFile.pathname,
        receivedAt: inboundMail.receivedAt,
      })
      .from(latest)
      .innerJoin(blobFile, eq(blobFile.mailId, latest.mailId))
      .innerJoin(inboundMail, eq(inboundMail.mailId, latest.mailId))
      .where(and(...filters))
      .orderBy(inboundMail.receivedAt)
  }
  return {
    async hasMail(mailId) {
      const rows = await tx
        .select({ mailId: blobFile.mailId })
        .from(blobFile)
        .where(eq(blobFile.mailId, mailId))
        .limit(1)
      return rows.length > 0
    },

    async recordMail(mail: NewMail) {
      await tx
        .insert(blobFile)
        .values({
          mailId: mail.mailId,
          pathname: mail.pathname,
          mime: 'message/rfc822',
          bytes: mail.bytes,
        })
        .onConflictDoNothing()
      await tx
        .insert(inboundMail)
        .values({ mailId: mail.mailId, receivedAt: mail.receivedAt })
        .onConflictDoNothing()
      await tx
        .insert(mailDelivery)
        .values({ provider: mail.provider, providerId: mail.providerId, mailId: mail.mailId })
        .onConflictDoNothing()
    },

    async finalVerdict(mailId): Promise<FinalVerdict | null> {
      const rows = await tx
        .select()
        .from(mailVerdict)
        .where(
          and(
            eq(mailVerdict.mailId, mailId),
            inArray(mailVerdict.verdict, ['verified', 'rejected']),
          ),
        )
        .orderBy(desc(mailVerdict.id))
        .limit(1)
      const row = rows[0]
      if (!row) return null
      if (row.verdict !== 'verified' || !row.senderId || !row.signedDate)
        return { verdict: 'rejected' }
      return {
        verdict: 'verified',
        senderId: row.senderId,
        subject: row.subject ? text(scope, row.subject, verdictAad(mailId, 'subject')) : '',
        signedDate: row.signedDate,
      }
    },

    async recordVerdict(mailId, verdict: MailVerdict, policyVersion) {
      const base = { mailId, verdict: verdict.verdict, policyVersion }
      if (verdict.verdict === 'verified') {
        await tx.insert(mailVerdict).values({
          ...base,
          senderId: verdict.senderId,
          fromAddress: verdict.fromAddress,
          signingDomain: verdict.signingDomain,
          selector: verdict.selector,
          keyRecord: verdict.keyRecord,
          signedHeaders: verdict.signedHeaders,
          subject: scope.seal(verdict.subject, verdictAad(mailId, 'subject')),
          signedDate: verdict.signedDate,
        })
      } else {
        // The From address is the bank's only once it matched an allow-listed sender. Before
        // that it is whoever sent the mail (the user's own address, when they forward by hand),
        // and this table is append-only and outlives erasure: that address goes sealed, into
        // `detail`, which has nothing else to say for those reasons.
        const matched = verdict.senderId !== undefined
        const detail = 'detail' in verdict ? verdict.detail : undefined
        const sealed = detail ?? (matched ? undefined : (verdict.fromAddress ?? undefined))
        await tx.insert(mailVerdict).values({
          ...base,
          reason: verdict.reason,
          detail: sealed ? scope.seal(sealed, verdictAad(mailId, 'detail')) : null,
          fromAddress: matched ? verdict.fromAddress : null,
        })
      }
    },

    async rejectedNotAddressed(since) {
      return rejectedBy('not-addressed-to-user', undefined, since)
    },

    async rejectedUnknownSender(beforePolicyVersion) {
      return rejectedBy('unknown-sender', beforePolicyVersion)
    },

    async hasParse(mailId, templateSetVersion) {
      const rows = await tx
        .select({ id: mailParse.id })
        .from(mailParse)
        .where(
          and(eq(mailParse.mailId, mailId), eq(mailParse.templateSetVersion, templateSetVersion)),
        )
        .limit(1)
      return rows.length > 0
    },

    async recordParse(mailId, templateSetVersion, result: ParseResult) {
      await tx
        .insert(mailParse)
        .values({
          mailId,
          templateSetVersion,
          status: result.status,
          templateId: result.templateId,
          templateVersion: result.templateVersion,
          reason: result.status === 'unparsed' ? result.reason : null,
          operation:
            result.status === 'parsed'
              ? scope.json.seal(result.operation, parseAad(mailId, templateSetVersion))
              : null,
        })
        .onConflictDoNothing()
    },

    async pendingParses(templateSetVersion): Promise<PendingParse[]> {
      const rows = await tx
        .select({
          mailId: mailVerdict.mailId,
          pathname: blobFile.pathname,
          senderId: mailVerdict.senderId,
          subject: mailVerdict.subject,
          signedDate: mailVerdict.signedDate,
        })
        .from(mailVerdict)
        .innerJoin(blobFile, eq(blobFile.mailId, mailVerdict.mailId))
        .leftJoin(
          mailParse,
          and(
            eq(mailParse.mailId, mailVerdict.mailId),
            eq(mailParse.templateSetVersion, templateSetVersion),
          ),
        )
        .where(and(eq(mailVerdict.verdict, 'verified'), isNull(mailParse.id)))
        .orderBy(mailVerdict.id)
      return rows.flatMap((r) =>
        r.senderId && r.signedDate
          ? [
              {
                mailId: r.mailId,
                pathname: r.pathname,
                senderId: r.senderId,
                subject: r.subject ? text(scope, r.subject, verdictAad(r.mailId, 'subject')) : '',
                signedDate: r.signedDate,
              },
            ]
          : [],
      )
    },
  }
}

export type MailStatusRow = {
  mailId: string
  receivedAt: Date
  bytes: number
  verdict: string | null
  reason: string | null
  detail: string | null
  senderId: string | null
  fromAddress: string | null
  subject: string | null
  attempts: number
  parse: string | null
  parseReason: string | null
  template: string | null
}

/** The user's latest mails with their current status, newest first. */
export async function recentMail(scope: Scope, limit = 20): Promise<MailStatusRow[]> {
  const { tx } = scope
  const latest = tx
    .selectDistinctOn([mailVerdict.mailId])
    .from(mailVerdict)
    .orderBy(mailVerdict.mailId, desc(mailVerdict.id))
    .as('latest')
  const attempts = tx
    .select({ mailId: mailVerdict.mailId, n: sql<number>`count(*)::int`.as('n') })
    .from(mailVerdict)
    .groupBy(mailVerdict.mailId)
    .as('attempts')
  const parse = tx
    .selectDistinctOn([mailParse.mailId])
    .from(mailParse)
    .orderBy(mailParse.mailId, desc(mailParse.templateSetVersion))
    .as('parse')
  const rows = await tx
    .select({
      mailId: inboundMail.mailId,
      receivedAt: inboundMail.receivedAt,
      bytes: blobFile.bytes,
      verdict: latest.verdict,
      reason: latest.reason,
      detail: latest.detail,
      senderId: latest.senderId,
      fromAddress: latest.fromAddress,
      subject: latest.subject,
      attempts: sql<number>`coalesce(${attempts.n}, 0)`,
      parse: parse.status,
      parseReason: parse.reason,
      template: parse.templateId,
    })
    .from(inboundMail)
    .innerJoin(blobFile, eq(blobFile.mailId, inboundMail.mailId))
    .leftJoin(latest, eq(latest.mailId, inboundMail.mailId))
    .leftJoin(attempts, eq(attempts.mailId, inboundMail.mailId))
    .leftJoin(parse, eq(parse.mailId, inboundMail.mailId))
    .orderBy(desc(inboundMail.receivedAt))
    .limit(limit)
  return rows.map((r) => ({
    ...r,
    subject: r.subject ? text(scope, r.subject, verdictAad(r.mailId, 'subject')) : null,
    detail: r.detail ? text(scope, r.detail, verdictAad(r.mailId, 'detail')) : null,
  }))
}

/** What the latest verdicts and parses add up to, for `pnpm mail:status`. */
export type MailCounts = { mails: number; verified: number; rejected: number; parsed: number }

export async function mailCounts(scope: Scope): Promise<MailCounts> {
  const { tx } = scope
  // The same "latest verdict, latest parse" as recentMail, counted by the database: nothing
  // is opened, so a mailbox of any size is four numbers.
  const latest = tx
    .selectDistinctOn([mailVerdict.mailId], {
      mailId: mailVerdict.mailId,
      verdict: mailVerdict.verdict,
    })
    .from(mailVerdict)
    .orderBy(mailVerdict.mailId, desc(mailVerdict.id))
    .as('latest')
  const parse = tx
    .selectDistinctOn([mailParse.mailId], { mailId: mailParse.mailId, status: mailParse.status })
    .from(mailParse)
    .orderBy(mailParse.mailId, desc(mailParse.templateSetVersion))
    .as('parse')
  const rows = await tx
    .select({
      mails: sql<number>`count(*)::int`,
      verified: sql<number>`(count(*) filter (where ${latest.verdict} = 'verified'))::int`,
      rejected: sql<number>`(count(*) filter (where ${latest.verdict} = 'rejected'))::int`,
      parsed: sql<number>`(count(*) filter (where ${parse.status} = 'parsed'))::int`,
    })
    .from(inboundMail)
    .innerJoin(blobFile, eq(blobFile.mailId, inboundMail.mailId))
    .leftJoin(latest, eq(latest.mailId, inboundMail.mailId))
    .leftJoin(parse, eq(parse.mailId, inboundMail.mailId))
  return rows[0] ?? { mails: 0, verified: 0, rejected: 0, parsed: 0 }
}

/**
 * A user's mail of one sender whose latest verdict is verified, oldest first, one row per mail,
 * with the signed subject opened.
 */
export async function verifiedMailOf(scope: Scope, senderId: string): Promise<PendingParse[]> {
  const { tx } = scope
  const latest = tx
    .selectDistinctOn([mailVerdict.mailId], {
      mailId: mailVerdict.mailId,
      id: mailVerdict.id,
      verdict: mailVerdict.verdict,
      senderId: mailVerdict.senderId,
      subject: mailVerdict.subject,
      signedDate: mailVerdict.signedDate,
    })
    .from(mailVerdict)
    .orderBy(mailVerdict.mailId, desc(mailVerdict.id))
    .as('latest')
  const rows = await tx
    .select({
      mailId: latest.mailId,
      pathname: blobFile.pathname,
      subject: latest.subject,
      signedDate: latest.signedDate,
    })
    .from(latest)
    .innerJoin(blobFile, eq(blobFile.mailId, latest.mailId))
    .where(and(eq(latest.verdict, 'verified'), eq(latest.senderId, senderId)))
    .orderBy(latest.id)
  return rows.flatMap((r) =>
    r.signedDate
      ? [
          {
            mailId: r.mailId,
            pathname: r.pathname,
            senderId,
            subject: r.subject ? text(scope, r.subject, verdictAad(r.mailId, 'subject')) : '',
            signedDate: r.signedDate,
          },
        ]
      : [],
  )
}

/** Where a person's first mail stands since they connected a Gmail. Nothing in it is mail content. */
export type MailProgress =
  | { state: 'waiting' }
  | { state: 'rejected'; reason: string | null }
  | { state: 'verified'; templateId: string | null; signedDate: Date }

/**
 * For the onboarding page: of the mails whose latest verdict came after the user's first mailbox
 * was connected (so a mail the claim re-checked counts, and history from before does not), the
 * earliest verified one wins, else the newest rejected one, else waiting. Two queries of one row
 * each, so a flood of rejections cannot push a verified mail out. Reads the clear verdict columns
 * and the template id only; no mail is opened.
 */
export async function firstMailProgress(scope: Scope): Promise<MailProgress> {
  const { tx } = scope
  const claimed = await tx
    .select({ at: sql<Date | null>`min(${mailbox.createdAt})` })
    .from(mailbox)
    .where(eq(mailbox.userId, scope.userId))
  const since = claimed[0]?.at
  if (!since) return { state: 'waiting' }
  const latest = tx
    .selectDistinctOn([mailVerdict.mailId])
    .from(mailVerdict)
    .orderBy(mailVerdict.mailId, desc(mailVerdict.id))
    .as('latest')
  const parse = tx
    .selectDistinctOn([mailParse.mailId])
    .from(mailParse)
    .orderBy(mailParse.mailId, desc(mailParse.templateSetVersion))
    .as('parse')
  const columns = {
    reason: latest.reason,
    signedDate: latest.signedDate,
    templateId: parse.templateId,
  }
  const after = gte(latest.checkedAt, new Date(since))
  const first = await tx
    .select(columns)
    .from(latest)
    .leftJoin(parse, eq(parse.mailId, latest.mailId))
    .where(and(after, eq(latest.verdict, 'verified')))
    .orderBy(latest.id)
    .limit(1)
  const ok = first[0]
  if (ok?.signedDate)
    return { state: 'verified', templateId: ok.templateId, signedDate: ok.signedDate }
  const bad = await tx
    .select({ reason: latest.reason })
    .from(latest)
    .where(and(after, eq(latest.verdict, 'rejected')))
    .orderBy(desc(latest.id))
    .limit(1)
  return bad[0] ? { state: 'rejected', reason: bad[0].reason } : { state: 'waiting' }
}
