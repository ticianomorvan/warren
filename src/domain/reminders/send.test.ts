import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  minutes as after,
  cafe,
  cancel,
  log,
  remind as setReminder,
  turn,
} from '../../../test/core'
import { realPostgres, sql, useDatabase } from '../../../test/db'
import { fakeGraph } from '../../../test/fakes'
import { until } from '../../../test/until'
import { schemaDir } from '../../core/db'
import { GraphError, TEMPLATE_LANGUAGE } from '../../whatsapp/graph'
import { createIngest } from '../../whatsapp/ingest'
import { insertReminder } from './db'
import { ScheduleSchema } from './schedule'
import { createReminderSender, DAILY_ALERT, LATE_MS, PERSON_CAP, WINDOW_MS } from './send'

vi.mock('../../log', () => ({ log: vi.fn() }))
const { log: logged } = await import('../../log')

// A pool of connections on real Postgres (the races), the one session of PGlite otherwise.
useDatabase({ max: 12, migrations: schemaDir })

const WA = '5491100000000'
const OTHER = '5491100000099'
const TEMPLATE = 'warren_reminder'
/** 12:00 in Argentina. */
const NOW = new Date('2026-11-22T15:00:00Z')
const minutes = (n: number) => n * 60_000
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const oneOff = (local: string) => {
  const [start, time] = local.split(' ')
  return ScheduleSchema.parse({ start, time })
}
const alerts = (reason: string) =>
  vi
    .mocked(logged)
    .mock.calls.filter(([e, f]) => e === 'alert' && (f as { reason: string }).reason === reason)
const logs = (event: string) => vi.mocked(logged).mock.calls.filter(([e]) => e === event)

interface Person {
  accountId: number
  waId: string
  /** A turn of theirs: the reminders' `made_in`. */
  turn: number
}
let me: Person
beforeEach(async () => {
  vi.mocked(logged).mockClear()
  me = await person(WA)
})

async function person(waId: string): Promise<Person> {
  const [account] = await sql<
    { id: number }[]
  >`INSERT INTO account DEFAULT VALUES RETURNING id::int AS id`
  const accountId = Number(account?.id)
  await sql`INSERT INTO account_address (account_id, channel, address) VALUES (${accountId}, 'whatsapp', ${waId})`
  const made = await turn(sql, accountId, [log(cafe())])
  return { accountId, waId, turn: made.turn }
}

/** A message the person sent: it opens the 24 h window for `age` ms after Meta stamped it (`receivedAge`: when we stored it). */
async function wrote(age: number, waId = WA, receivedAge = age) {
  await sql`
    INSERT INTO wa_message (wamid, wa_id, kind, text, status, meta_ts, received_at)
    VALUES (${`in.${waId}.${age}.${Math.random()}`}, ${waId}, 'text', 'hola', 'done', ${ago(age)}, ${ago(receivedAge)})`
}

/** A reminder (its entity id) whose next occurrence is the schedule's first one after `now`. */
async function remind(
  what: string,
  schedule: ReturnType<typeof oneOff>,
  now = new Date(0),
  who: Person = me,
) {
  const row = await insertReminder(sql, {
    accountId: who.accountId,
    turnId: who.turn,
    what,
    schedule,
    now,
  })
  return row.id
}

/** A finished reminder to hang past sends on. */
async function history(): Promise<number> {
  const id = await remind('old', oneOff('2026-11-20 09:00'))
  await sql`UPDATE reminder SET next_due_at = NULL WHERE entity_id = ${id}`
  return id
}

const sends = () =>
  sql`SELECT reminder_entity_id::int AS reminder, due_at, kind, status, wamid, error_code FROM reminder_send ORDER BY id`
const nextDue = async (entity: number) =>
  (await sql`SELECT next_due_at FROM reminder WHERE entity_id = ${entity} AND ended_at IS NULL`)[0]
    ?.next_due_at
const sentCount = async (entity: number) =>
  Number(
    (
      await sql`SELECT count(*)::int AS n FROM reminder_send WHERE reminder_entity_id = ${entity} AND status = 'sent'`
    )[0]?.n,
  )
const sender = (
  graph: ReturnType<typeof fakeGraph>['graph'],
  template: string | null = TEMPLATE,
  allowed: string[] = ['*'],
  now: Date = NOW,
) => createReminderSender({ sql, graph, allowed, template: template ?? undefined, now: () => now })
const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}
const outsideWindow = () => {
  throw new GraphError(400, 'Re-engagement message', 131047)
}

