import type { FinalVerdict, MailLog, MailVerdict, NewMail, ParseResult } from '@warren/core'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from './client'
import { blobFile, inboundMail, mailDelivery, mailParse, mailVerdict } from './schema'

export function createMailLog(db: Db): MailLog {
  return {
    async findDelivery(provider, providerId) {
      const rows = await db
        .select({ sha256: mailDelivery.mailSha256 })
        .from(mailDelivery)
        .where(and(eq(mailDelivery.provider, provider), eq(mailDelivery.providerId, providerId)))
        .limit(1)
      return rows[0]?.sha256 ?? null
    },

    async recordMail(mail: NewMail) {
      await db.transaction(async (tx) => {
        await tx
          .insert(blobFile)
          .values({
            sha256: mail.sha256,
            pathname: mail.pathname,
            mime: 'message/rfc822',
            bytes: mail.bytes,
          })
          .onConflictDoNothing()
        await tx
          .insert(inboundMail)
          .values({ sha256: mail.sha256, receivedAt: mail.receivedAt })
          .onConflictDoNothing()
        await tx
          .insert(mailDelivery)
          .values({ provider: mail.provider, providerId: mail.providerId, mailSha256: mail.sha256 })
          .onConflictDoNothing()
      })
    },

    async finalVerdict(sha256): Promise<FinalVerdict | null> {
      const rows = await db
        .select()
        .from(mailVerdict)
        .where(
          and(
            eq(mailVerdict.mailSha256, sha256),
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
        subject: row.subject ?? '',
        signedDate: row.signedDate,
      }
    },

    async recordVerdict(sha256, verdict: MailVerdict, policyVersion) {
      const base = { mailSha256: sha256, verdict: verdict.verdict, policyVersion }
      if (verdict.verdict === 'verified') {
        await db.insert(mailVerdict).values({
          ...base,
          senderId: verdict.senderId,
          fromAddress: verdict.fromAddress,
          signingDomain: verdict.signingDomain,
          selector: verdict.selector,
          keyRecord: verdict.keyRecord,
          signedHeaders: verdict.signedHeaders,
          subject: verdict.subject,
          signedDate: verdict.signedDate,
        })
      } else {
        await db.insert(mailVerdict).values({
          ...base,
          reason: verdict.reason,
          detail: 'detail' in verdict ? (verdict.detail ?? null) : null,
          fromAddress: verdict.fromAddress,
        })
      }
    },

    async hasParse(sha256, templateSetVersion) {
      const rows = await db
        .select({ id: mailParse.id })
        .from(mailParse)
        .where(
          and(
            eq(mailParse.mailSha256, sha256),
            eq(mailParse.templateSetVersion, templateSetVersion),
          ),
        )
        .limit(1)
      return rows.length > 0
    },

    async recordParse(sha256, templateSetVersion, result: ParseResult) {
      await db
        .insert(mailParse)
        .values({
          mailSha256: sha256,
          templateSetVersion,
          status: result.status,
          templateId: result.templateId,
          templateVersion: result.templateVersion,
          reason: result.status === 'unparsed' ? result.reason : null,
          operation: result.status === 'parsed' ? result.operation : null,
        })
        .onConflictDoNothing()
    },

    async pendingParses(templateSetVersion) {
      const rows = await db
        .select({
          sha256: mailVerdict.mailSha256,
          pathname: blobFile.pathname,
          senderId: mailVerdict.senderId,
          subject: mailVerdict.subject,
          signedDate: mailVerdict.signedDate,
        })
        .from(mailVerdict)
        .innerJoin(blobFile, eq(blobFile.sha256, mailVerdict.mailSha256))
        .leftJoin(
          mailParse,
          and(
            eq(mailParse.mailSha256, mailVerdict.mailSha256),
            eq(mailParse.templateSetVersion, templateSetVersion),
          ),
        )
        .where(and(eq(mailVerdict.verdict, 'verified'), isNull(mailParse.id)))
        .orderBy(mailVerdict.id)
      return rows.flatMap((r) =>
        r.senderId && r.signedDate
          ? [
              {
                sha256: r.sha256,
                pathname: r.pathname,
                senderId: r.senderId,
                subject: r.subject ?? '',
                signedDate: r.signedDate,
              },
            ]
          : [],
      )
    },
  }
}

export type MailStatusRow = {
  sha256: string
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

/** Latest mails with their current status, newest first. */
export async function recentMail(db: Db, limit = 20): Promise<MailStatusRow[]> {
  const latest = db
    .selectDistinctOn([mailVerdict.mailSha256])
    .from(mailVerdict)
    .orderBy(mailVerdict.mailSha256, desc(mailVerdict.id))
    .as('latest')
  const attempts = db
    .select({ sha: mailVerdict.mailSha256, n: sql<number>`count(*)::int`.as('n') })
    .from(mailVerdict)
    .groupBy(mailVerdict.mailSha256)
    .as('attempts')
  const parse = db
    .selectDistinctOn([mailParse.mailSha256])
    .from(mailParse)
    .orderBy(mailParse.mailSha256, desc(mailParse.templateSetVersion))
    .as('parse')
  return db
    .select({
      sha256: inboundMail.sha256,
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
    .innerJoin(blobFile, eq(blobFile.sha256, inboundMail.sha256))
    .leftJoin(latest, eq(latest.mailSha256, inboundMail.sha256))
    .leftJoin(attempts, eq(attempts.sha, inboundMail.sha256))
    .leftJoin(parse, eq(parse.mailSha256, inboundMail.sha256))
    .orderBy(desc(inboundMail.receivedAt))
    .limit(limit)
}
