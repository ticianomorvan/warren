import {
  type AttemptRecord,
  NOTICE_MAX_AGE_HOURS,
  type NoticeMovement,
  type OpenNotice,
  type Outbox,
} from '@warren/core'
import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { type AllowanceFigure, figureAad } from './allowance'
import type { Scope } from './client'
import { createPushStore } from './push'
import { account, movement, notice, noticeAttempt } from './schema'

// Sealed: a notice attempt's text. The scope adds the user.
const attemptAad = (noticeId: number) => `notice_attempt:${noticeId}:body`

/** One user's outbox. */
export function createOutbox(scope: Scope): Outbox {
  const { tx } = scope
  return {
    async owed() {
      const own = alias(account, 'own')
      const counter = alias(account, 'counter')
      const open = await tx
        .select({
          noticeId: notice.id,
          figure: notice.figure,
          movement,
          own: own.name,
          counter: counter.name,
        })
        .from(notice)
        .innerJoin(movement, eq(movement.id, notice.movementId))
        .leftJoin(own, eq(own.id, movement.accountId))
        .leftJoin(counter, eq(counter.id, movement.counterAccountId))
        .where(sql`${notice.createdAt} > now() - make_interval(hours => ${NOTICE_MAX_AGE_HOURS})`)
        .orderBy(asc(notice.id))
      if (open.length === 0) return []

      const attempts = await tx
        .select()
        .from(noticeAttempt)
        .where(
          inArray(
            noticeAttempt.noticeId,
            open.map((n) => n.noticeId),
          ),
        )
        .orderBy(asc(noticeAttempt.id))
      const history = new Map<number, AttemptRecord[]>()
      for (const attempt of attempts) {
        const list = history.get(attempt.noticeId) ?? []
        list.push({
          // Old rows are `text` or `template`: the former WhatsApp notifier. Nothing writes them now.
          mode: attempt.mode === 'push' ? 'push' : 'legacy',
          failed: attempt.outcome === 'failed',
          retryable: attempt.retryable ?? false,
          ...(attempt.subscriptionId ? { subscriptionId: attempt.subscriptionId } : {}),
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
            allowance: n.figure
              ? scope.json.open<AllowanceFigure>(n.figure, figureAad(m.id))
              : null,
          },
          history: history.get(n.noticeId) ?? [],
        }
      })
    },

    async recordAttempt(noticeId, attempt) {
      const body = scope.seal(attempt.body, attemptAad(noticeId))
      // `gone` is a failure that will not repeat: the subscription is deleted with it.
      const sent = attempt.outcome === 'sent'
      await tx.insert(noticeAttempt).values({
        noticeId,
        mode: 'push',
        outcome: sent ? 'sent' : 'failed',
        body,
        subscriptionId: attempt.subscriptionId,
        ...(sent
          ? {}
          : {
              retryable: attempt.outcome === 'failed' && attempt.retryable,
              statusCode: attempt.status,
            }),
      })
    },

    subscriptions: () => createPushStore(scope).list(),
    dropSubscription: (id) => createPushStore(scope).drop(id),
  }
}

export type NoticeRow = {
  noticeId: number
  createdAt: Date
  attempts: number
  lastMode: string | null
  lastOutcome: string | null
  /** The subscription of the last attempt, as a short id. Never its endpoint. */
  lastSubscription: string | null
  /** The push service's HTTP status of the last attempt, when it answered. */
  lastStatus: number | null
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
    out.push({
      noticeId: n.id,
      createdAt: n.createdAt,
      attempts: attempts.length,
      lastMode: last?.mode ?? null,
      lastOutcome: last?.outcome ?? null,
      lastSubscription: last?.subscriptionId?.slice(0, 8) ?? null,
      lastStatus: last?.statusCode ?? null,
    })
  }
  return out
}