describe('the window decides text or template', () => {
  it('sends text when the person wrote less than 23 h ago', async () => {
    await wrote(WINDOW_MS - minutes(1))
    const id = await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()

    expect(fake.calls.sent).toEqual([{ to: WA, body: '⏰ Recordatorio: pagar la Visa' }])
    expect(fake.calls.templates).toEqual([])
    expect(await sends()).toMatchObject([
      { reminder: id, kind: 'text', status: 'sent', wamid: 'wamid.OUT1' },
    ])
    expect(await nextDue(id)).toBeNull()
    expect(await sentCount(id)).toBe(1)
  })

  it('sends the template when the window has closed, with the text as its one parameter', async () => {
    await wrote(WINDOW_MS + minutes(1))
    await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()

    expect(fake.calls.sent).toEqual([])
    expect(fake.calls.templates).toEqual([
      { to: WA, name: TEMPLATE, lang: TEMPLATE_LANGUAGE, params: ['pagar la Visa'] },
    ])
    expect(await sends()).toMatchObject([{ kind: 'template', status: 'sent', wamid: 'wamid.TPL1' }])
  })

  it('sends the template when the person never wrote', async () => {
    await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.templates).toHaveLength(1)
  })

  it('does not count what another person wrote', async () => {
    // v1 also pinned "what was said over MCP": `wa_message` is WhatsApp only now, so there is nothing of MCP to leave out.
    await wrote(minutes(5), OTHER)
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.sent).toEqual([])
    expect(fake.calls.templates).toHaveLength(1)
  })

  it('falls back to the template on 131047, which proves nothing was sent', async () => {
    await wrote(minutes(5))
    await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph({ send: async () => outsideWindow() })
    await sender(fake.graph).sweep()

    expect(fake.calls.templates).toHaveLength(1)
    expect(await sends()).toMatchObject([{ kind: 'template', status: 'sent', wamid: 'wamid.TPL2' }])
  })

  it('adds when it was meant for after more than 15 minutes, in the text and in the template', async () => {
    await wrote(minutes(5))
    await remind('pagar la Visa', oneOff('2026-11-22 11:44'))
    const open = fakeGraph()
    await sender(open.graph).sweep()
    expect(open.calls.sent[0]?.body).toBe(
      '⏰ Recordatorio: pagar la Visa (era para el 22/11 a las 11:44)',
    )

    await sql`DELETE FROM wa_message`
    await remind('la pastilla', oneOff('2026-11-22 11:30'))
    const closed = fakeGraph()
    await sender(closed.graph).sweep()
    expect(closed.calls.templates[0]?.params).toEqual([
      'la pastilla (era para el 22/11 a las 11:30)',
    ])
  })

  it('says nothing of lateness at 15 minutes or less', async () => {
    await wrote(minutes(5))
    await remind('pagar la Visa', oneOff('2026-11-22 11:45'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(NOW.getTime() - new Date('2026-11-22T11:45:00-03:00').getTime()).toBe(LATE_MS)
    expect(fake.calls.sent[0]?.body).toBe('⏰ Recordatorio: pagar la Visa')
  })

  it('sends nothing before the time', async () => {
    await wrote(minutes(5))
    const id = await remind('mañana', oneOff('2026-11-22 12:01'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(0)
    expect(await sends()).toEqual([])
    expect(await sentCount(id)).toBe(0)
  })

  it('does not send a cancelled reminder', async () => {
    const id = await remind('x', oneOff('2026-11-22 11:55'))
    await turn(sql, me.accountId, [cancel(id)], { at: after(1) })
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(0)
  })
})

describe('at most once', () => {
  it('a 5xx is unknown and is never sent again, by this sweep or any later one', async () => {
    await wrote(minutes(5))
    const id = await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph({
      send: async () => {
        throw new GraphError(503, 'unavailable')
      },
    })
    const s = sender(fake.graph)
    await s.sweep()
    await s.sweep()
    await sender(fake.graph).sweep()

    expect(fake.calls.attempts).toBe(1)
    expect(fake.calls.templates).toEqual([])
    expect(await sends()).toMatchObject([{ status: 'unknown', error_code: null }])
    expect(await nextDue(id)).toBeNull()
    expect(await sentCount(id)).toBe(0)
  })

  it('a timeout is unknown too', async () => {
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph({
      sendTemplate: async () => {
        throw new DOMException('timed out', 'TimeoutError')
      },
    })
    await sender(fake.graph).sweep()
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(1)
    expect(await sends()).toMatchObject([{ status: 'unknown' }])
  })

  it('a 4xx that proves nothing was sent is failed, with Meta’s code, and is not retried', async () => {
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph({
      sendTemplate: async () => {
        throw new GraphError(400, 'template paused', 132015)
      },
    })
    await sender(fake.graph).sweep()
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(1)
    expect(await sends()).toMatchObject([{ status: 'failed', error_code: 132015 }])
  })

  it('a second sweep, and a new process after a restart, send nothing twice', async () => {
    await wrote(minutes(5))
    await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    await sender(fake.graph).sweep()
    await sender(fake.graph).sweep() // "restart": a new sender, nothing in memory
    expect(fake.calls.attempts).toBe(1)
    expect(await sends()).toHaveLength(1)
  })

  it('two senders at once (two sweeps in flight) send once', async () => {
    await wrote(minutes(5))
    for (let i = 0; i < 6; i++) await remind(`r${i}`, oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await Promise.all([
      sender(fake.graph).sweep(),
      sender(fake.graph).sweep(),
      sender(fake.graph).sweep(),
    ])
    expect(fake.calls.attempts).toBe(6)
    expect(new Set(fake.calls.sent.map((s) => s.body)).size).toBe(6)
  })

  it('a lost update of next_due_at cannot send an occurrence twice: the send row is unique', async () => {
    await wrote(minutes(5))
    const id = await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    // As if the advance had been lost: the same occurrence is due again.
    await sql`UPDATE reminder SET next_due_at = '2026-11-22T14:55:00Z' WHERE entity_id = ${id}`
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(1)
    expect(await sends()).toHaveLength(1)
  })

  it('a process killed after the claim leaves a started row: unknown later, never sent', async () => {
    await wrote(minutes(5))
    const id = await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    // What the claim commits, and then the process dies before the Graph call.
    await sql`INSERT INTO reminder_send (account_id, reminder_entity_id, due_at, kind, started_at, status)
      VALUES (${me.accountId}, ${id}, '2026-11-22T14:55:00Z', 'text', ${ago(minutes(1))}, 'started')`
    await sql`UPDATE reminder SET next_due_at = NULL WHERE entity_id = ${id}`
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect((await sends())[0]?.status).toBe('started')

    await sender(fake.graph, TEMPLATE, ['*'], new Date(NOW.getTime() + minutes(11))).sweep()
    expect(fake.calls.attempts).toBe(0)
    expect((await sends())[0]?.status).toBe('unknown')
  })
})

describe('recurring reminders and downtime', () => {
  const daily = ScheduleSchema.parse({ start: '2026-11-10', every: 'day' })

  it('advances next_due_at to the next occurrence', async () => {
    await wrote(minutes(5))
    const id = await remind('tomar agua', daily, new Date('2026-11-22T00:00:00-03:00'))
    const fake = fakeGraph()
    await sender(fake.graph, TEMPLATE, ['*'], new Date('2026-11-22T09:00:30-03:00')).sweep()
    expect(await nextDue(id)).toEqual(new Date('2026-11-23T09:00:00-03:00'))
    expect(await sentCount(id)).toBe(1)
  })

  it('after downtime sends only the latest missed occurrence, and says when it was meant for', async () => {
    await wrote(minutes(5))
    // Down since the 10th: 13 occurrences are behind, the 22nd at 09:00 is the latest.
    const id = await remind('tomar agua', daily, new Date('2026-11-09T12:00:00Z'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()

    expect(fake.calls.sent).toEqual([
      { to: WA, body: '⏰ Recordatorio: tomar agua (era para el 22/11 a las 09:00)' },
    ])
    expect(await sends()).toHaveLength(1)
    expect(await nextDue(id)).toEqual(new Date('2026-11-23T09:00:00-03:00'))
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(1)
  })

  it('a schedule that ends with the occurrence finishes the reminder', async () => {
    await wrote(minutes(5))
    const id = await remind(
      'x',
      ScheduleSchema.parse({ start: '2026-11-21', every: 'day', count: 2 }),
      new Date('2026-11-20T12:00:00Z'),
    )
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    // Both days are behind: only the latest, the 22nd (its second and last occurrence), is sent, and then it is over.
    expect(fake.calls.attempts).toBe(1)
    expect(await nextDue(id)).toBeNull()
  })

  it('a stored schedule that no longer parses ends that reminder and not the sweep', async () => {
    await wrote(minutes(5))
    // The schedule column is not guarded: the append-only trigger lets only `next_due_at` and the ended pair change, so it is inserted bad.
    const [bad] = await sql<{ entity: number }[]>`
      INSERT INTO reminder (account_id, made_in, what, schedule, next_due_at)
      VALUES (${me.accountId}, ${me.turn}, 'x', '{"start": "nonsense"}'::jsonb, '2026-11-22T14:00:00Z')
      RETURNING entity_id::int AS entity`
    await remind('y', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.sent.map((s) => s.body)).toEqual(['⏰ Recordatorio: y'])
    expect(await nextDue(bad?.entity as number)).toBeNull()
    expect(logs('reminder_bad_schedule')).toHaveLength(1)
  })
})

describe('the caps', () => {
  it(`holds ${PERSON_CAP} sends a day per person: the next is capped, nothing is sent, an alert is logged`, async () => {
    await wrote(minutes(5))
    for (let i = 0; i < PERSON_CAP + 2; i++) await remind(`r${i}`, oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()

    expect(fake.calls.attempts).toBe(PERSON_CAP)
    const rows = await sends()
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(PERSON_CAP)
    expect(rows.filter((r) => r.status === 'capped')).toHaveLength(2)
    expect(alerts('reminder_person_cap')).toHaveLength(2)
    // A later sweep does not send them: the occurrence is spent.
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(PERSON_CAP)
  })

  it('counts the last 24 hours, not the calendar day, and not another person', async () => {
    await wrote(minutes(5))
    const other = await person(OTHER)
    await wrote(minutes(5), OTHER)
    const old = await history()
    for (let i = 0; i < PERSON_CAP; i++) {
      await sql`INSERT INTO reminder_send (account_id, reminder_entity_id, due_at, kind, started_at, status)
        VALUES (${me.accountId}, ${old}, ${new Date(Date.UTC(2026, 0, 1 + i))}, 'text', ${ago(minutes(60 * 24 - 1) - i * 1000)}, 'sent')`
    }
    await remind('one more', oneOff('2026-11-22 11:55'))
    await remind('theirs', oneOff('2026-11-22 11:55'), new Date(0), other)
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    // 10 sends in the last 24 h: this person's is capped, the other's goes out.
    const rows =
      await sql`SELECT status, due_at FROM reminder_send WHERE due_at >= '2026-11-22' ORDER BY id`
    expect(rows.map((r) => r.status).sort()).toEqual(['capped', 'sent'])
    expect(fake.calls.sent.map((s) => s.body)).toEqual(['⏰ Recordatorio: theirs'])
  })

  it('a send that failed outright does not count toward the cap', async () => {
    await wrote(minutes(5))
    const old = await history()
    for (let i = 0; i < PERSON_CAP; i++) {
      await sql`INSERT INTO reminder_send (account_id, reminder_entity_id, due_at, kind, started_at, status)
        VALUES (${me.accountId}, ${old}, ${new Date(Date.UTC(2026, 0, 1 + i))}, 'text', ${ago(minutes(10))}, 'failed')`
    }
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(1)
  })

  it(`only alerts, and does not block, above ${DAILY_ALERT} sends a day overall`, async () => {
    await wrote(minutes(5))
    // 200 sends in the last day, ten each for twenty other people (so that no one is at their own cap).
    await sql`INSERT INTO account SELECT FROM generate_series(1, 20)`
    await sql`INSERT INTO reminder_send (account_id, reminder_entity_id, due_at, kind, started_at, status)
      SELECT a.id, 9000 + a.id, '2026-01-01'::timestamptz + n * interval '1 day', 'text', ${ago(minutes(30))}, 'sent'
      FROM account a CROSS JOIN generate_series(1, 10) AS n WHERE a.id <> ${me.accountId}`
    expect(DAILY_ALERT).toBe(200)
    await remind('the 201st', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.sent.map((s) => s.body)).toEqual(['⏰ Recordatorio: the 201st'])
    expect(alerts('reminder_daily_volume')).toHaveLength(1)
  })
})

describe('no template configured', () => {
  it('sends no template when the window is closed: failed, logged, nothing sent', async () => {
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph, null).sweep()
    expect(fake.calls.templates).toEqual([])
    expect(fake.calls.sent).toEqual([])
    expect(await sends()).toMatchObject([{ kind: 'template', status: 'failed', wamid: null }])
    expect(logs('reminder_send_failed')).not.toHaveLength(0)
  })

  it('still sends text inside the window, and a 131047 then ends failed with its code', async () => {
    await wrote(minutes(5))
    await remind('a', oneOff('2026-11-22 11:55'))
    const open = fakeGraph()
    await sender(open.graph, null).sweep()
    expect(open.calls.sent).toHaveLength(1)

    await remind('b', oneOff('2026-11-22 11:56'))
    const closing = fakeGraph({ send: async () => outsideWindow() })
    await sender(closing.graph, null).sweep()
    expect(closing.calls.templates).toEqual([])
    expect((await sends()).at(-1)).toMatchObject({ status: 'failed', error_code: 131047 })
  })
})

const statuses = (id: string, status: string, code?: number) => ({
  id,
  status,
  timestamp: 1760000000,
  ...(code ? { errors: [{ code, title: 'x' }] } : {}),
})

describe('delivery status webhooks', () => {
  const ingest = () => createIngest(sql, { allowed: ['*'] })

  it('a failed status for a reminder’s wamid updates its send and does not make a reply row', async () => {
    await wrote(minutes(5))
    const id = await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(await sends()).toMatchObject([{ status: 'sent', wamid: 'wamid.OUT1' }])

    await ingest().status(statuses('wamid.OUT1', 'delivered'))
    expect(await sends()).toMatchObject([{ status: 'sent' }])

    await ingest().status(statuses('wamid.OUT1', 'failed', 131049))
    expect(await sends()).toMatchObject([
      { status: 'failed', error_code: 131049, wamid: 'wamid.OUT1' },
    ])
    const replies =
      await sql`SELECT count(*)::int AS n FROM reply WHERE outbound_wamid = 'wamid.OUT1'`
    expect(replies[0]?.n).toBe(0)
    expect(logs('reminder_status_failed')).not.toHaveLength(0)
    // The failed send no longer counts as sent: reminder_send is the one count.
    expect(await sentCount(id)).toBe(0)
  })

  it('a status for any other wamid still goes to reply', async () => {
    await ingest().status(statuses('wamid.REPLY', 'failed', 131026))
    const rows = await sql`SELECT failed_at FROM reply WHERE outbound_wamid = 'wamid.REPLY'`
    expect(rows[0]?.failed_at).not.toBeNull()
  })
})

describe('the window runs from when the person wrote', () => {
  it('uses Meta’s time, not when we stored it: a message redelivered after an outage does not open it', async () => {
    // Written 25 h ago (Meta's timestamp), stored 5 minutes ago (redelivered).
    await wrote(25 * 3_600_000, WA, minutes(5))
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.sent).toEqual([])
    expect(fake.calls.templates).toHaveLength(1)
  })

  it('closes an hour before Meta does: 23 h 30 m ago is the template', async () => {
    await wrote(23 * 3_600_000 + minutes(30))
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.templates).toHaveLength(1)
  })

  it('falls back to the time we stored it when Meta gave none', async () => {
    await sql`INSERT INTO wa_message (wamid, wa_id, kind, status, meta_ts, received_at)
      VALUES ('nots', ${WA}, 'text', 'done', NULL, ${ago(minutes(5))})`
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.sent).toHaveLength(1)
  })
})

describe('131047 reported by a status after a 200', () => {
  const ingest = () => createIngest(sql, { allowed: ['*'] })

  /** A text reminder sent (wamid.OUT1). */
  async function sentText() {
    await wrote(minutes(5))
    const id = await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(await sends()).toMatchObject([{ kind: 'text', status: 'sent', wamid: 'wamid.OUT1' }])
    return { id, fake }
  }

  it('sends the template once, however many times the webhook is delivered', async () => {
    const { id, fake } = await sentText()
    await ingest().status(statuses('wamid.OUT1', 'failed', 131047))
    await ingest().status(statuses('wamid.OUT1', 'failed', 131047)) // redelivered, before the sweep
    expect(await sends()).toMatchObject([{ status: 'retry_template', error_code: 131047 }])
    expect(await sentCount(id)).toBe(0)
    expect(fake.calls.templates).toEqual([])

    await sender(fake.graph).sweep()
    expect(fake.calls.templates).toEqual([
      { to: WA, name: TEMPLATE, lang: TEMPLATE_LANGUAGE, params: ['pagar la Visa'] },
    ])
    expect(await sends()).toMatchObject([{ kind: 'template', status: 'sent', wamid: 'wamid.TPL2' }])
    expect(await sentCount(id)).toBe(1)

    await ingest().status(statuses('wamid.OUT1', 'failed', 131047)) // redelivered, after
    await ingest().status(statuses('wamid.TPL2', 'failed', 131047)) // the template's own is not retried
    await sender(fake.graph).sweep()
    expect(fake.calls.templates).toHaveLength(1)
    expect(fake.calls.sent).toHaveLength(1)
    expect(await sends()).toMatchObject([
      { kind: 'template', status: 'failed', error_code: 131047 },
    ])
  })

  it('two senders claiming the retry at once send the template once', async () => {
    const { fake } = await sentText()
    await ingest().status(statuses('wamid.OUT1', 'failed', 131047))
    await Promise.all([sender(fake.graph).sweep(), sender(fake.graph).sweep()])
    expect(fake.calls.templates).toHaveLength(1)
  })

  it('another failure code ends it failed, with no template, and the send is not counted', async () => {
    const { id, fake } = await sentText()
    await ingest().status(statuses('wamid.OUT1', 'failed', 131049))
    await sender(fake.graph).sweep()
    expect(fake.calls.templates).toEqual([])
    expect(await sends()).toMatchObject([{ status: 'failed', error_code: 131049 }])
    expect(await sentCount(id)).toBe(0)
  })

  it('without a template configured the retry ends failed with 131047, and logs it', async () => {
    const { fake } = await sentText()
    await ingest().status(statuses('wamid.OUT1', 'failed', 131047))
    await sender(fake.graph, null).sweep()
    expect(fake.calls.templates).toEqual([])
    expect(await sends()).toMatchObject([{ status: 'failed', error_code: 131047 }])
    expect(logs('reminder_template_unset')).not.toHaveLength(0)
  })

  it('respects the per-person cap: capped, nothing sent, an alert logged', async () => {
    const { id, fake } = await sentText()
    for (let i = 0; i < PERSON_CAP; i++) {
      await sql`INSERT INTO reminder_send (account_id, reminder_entity_id, due_at, kind, started_at, status)
        VALUES (${me.accountId}, ${id}, ${new Date(Date.UTC(2026, 0, 1 + i))}, 'text', ${ago(minutes(30))}, 'sent')`
    }
    await ingest().status(statuses('wamid.OUT1', 'failed', 131047))
    await sender(fake.graph).sweep()
    expect(fake.calls.templates).toEqual([])
    expect((await sends())[0]).toMatchObject({ status: 'capped' })
    expect(alerts('reminder_person_cap')).not.toHaveLength(0)
  })

  it('does not retry for a person who is no longer allowed', async () => {
    const { fake } = await sentText()
    await ingest().status(statuses('wamid.OUT1', 'failed', 131047))
    await sender(fake.graph, TEMPLATE, [OTHER]).sweep()
    expect(fake.calls.templates).toEqual([])
    expect(await sends()).toMatchObject([{ status: 'failed' }])
  })
})

describe('who may be sent to', () => {
  it('spends the occurrence as failed, logs it and sends nothing to an account no longer allowed', async () => {
    await wrote(minutes(5))
    const id = await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph, TEMPLATE, [OTHER]).sweep()
    expect(fake.calls.attempts).toBe(0)
    expect(await sends()).toMatchObject([{ status: 'failed', wamid: null }])
    expect(await nextDue(id)).toBeNull()
    expect(logs('reminder_send_failed')).not.toHaveLength(0)
    // It does not come back when the person is allowed again: the occurrence is spent.
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(0)
  })

  it('sends to a listed number', async () => {
    await wrote(minutes(5))
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph, TEMPLATE, [WA]).sweep()
    expect(fake.calls.sent).toHaveLength(1)
  })

  it('leaves alone a reminder of an account with no WhatsApp address: nobody to send to', async () => {
    const [account] = await sql<
      { id: number }[]
    >`INSERT INTO account DEFAULT VALUES RETURNING id::int AS id`
    const made = await turn(sql, Number(account?.id), [log(cafe())])
    const id = await remind('x', oneOff('2026-11-22 11:55'), new Date(0), {
      accountId: Number(account?.id),
      waId: '',
      turn: made.turn,
    })
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(0)
    expect(await sends()).toEqual([])
    expect(await nextDue(id)).not.toBeNull()
  })
})

