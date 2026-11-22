import type postgres from 'postgres'
import type { Sql } from '../core/db'
import { nextOccurrence, ScheduleSchema } from '../domain/reminders/schedule'
import { log } from '../log'
import { isAllowed } from '../process'
import { argentinaTime, argentinaToday } from '../time'
import { type Graph, GraphError } from '../whatsapp/graph'
import { OUTSIDE_WINDOW, TEMPLATE_LANGUAGE } from './db'

/**
 * Meta's window is 24 h from the person's last message, and a status can only say it closed after the send. An hour
 * less leaves room for a slow send and a clock a little off; the 131047 that still gets through is retried as a template.
 */
export const WINDOW_MS = 23 * 3_600_000
/** An occurrence sent later than this says when it was meant for. */
export const LATE_MS = 15 * 60_000
/** Sends per person in a rolling day. */
export const PERSON_CAP = 10
/** More sends than this in a rolling day raises an alert (it blocks nothing). */
export const DAILY_ALERT = 200
/** A send that started and never ended (a killed process) is `unknown` after this and never sent again. */
const STALE_MS = 10 * 60_000
/** Sends one tick may make. */
const BATCH = 20
const DAY_MS = 86_400_000

export interface ReminderSenderOptions {
  sql: Sql
  graph: Graph
  /** Who may be sent to (`ALLOWED_WA_IDS`): the same list the replies use. */
  allowed: string[]
  /** The approved template (`REMINDER_TEMPLATE`). Unset, no template is ever sent. */
  template?: string | undefined
  now?: () => Date
}

interface Claimed {
  sendId: number
  reminderId: number
  waId: string
  text: string
  kind: 'text' | 'template'
}

type Tx = postgres.TransactionSql

/** What one claim transaction found: nothing due, or a reminder dealt with (`send` when it is to be sent now). */
type Claim = { due: false } | { due: true; send?: Claimed }

/** A send that provably did not go out (nothing configured, a database error before the call). Ends `failed`. */
class NotSent extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message)
  }
}
class NoTemplate extends NotSent {}

/** "(era para el 10/12 a las 09:00)" for an occurrence sent late, else nothing. */
function lateNote(dueAt: Date, now: Date): string {
  if (now.getTime() - dueAt.getTime() <= LATE_MS) return ''
  const [, month, day] = argentinaToday(dueAt).split('-')
  return ` (era para el ${day}/${month} a las ${argentinaTime(dueAt)})`
}

