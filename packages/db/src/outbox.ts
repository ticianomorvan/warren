import {
  type AttemptRecord,
  NOTICE_MAX_AGE_HOURS,
  type NoticeMovement,
  type OpenNotice,
  type Outbox,
} from '@warren/core'
import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Scope } from './client'
import { account, movement, notice, noticeAttempt, noticeStatus } from './schema'

// Sealed: a notice attempt's text and the provider's detail. The scope adds the user.
const attemptAad = (noticeId: number, column: 'body' | 'detail') =>
  `notice_attempt:${noticeId}:${column}`

/** One user's outbox. */
export function createOutbox(scope: Scope): Outbox {
  const { tx } = scope
  return {
    async owed() {
      const own = alias(account, 'own')
      const counter = alias(account, 'counter')
      const open = await tx
        .select({ noticeId: notice.id, movement, own: own.name, counter: counter.name })
        .from(notice)
        .innerJoin(movement, eq(movement.id, notice.movementId))
        .leftJoin(own, eq(own.id, movement.accountId))
        .leftJoin(counter, eq(counter.id, movement.counterAccountId))
        .where(sql`${notice.createdAt} > now() - make_interval(hours => ${NOTICE_MAX_AGE_HOURS})`)
        .orderBy(asc(notice.id))
      if (open.length === 0) return []

      const failures = tx
        .select({ wamid: noticeStatus.wamid, errorCode: noticeStatus.errorCode })
        .from(noticeStatus)
        .where(eq(noticeStatus.status, 'failed'))
        .as('failures')
      const attempts = await tx
        .select({ attempt: noticeAttempt, failedWamid: failures.wamid, code: failures.errorCode })
        .from(noticeAttempt)
        .leftJoin(failures, eq(failures.wamid, noticeAttempt.wamid))
        .where(
          inArray(
            noticeAttempt.noticeId,
            open.map((n) => n.noticeId),
          ),
        )
        .orderBy(asc(noticeAttempt.id))
      const history = new Map<number, AttemptRecord[]>()
      for (const { attempt, failedWamid, code } of attempts) {
        const list = history.get(attempt.noticeId) ?? []
        const reported = failedWamid !== null
        list.push({
          mode: attempt.mode as AttemptRecord['mode'],
          failed: attempt.outcome === 'failed' || reported,
          errorCode: reported ? code : attempt.errorCode,
          // A failure WhatsApp reports after accepting the message is final for that mode.
          retryable: reported ? false : (attempt.retryable ?? false),
        })
        history.set(attempt.noticeId, list)
      }

      return open.map((n): OpenNotice => {
        const m = n.movement
        return {
          noticeId: n.noticeId,
          movement: {
            type: m.type as NoticeMovement['type'],
            direction: m.direction as NoticeMovement['direction'],
            amount: m.amount,
            currency: m.currency,
            date: m.date,
            time: m.time,
            accountName: n.own,
            counterAccountName: n.counter,
            counterpartyName: m.counterpartyName,
            cardLastFour: m.cardLastFour,
          },
          history: history.get(n.noticeId) ?? [],
        }
      })
    },

    async recordAttempt(noticeId, attempt) {
      await tx.insert(noticeAttempt).values({
        noticeId,
        mode: attempt.mode,
        outcome: attempt.outcome,
        body: scope.seal(attempt.body, attemptAad(noticeId, 'body')),
        ...(attempt.outcome === 'sent'
          ? { wamid: attempt.wamid }
          : {
              errorCode: attempt.errorCode,
              retryable: attempt.retryable,
              detail: attempt.detail
                ? scope.seal(attempt.detail, attemptAad(noticeId, 'detail'))
                : null,
            }),
      })
    },

    async recordStatus(status) {
      const known = await tx
        .select({ id: noticeAttempt.id })
        .from(noticeAttempt)
        .where(eq(noticeAttempt.wamid, status.wamid))
        .limit(1)
      if (!known[0]) return false
      await tx.insert(noticeStatus).values(status).onConflictDoNothing()
      return true
    },
  }
}

export type NoticeRow = {
  noticeId: number
  createdAt: Date
  attempts: number
  lastMode: string | null
  lastOutcome: string | null
  lastDetail: string | null
  delivery: string | null
}

/** The user's latest notices with where each one stands, newest first. */
export async function recentNotices(scope: Scope, limit = 20): Promise<NoticeRow[]> {
  const { tx } = scope
  const rows = await tx.select().from(notice).orderBy(desc(notice.id)).limit(limit)
  const out: NoticeRow[] = []
  for (const n of rows) {
    const attempts = await tx
      .select()
      .from(noticeAttempt)
      .where(eq(noticeAttempt.noticeId, n.id))
      .orderBy(asc(noticeAttempt.id))
    const last = attempts.at(-1)
    const statuses = last?.wamid
      ? await tx
          .select({ status: noticeStatus.status })
          .from(noticeStatus)
          .where(eq(noticeStatus.wamid, last.wamid))
          .orderBy(asc(noticeStatus.occurredAt))
      : []
    const detail = last?.detail
      ? scope.open(last.detail, attemptAad(n.id, 'detail')).toString('utf8')
      : null
    out.push({
      noticeId: n.id,
      createdAt: n.createdAt,
      attempts: attempts.length,
      lastMode: last?.mode ?? null,
      lastOutcome: last?.outcome ?? null,
      lastDetail: last ? (detail ?? (last.errorCode ? `code ${last.errorCode}` : null)) : null,
      delivery: statuses.map((s) => s.status).join(' → ') || null,
    })
  }
  return out
}