describe('shutdown and a send that never ended', () => {
  it('claims one reminder at a time: stopping mid-batch strands only the send in progress', async () => {
    await wrote(minutes(5))
    for (let i = 0; i < 5; i++) await remind(`r${i}`, oneOff(`2026-11-22 11:5${i}`))
    const hold = gate()
    const fake = fakeGraph({
      send: async (n) => {
        if (n === 1) await hold.promise
        return `wamid.OUT${n}`
      },
    })
    const s = sender(fake.graph)
    const sweeping = s.sweep()
    await until(() => fake.calls.attempts === 1)
    const stopped = s.stop()
    hold.open()
    await stopped
    await sweeping
    expect(fake.calls.attempts).toBe(1)
    // The other four were never claimed: still due, no send row, nothing lost.
    expect(await sends()).toHaveLength(1)
    const [due] = await sql`SELECT count(*)::int AS n FROM reminder WHERE next_due_at IS NOT NULL`
    expect(due?.n).toBe(4)
    // And a later process sends them.
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(5)
  })

  it('stop gives up waiting for a send after its time limit', async () => {
    await wrote(minutes(5))
    await remind('x', oneOff('2026-11-22 11:55'))
    const hold = gate()
    const fake = fakeGraph({ send: () => hold.promise.then(() => 'wamid.LATE') })
    const s = sender(fake.graph)
    const sweeping = s.sweep()
    await until(() => fake.calls.attempts === 1)
    const t = Date.now()
    await s.stop(60)
    expect(Date.now() - t).toBeLessThan(2000)
    hold.open()
    await sweeping
  })

  it('does not sweep after stop', async () => {
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    const s = sender(fake.graph)
    await s.stop()
    await s.sweep()
    expect(fake.calls.attempts).toBe(0)
  })

  it('logs an alert, with the count, when started rows are turned into unknown', async () => {
    const id = await history()
    for (let i = 0; i < 3; i++) {
      await sql`INSERT INTO reminder_send (account_id, reminder_entity_id, due_at, kind, started_at, status)
        VALUES (${me.accountId}, ${id}, ${new Date(Date.UTC(2026, 0, 1 + i))}, 'text', ${ago(minutes(30))}, 'started')`
    }
    await sender(fakeGraph().graph).sweep()
    expect(vi.mocked(logged).mock.calls).toContainEqual([
      'alert',
      { reason: 'reminder_send_unknown_after_stale', count: 3 },
      'error',
    ])
    expect((await sends()).filter((r) => r.status === 'unknown')).toHaveLength(3)
  })

  it('does not alert when nothing was stale', async () => {
    await sender(fakeGraph().graph).sweep()
    expect(alerts('reminder_send_unknown_after_stale')).toHaveLength(0)
  })

  it('a database failure before any send is failed, not unknown, and nothing is sent', async () => {
    await wrote(minutes(5))
    await remind('x', oneOff('2026-11-22 11:55'))
    // 131047 on the text, then the row cannot be moved to the template.
    await sql`CREATE FUNCTION no_template_kind() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'no'; END $$`
    await sql`CREATE TRIGGER no_template_kind BEFORE UPDATE OF kind ON reminder_send
      FOR EACH ROW EXECUTE FUNCTION no_template_kind()`
    try {
      const fake = fakeGraph({ send: async () => outsideWindow() })
      await sender(fake.graph).sweep()
      expect(fake.calls.templates).toEqual([])
      expect(await sends()).toMatchObject([{ kind: 'text', status: 'failed', error_code: 131047 }])
    } finally {
      await sql`DROP TRIGGER no_template_kind ON reminder_send`
      await sql`DROP FUNCTION no_template_kind()`
    }
  })
})

