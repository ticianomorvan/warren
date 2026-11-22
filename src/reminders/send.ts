import type { Sql } from '../db'
import { log } from '../log'
import { argentinaTime, argentinaToday } from '../time'
import { type Graph, GraphError } from '../whatsapp/graph'
import { nextOccurrence, parseSchedule } from './schedule'

/** The template's language, as Meta names it. */
export const TEMPLATE_LANGUAGE = 'es_AR'
/** Meta's window is 24 h from the person's last message; 10 minutes less so a send never lands on its edge. */
export const WINDOW_MS = (23 * 60 + 50) * 60_000
/** An occurrence sent later than this says when it was meant for. */
export const LATE_MS = 15 * 60_000
/** Sends per person in a rolling day. */
export const PERSON_CAP = 10
/** More sends than this in a rolling day raises an alert (it blocks nothing). */
export const DAILY_ALERT = 200
/** A send that started and never ended (a killed process) is `unknown` after this and never sent again. */
const STALE_MS = 10 * 60_000
const BATCH = 20
const DAY_MS = 86_400_000
/** Meta's "more than 24 hours since the person last wrote": the text did not go, a template can. */
const OUTSIDE_WINDOW = 131047

export interface ReminderSenderOptions {
  sql: Sql
  graph: Graph
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

  /**
   * One transaction: the due reminders, locked (`skip locked`, so two sweeps never take the same row), each
   * given its `reminder_send` row and its next date. After downtime only the latest missed occurrence is sent.
   * What is committed here is what makes the send at most once: nothing is sent before it.
   */
  async function claim(now: Date): Promise<Claimed[]> {
    return sql.begin(async (tx) => {
      const rows = await tx<
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
        LIMIT ${BATCH}
        FOR UPDATE OF r SKIP LOCKED`
      const out: Claimed[] = []
      let inserted = 0
      for (const r of rows) {
        let dueAt = r.next_due_at
        let next: Date | null
        try {
          const schedule = parseSchedule(r.schedule)
          next = nextOccurrence(schedule, dueAt)
          while (next && next <= now) {
            dueAt = next
            next = nextOccurrence(schedule, dueAt)
          }
        } catch (err) {
          // A stored schedule that no longer parses must not stop the others: it ends here, and someone looks.
          await tx`UPDATE reminder SET next_due_at = NULL WHERE id = ${r.id}`
          log('reminder_bad_schedule', { reminder: r.id, error: String(err) }, 'error')
          continue
        }
        await tx`UPDATE reminder SET next_due_at = ${next} WHERE id = ${r.id}`

        const [open] = await tx`
          SELECT 1 FROM inbound_message
          WHERE wa_id = ${r.wa_id} AND channel = 'whatsapp'
            AND received_at > ${new Date(now.getTime() - WINDOW_MS)}
          LIMIT 1`
        const kind = open ? 'text' : 'template'
        const [today] = await tx`
          SELECT count(*)::int AS n FROM reminder_send s JOIN reminder x ON x.id = s.reminder_id
          WHERE x.account_id = ${r.account_id}
            AND s.started_at > ${new Date(now.getTime() - DAY_MS)}
            AND s.status NOT IN ('capped', 'failed')`
        const capped = Number(today?.n) >= PERSON_CAP
        const [send] = await tx`
          INSERT INTO reminder_send (reminder_id, due_at, kind, started_at, status)
          VALUES (${r.id}, ${dueAt}, ${kind}, ${now}, ${capped ? 'capped' : 'started'})
          ON CONFLICT (reminder_id, due_at) DO NOTHING
          RETURNING id::int AS id`
        if (!send) continue
        if (capped) {
          log('alert', { reason: 'reminder_person_cap', reminder: r.id, due_at: dueAt }, 'error')
          continue
        }
        inserted++
        out.push({
          sendId: Number(send.id),
          reminderId: r.id,
          waId: r.wa_id,
          text: `${r.what}${lateNote(dueAt, now)}`,
          kind,
        })
      }
      if (inserted > 0) {
        const [all] = await tx`
          SELECT count(*)::int AS n FROM reminder_send
          WHERE started_at > ${new Date(now.getTime() - DAY_MS)} AND status NOT IN ('capped', 'failed')`
        const total = Number(all?.n)
        if (total > DAILY_ALERT && total - inserted <= DAILY_ALERT) {
          log('alert', { reason: 'reminder_daily_volume', sends_in_24h: total }, 'error')
        }
      }
      return out
    })
  }

  /** The template, or throws what a refusal looks like when none is configured. */
  async function viaTemplate(c: Claimed): Promise<string> {
    if (!o.template) throw new NoTemplate()
    if (c.kind === 'text') {
      await sql`UPDATE reminder_send SET kind = 'template' WHERE id = ${c.sendId}`
    }
    return graph.sendTemplate(c.waId, o.template, TEMPLATE_LANGUAGE, [c.text])
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
          if (!o.template) {
            log('reminder_template_unset', { send: c.sendId }, 'error')
            throw err
          }
          wamid = await viaTemplate(c)
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
    // A 4xx proves nothing was sent; a template that is not configured sent nothing either. Anything else
    // (a 5xx, a timeout) may have been delivered: `unknown`, never again.
    const known = err instanceof NoTemplate || (err instanceof GraphError && err.notSent)
    const code = err instanceof GraphError ? (err.code ?? null) : null
    const status = known ? 'failed' : 'unknown'
    try {
      await sql`UPDATE reminder_send SET status = ${status}, error_code = ${code} WHERE id = ${c.sendId}`
    } catch {}
    log(
      known ? 'reminder_send_failed' : 'reminder_send_unknown',
      {
        send: c.sendId,
        reminder: c.reminderId,
        kind: c.kind,
        code,
        error: err instanceof NoTemplate ? 'no template configured' : String(err),
      },
      'error',
    )
  }

  async function run(): Promise<void> {
    const now = clock()
    await sql`
      UPDATE reminder_send SET status = 'unknown'
      WHERE status = 'started' AND started_at < ${new Date(now.getTime() - STALE_MS)}`
    for (const c of await claim(now)) await deliver(c)
  }

  return {
    /** Sends what is due. Calls that overlap share one run, so a slow send never makes two sweeps. */
    sweep(): Promise<void> {
      inFlight ??= run().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
    /** Waits for the sweep in progress (shutdown). */
    async stop(): Promise<void> {
      await inFlight?.catch(() => {})
    },
  }
}

class NoTemplate extends Error {}
