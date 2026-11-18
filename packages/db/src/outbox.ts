import type { Attempt, AttemptRecord, NoticeMovement, Outbox } from '@warren/core'
import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Db } from './client'
import { account, movement, notice, noticeAttempt, noticeStatus } from './schema'

/** A notice older than this is no longer worth sending. */
const MAX_AGE_HOURS = 24

export function createOutbox(db: Db): Outbox {
  return {
    async drain(handle) {
      return db.transaction(async (tx) => {
        // One drain at a time; a second caller waits and then sees what the first one sent.
        await tx.execute(sql`select pg_advisory_xact_lock(4203)`)

        const own = alias(account, 'own')
        const counter = alias(account, 'counter')
        const open = await tx
          .select({ noticeId: notice.id, movement, own: own.name, counter: counter.name })
          .from(notice)
          .innerJoin(movement, eq(movement.id, notice.movementId))
          .leftJoin(own, eq(own.id, movement.accountId))
          .leftJoin(counter, eq(counter.id, movement.counterAccountId))
          .where(sql`${notice.createdAt} > now() - make_interval(hours => ${MAX_AGE_HOURS})`)
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

        const made: Attempt[] = []
        for (const n of open) {
          const m = n.movement
          const view: NoticeMovement = {
            type: m.type as NoticeMovement['type'],
            direction: m.direction as NoticeMovement['direction'],
            amount: m.amount,
            currency: m.currency,
            date: m.date,
            time: m.time,
            accountName: n.own,
            counterAccountName: n.counter,
            counterpartyName: m.counterpartyName,
          }
          const attempt = await handle({
            noticeId: n.noticeId,
            movement: view,
            history: history.get(n.noticeId) ?? [],
          })
          if (!attempt) continue
          await tx.insert(noticeAttempt).values({
            noticeId: n.noticeId,
            mode: attempt.mode,
            outcome: attempt.outcome,
            body: attempt.body,
            ...(attempt.outcome === 'sent'
              ? { wamid: attempt.wamid }
              : {
                  errorCode: attempt.errorCode,
                  retryable: attempt.retryable,
                  detail: attempt.detail,
                }),
          })
          made.push(attempt)
        }
        return made
      })
    },

    async recordStatus(status) {
      const known = await db
        .select({ id: noticeAttempt.id })
        .from(noticeAttempt)
        .where(eq(noticeAttempt.wamid, status.wamid))
        .limit(1)
      if (!known[0]) return false
      await db.insert(noticeStatus).values(status).onConflictDoNothing()
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

/** Latest notices with where each one stands, newest first. */
export async function recentNotices(db: Db, limit = 20): Promise<NoticeRow[]> {
  const rows = await db.select().from(notice).orderBy(desc(notice.id)).limit(limit)
  const out: NoticeRow[] = []
  for (const n of rows) {
    const attempts = await db
      .select()
      .from(noticeAttempt)
      .where(eq(noticeAttempt.noticeId, n.id))
      .orderBy(asc(noticeAttempt.id))
    const last = attempts.at(-1)
    const statuses = last?.wamid
      ? await db
          .select({ status: noticeStatus.status })
          .from(noticeStatus)
          .where(eq(noticeStatus.wamid, last.wamid))
          .orderBy(asc(noticeStatus.occurredAt))
      : []
    out.push({
      noticeId: n.id,
      createdAt: n.createdAt,
      attempts: attempts.length,
      lastMode: last?.mode ?? null,
      lastOutcome: last?.outcome ?? null,
      lastDetail: last ? (last.detail ?? (last.errorCode ? `code ${last.errorCode}` : null)) : null,
      delivery: statuses.map((s) => s.status).join(' → ') || null,
    })
  }
  return out
}