describe('a one-off that fires', () => {
  it('shows as done to the undo: the set it came from is blocked as sent, and nothing else is touched', async () => {
    await wrote(minutes(5))
    // Set by a turn, as the person does, then due and sent.
    const set = await turn(sql, me.accountId, [
      setReminder('llamar', { day: 'today', time: '12:30' }),
    ])
    const [row] = await sql<
      { id: number }[]
    >`SELECT entity_id::int AS id FROM reminder WHERE made_in = ${set.turn}`
    const fake = fakeGraph()
    await sender(fake.graph, TEMPLATE, ['*'], new Date(NOW.getTime() + minutes(31))).sweep()
    expect(fake.calls.sent).toHaveLength(1)
    expect(await nextDue(row?.id as number)).toBeNull()

    const undone = await turn(sql, me.accountId, [{ tool: 'undo_last', input: {} }], {
      at: after(40),
    })
    expect(undone.done[0]?.outcome?.status).toBe('blocked')
    expect(await sentCount(row?.id as number)).toBe(1)
  })
})

describe.skipIf(!realPostgres)('races on real Postgres', () => {
  const RUNS = Number(process.env.RACE_RUNS ?? 6)

  it('two sweeps at once send each occurrence exactly once', async () => {
    await wrote(minutes(5))
    for (let run = 0; run < RUNS; run++) {
      await sql`TRUNCATE reminder_send, reminder RESTART IDENTITY CASCADE`
      const ids: number[] = []
      for (let i = 0; i < 8; i++) ids.push(await remind(`r${run}.${i}`, oneOff('2026-11-22 11:55')))
      const fake = fakeGraph({ send: async (n) => `wamid.OUT${n}` })
      await Promise.all([
        sender(fake.graph).sweep(),
        sender(fake.graph).sweep(),
        sender(fake.graph).sweep(),
        sender(fake.graph).sweep(),
      ])
      const rows = await sends()
      expect(
        rows.map((r) => r.status),
        `run ${run}`,
      ).toEqual(Array(8).fill('sent'))
      expect(new Set(rows.map((r) => r.reminder)).size, `run ${run}`).toBe(8)
      expect(fake.calls.attempts, `run ${run}`).toBe(8)
      expect(new Set(fake.calls.sent.map((s) => s.body)).size, `run ${run}`).toBe(8)
    }
  })

  it('a recurring reminder swept by two at once sends its occurrence once and advances once', async () => {
    await wrote(minutes(5))
    const daily = ScheduleSchema.parse({ start: '2026-11-10', every: 'day' })
    for (let run = 0; run < RUNS; run++) {
      await sql`TRUNCATE reminder_send, reminder RESTART IDENTITY CASCADE`
      const id = await remind('tomar agua', daily, new Date('2026-11-22T00:00:00-03:00'))
      const fake = fakeGraph()
      const at = new Date('2026-11-22T09:00:30-03:00')
      await Promise.all([
        sender(fake.graph, TEMPLATE, ['*'], at).sweep(),
        sender(fake.graph, TEMPLATE, ['*'], at).sweep(),
      ])
      expect(fake.calls.attempts, `run ${run}`).toBe(1)
      expect(await nextDue(id), `run ${run}`).toEqual(new Date('2026-11-23T09:00:00-03:00'))
    }
  })

  it('an undo racing the sweep: the set is taken back and nothing is sent, or it is sent and the undo is blocked', async () => {
    const at = new Date(NOW.getTime() + minutes(31))
    for (let run = 0; run < RUNS; run++) {
      await sql`TRUNCATE reminder_send, reminder, turn, wa_message, account_address, account RESTART IDENTITY CASCADE`
      me = await person(WA)
      await wrote(minutes(5))
      const set = await turn(sql, me.accountId, [
        setReminder('llamar', { day: 'today', time: '12:30' }),
      ])
      const fake = fakeGraph()
      const [, undid] = await Promise.all([
        sender(fake.graph, TEMPLATE, ['*'], at).sweep(),
        turn(sql, me.accountId, [{ tool: 'undo_last', input: {} }], { at: after(40) }),
      ])
      const status = undid.done[0]?.outcome?.status
      const sent = (await sends()).filter((s) => s.status === 'sent').length
      const live =
        await sql`SELECT 1 FROM reminder WHERE made_in = ${set.turn} AND ended_at IS NULL`
      if (status === 'blocked') {
        expect(sent, `run ${run}`).toBe(1)
        expect(live, `run ${run}`).toHaveLength(1)
      } else {
        expect(status, `run ${run}`).toBe('applied')
        expect(sent, `run ${run}`).toBe(0)
        expect(live, `run ${run}`).toHaveLength(0)
      }
    }
  })
})
