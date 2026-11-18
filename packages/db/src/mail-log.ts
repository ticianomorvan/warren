import type {
  FinalVerdict,
  MailLog,
  MailVerdict,
  NewMail,
  ParseResult,
  PendingParse,
} from '@warren/core'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Scope } from './client'
import { blobFile, inboundMail, mailDelivery, mailParse, mailVerdict } from './schema'

// What is sealed here: a verdict's subject and detail, and a parse's operation. The associated
// data names the user (added by the scope), the table, the mail and the column.
const verdictAad = (mailId: string, column: 'subject' | 'detail') =>
  `mail_verdict:${mailId}:${column}`
const parseAad = (mailId: string, templateSetVersion: number) =>
  `mail_parse:${mailId}:${templateSetVersion}:operation`

/** One user's mail log. Reads and writes run under that user's row-level security. */
export function createMailLog(scope: Scope): MailLog {
  const { tx } = scope
  return {
    async findDelivery(provider, providerId) {
      const rows = await tx
        .select({ mailId: mailDelivery.mailId })
        .from(mailDelivery)
        .where(and(eq(mailDelivery.provider, provider), eq(mailDelivery.providerId, providerId)))
        .limit(1)
      return rows[0]?.mailId ?? null
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
        subject: row.subject ? scope.openText(row.subject, verdictAad(mailId, 'subject')) : '',
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
        const detail = 'detail' in verdict ? verdict.detail : undefined
        await tx.insert(mailVerdict).values({
          ...base,
          reason: verdict.reason,
          detail: detail ? scope.seal(detail, verdictAad(mailId, 'detail')) : null,
          fromAddress: verdict.fromAddress,
        })
      }
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
              ? scope.sealJson(result.operation, parseAad(mailId, templateSetVersion))
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
                subject: r.subject
                  ? scope.openText(r.subject, verdictAad(r.mailId, 'subject'))
                  : '',
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
    subject: r.subject ? scope.openText(r.subject, verdictAad(r.mailId, 'subject')) : null,
    detail: r.detail ? scope.openText(r.detail, verdictAad(r.mailId, 'detail')) : null,
  }))
}

/** What the latest verdicts and parses add up to, for `pnpm mail:status`. */
export type MailCounts = { mails: number; verified: number; rejected: number; parsed: number }

export async function mailCounts(scope: Scope): Promise<MailCounts> {
  const rows = await recentMail(scope, 1_000_000)
  return {
    mails: rows.length,
    verified: rows.filter((r) => r.verdict === 'verified').length,
    rejected: rows.filter((r) => r.verdict === 'rejected').length,
    parsed: rows.filter((r) => r.parse === 'parsed').length,
  }
}