/** Sends the reminders that are due. One instance per process; `sweep` is called from the 30 s tick. */
export function createReminderSender(o: ReminderSenderOptions) {
  const { sql, graph } = o
  const clock = o.now ?? (() => new Date())
  let inFlight: Promise<void> | undefined
  let stopping = false

  /** Sends to this person in the last 24 h that cost something (not `failed`, not `capped`), without `exceptSend`. */
  async function sendsInDay(tx: Tx, accountId: number, now: Date, exceptSend = 0): Promise<number> {
    const [row] = await tx`
      SELECT count(*)::int AS n FROM reminder_send s JOIN reminder x ON x.id = s.reminder_id
      WHERE x.account_id = ${accountId} AND s.id <> ${exceptSend}
        AND s.started_at > ${new Date(now.getTime() - DAY_MS)}
        AND s.status NOT IN ('capped', 'failed')`
    return Number(row?.n)
  }

  async function alertIfBusy(tx: Tx, now: Date): Promise<void> {
    const [all] = await tx`
      SELECT count(*)::int AS n FROM reminder_send
      WHERE started_at > ${new Date(now.getTime() - DAY_MS)} AND status NOT IN ('capped', 'failed')`
    if (Number(all?.n) === DAILY_ALERT + 1) {
      log('alert', { reason: 'reminder_daily_volume', sends_in_24h: Number(all?.n) }, 'error')
    }
  }

  /**
   * A text that Meta reported as 131047 after accepting it (`retry_template`): claimed once, by flipping the row to
   * `started` as a template in the same transaction that commits it, so a redelivered webhook or a second sweep
   * cannot send it twice. It answers to the same rules as a new send: who is allowed, the cap, a configured template.
   */
  async function claimRetry(tx: Tx, now: Date): Promise<Claim | undefined> {
    const [r] = await tx<
      {
        id: number
        reminder_id: number
        account_id: number
        what: string
        due_at: Date
        wa_id: string
      }[]
    >`
      SELECT s.id::int AS id, s.reminder_id::int AS reminder_id, x.account_id::int AS account_id, x.what, s.due_at, a.wa_id
      FROM reminder_send s JOIN reminder x ON x.id = s.reminder_id JOIN account a ON a.id = x.account_id
      WHERE s.status = 'retry_template'
      ORDER BY s.id LIMIT 1
      FOR UPDATE OF s SKIP LOCKED`
    if (!r) return undefined
    const end = async (status: 'failed' | 'capped', reason: string): Promise<Claim> => {
      await tx`UPDATE reminder_send SET status = ${status} WHERE id = ${r.id}`
      log(
        status === 'capped' ? 'alert' : 'reminder_send_failed',
        { send: r.id, reminder: r.reminder_id, reason },
        'error',
      )
      return { due: true }
    }
    if (!isAllowed(o.allowed, r.wa_id)) return end('failed', 'not allowed')
    if ((await sendsInDay(tx, r.account_id, now, r.id)) >= PERSON_CAP) {
      return end('capped', 'reminder_person_cap')
    }
    await tx`UPDATE reminder_send SET status = 'started', kind = 'template', started_at = ${now}, wamid = NULL WHERE id = ${r.id}`
    return {
      due: true,
      send: {
        sendId: r.id,
        reminderId: r.reminder_id,
        waId: r.wa_id,
        text: `${r.what}${lateNote(r.due_at, now)}`,
        kind: 'template',
      },
    }
  }

  /**
   * One due reminder, locked (`skip locked`, so two sweeps never take the same row), given its `reminder_send` row and
   * its next date, in its own transaction. After downtime only the latest missed occurrence is sent. What is committed
   * here is what makes the send at most once: nothing is sent before it.
   */
  async function claimDue(tx: Tx, now: Date): Promise<Claim> {
    const [r] = await tx<
      {
        id: number
        account_id: number
        what: string
        schedule: unknown
        next_due_at: Date
        wa_id: string
      }[]
    >`
      SELECT r.id::int AS id, r.account_id::int AS account_id, r.what, r.schedule, r.next_due_at, a.wa_id
      FROM reminder r JOIN account a ON a.id = r.account_id
      WHERE r.next_due_at <= ${now} AND r.cancelled_at IS NULL
      ORDER BY r.next_due_at
      LIMIT 1
      FOR UPDATE OF r SKIP LOCKED`
    if (!r) return { due: false }
    let dueAt = r.next_due_at
    let next: Date | null
    try {
      const schedule = ScheduleSchema.parse(r.schedule)
      next = nextOccurrence(schedule, dueAt)
      while (next && next <= now) {
        dueAt = next
        next = nextOccurrence(schedule, dueAt)
      }
    } catch (err) {
      // A stored schedule that no longer parses must not stop the others: it ends here, and someone looks.
      await tx`UPDATE reminder SET next_due_at = NULL WHERE id = ${r.id}`
      log('reminder_bad_schedule', { reminder: r.id, error: String(err) }, 'error')
      return { due: true }
    }
    await tx`UPDATE reminder SET next_due_at = ${next} WHERE id = ${r.id}`

    // The window runs from when the person wrote (Meta's time), not from when we stored it: after an outage Meta redelivers.
    const [open] = await tx`
      SELECT 1 FROM inbound_message
      WHERE wa_id = ${r.wa_id} AND channel = 'whatsapp'
        AND COALESCE(meta_ts, received_at) > ${new Date(now.getTime() - WINDOW_MS)}
      LIMIT 1`
    const kind = open ? 'text' : 'template'
    const allowed = isAllowed(o.allowed, r.wa_id)
    const capped = allowed && (await sendsInDay(tx, r.account_id, now)) >= PERSON_CAP
    const status = !allowed ? 'failed' : capped ? 'capped' : 'started'
    const [send] = await tx`
      INSERT INTO reminder_send (reminder_id, due_at, kind, started_at, status)
      VALUES (${r.id}, ${dueAt}, ${kind}, ${now}, ${status})
      ON CONFLICT (reminder_id, due_at) DO NOTHING
      RETURNING id::int AS id`
    if (!send) return { due: true }
    if (status === 'failed') {
      log('reminder_send_failed', { send: send.id, reminder: r.id, reason: 'not allowed' }, 'error')
      return { due: true }
    }
    if (status === 'capped') {
      log('alert', { reason: 'reminder_person_cap', reminder: r.id, due_at: dueAt }, 'error')
      return { due: true }
    }
    await alertIfBusy(tx, now)
    return {
      due: true,
      send: {
        sendId: Number(send.id),
        reminderId: r.id,
        waId: r.wa_id,
        text: `${r.what}${lateNote(dueAt, now)}`,
        kind,
      },
    }
  }

  const claim = (now: Date): Promise<Claim> =>
    sql.begin(async (tx) => (await claimRetry(tx, now)) ?? claimDue(tx, now))

  /** The template, or a `NotSent` when none is configured (the one place that says so). `code` is what made us ask for it. */
  async function viaTemplate(c: Claimed, code: number | null = null): Promise<string> {
    const template = o.template
    if (!template) {
      log('reminder_template_unset', { send: c.sendId, reminder: c.reminderId }, 'error')
      throw new NoTemplate('no template configured', code)
    }
    if (c.kind === 'text') {
      try {
        await sql`UPDATE reminder_send SET kind = 'template' WHERE id = ${c.sendId}`
      } catch (err) {
        throw new NotSent(`could not record the template: ${String(err)}`, code)
      }
      c.kind = 'template'
    }
    return graph.sendTemplate(c.waId, template, TEMPLATE_LANGUAGE, [c.text])
  }

  async function deliver(c: Claimed): Promise<void> {
    let wamid: string
    try {
      if (c.kind === 'template') {
        wamid = await viaTemplate(c)
      } else {
        try {
          wamid = await graph.sendText(c.waId, `⏰ Recordatorio: ${c.text}`)
        } catch (err) {
          // The window had closed after all: that answer proves nothing was sent, so the template cannot double it.
          if (!(err instanceof GraphError && err.notSent && err.code === OUTSIDE_WINDOW)) throw err
          wamid = await viaTemplate(c, OUTSIDE_WINDOW)
        }
      }
    } catch (err) {
      await settleFailure(c, err)
      return
    }
    try {
      await sql`
        WITH s AS (
          UPDATE reminder_send SET status = 'sent', wamid = ${wamid} WHERE id = ${c.sendId}
          RETURNING reminder_id)
        UPDATE reminder SET sent_count = sent_count + 1 WHERE id IN (SELECT reminder_id FROM s)`
      log('reminder_sent', { send: c.sendId, reminder: c.reminderId, kind: c.kind, wamid })
    } catch (err) {
      // It went out. The row stays `started` and becomes `unknown`: never resent.
      log('reminder_mark_failed', { send: c.sendId, wamid, error: String(err) }, 'error')
    }
  }

  async function settleFailure(c: Claimed, err: unknown): Promise<void> {
    // A 4xx proves nothing was sent, and so does a `NotSent`. Anything else (a 5xx, a timeout) may have been
    // delivered: `unknown`, never again.
    const known = err instanceof NotSent || (err instanceof GraphError && err.notSent)
    const code =
      err instanceof NotSent ? err.code : err instanceof GraphError ? (err.code ?? null) : null
    const status = known ? 'failed' : 'unknown'
    try {
      await sql`UPDATE reminder_send SET status = ${status}, error_code = COALESCE(${code}::int, error_code) WHERE id = ${c.sendId}`
    } catch {}
    log(
      known ? 'reminder_send_failed' : 'reminder_send_unknown',
      {
        send: c.sendId,
        reminder: c.reminderId,
        kind: c.kind,
        code,
        error: err instanceof NotSent ? err.message : String(err),
      },
      'error',
    )
  }

  async function run(): Promise<void> {
    const now = clock()
    const stale = await sql`
      UPDATE reminder_send SET status = 'unknown'
      WHERE status = 'started' AND started_at < ${new Date(now.getTime() - STALE_MS)}
      RETURNING id`
    // A process died between the claim and the end of the send: it may or may not have gone out, and it is not retried.
    if (stale.length > 0) {
      log('alert', { reason: 'reminder_send_unknown_after_stale', count: stale.length }, 'error')
    }
    // One reminder per transaction, so a shutdown strands at most the send in progress, not a claimed batch.
    for (let i = 0; i < BATCH && !stopping; i++) {
      const claimed = await claim(now)
      if (!claimed.due) break
      if (claimed.send) await deliver(claimed.send)
    }
  }

  return {
    /** Sends what is due. Calls that overlap share one run, so a slow send never makes two sweeps. */
    sweep(): Promise<void> {
      if (stopping) return Promise.resolve()
      inFlight ??= run().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
    /** Shutdown: no more claims; waits for the send in progress, at most `timeoutMs`. */
    async stop(timeoutMs = 10_000): Promise<void> {
      stopping = true
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        inFlight?.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
      clearTimeout(timer)
    },
  }
}
