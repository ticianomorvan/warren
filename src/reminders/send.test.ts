import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeGraph, post, setup, sql, useDatabase } from '../test-harness'
import { GraphError } from '../whatsapp/graph'
import { insertReminder } from './db'
import { ScheduleSchema } from './schedule'
import {
  createReminderSender,
  DAILY_ALERT,
  LATE_MS,
  PERSON_CAP,
  TEMPLATE_LANGUAGE,
  WINDOW_MS,
} from './send'

vi.mock('../log', () => ({ log: vi.fn() }))
const { log } = await import('../log')

// The same real-Postgres opt-in as the concurrency tests: a schema of its own, a pool of connections.
const url = process.env.PG_TEST_URL
useDatabase(url ? { url, max: 12, schema: 'reminders_test' } : undefined)

const WA = '5491100000000'
const TEMPLATE = 'warren_reminder'
/** 12:00 in Argentina. */
const NOW = new Date('2026-11-22T15:00:00Z')
const minutes = (n: number) => n * 60_000
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const oneOff = (local: string) => {
  const [start, time] = local.split(' ')
  return ScheduleSchema.parse({ start, time })
}

let accountId = 0
beforeEach(async () => {
  vi.mocked(log).mockClear()
  accountId = await account(WA)
})

async function account(waId: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO account (wa_id) VALUES (${waId})
    ON CONFLICT (wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id RETURNING id::int AS id`
  return Number(row?.id)
}

/** A message the person sent: it opens the 24 h window for `age` ms after it was received. */
async function wrote(age: number, waId = WA) {
  await sql`
    INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, received_at)
    VALUES (${`in.${waId}.${age}.${Math.random()}`}, ${waId}, 'text', 'hola', '{}'::jsonb, 'done', ${ago(age)})`
}

/** A reminder whose next occurrence is the given Argentine local moment. */
async function remind(
  what: string,
  schedule: ReturnType<typeof oneOff>,
  now = new Date(0),
  id = accountId,
) {
  const { id: reminderId } = await insertReminder(sql, { accountId: id, what, schedule, now })
  return reminderId
}

/** A finished reminder to hang past sends on. */
async function history(): Promise<number> {
  const id = await remind('old', oneOff('2026-11-20 09:00'))
  await sql`UPDATE reminder SET next_due_at = NULL WHERE id = ${id}`
  return id
}

const sends = () =>
  sql`SELECT reminder_id::int AS reminder, due_at, kind, status, wamid, error_code FROM reminder_send ORDER BY id`
const reminderRow = async (id: number) =>
  (await sql`SELECT next_due_at, sent_count FROM reminder WHERE id = ${id}`)[0]
const sender = (graph: ReturnType<typeof fakeGraph>['graph'], template: string | null = TEMPLATE) =>
  createReminderSender({ sql, graph, template: template ?? undefined, now: () => NOW })

describe('the window decides text or template', () => {
  it('sends text when the person wrote less than 23 h 50 m ago', async () => {
    await wrote(WINDOW_MS - minutes(1))
    const id = await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()

    expect(fake.calls.sent).toEqual([{ to: WA, body: '⏰ Recordatorio: pagar la Visa' }])
    expect(fake.calls.templates).toEqual([])
    expect(await sends()).toMatchObject([
      { reminder: id, kind: 'text', status: 'sent', wamid: 'wamid.OUT1' },
    ])
    expect(await reminderRow(id)).toMatchObject({ next_due_at: null, sent_count: 1 })
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

  it('does not count what the person said over MCP, nor another person', async () => {
    await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, channel, received_at)
      VALUES ('mcp:1', ${WA}, 'tool', NULL, '{}'::jsonb, 'done', 'mcp', ${ago(minutes(5))})`
    await wrote(minutes(5), '5491100000099')
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.sent).toEqual([])
    expect(fake.calls.templates).toHaveLength(1)
  })

  it('falls back to the template on 131047, which proves nothing was sent', async () => {
    await wrote(minutes(5))
    await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph({
      send: async () => {
        throw new GraphError(400, 'Re-engagement message', 131047)
      },
    })
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

    await sql`DELETE FROM inbound_message`
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
    expect(await reminderRow(id)).toMatchObject({ sent_count: 0 })
  })

  it('does not send a cancelled reminder', async () => {
    const id = await remind('x', oneOff('2026-11-22 11:55'))
    const [m] = await sql`INSERT INTO inbound_message (wamid, wa_id, kind, payload, status)
      VALUES ('c1', ${WA}, 'text', '{}'::jsonb, 'done') RETURNING id`
    await sql`UPDATE reminder SET cancelled_at = now(), cancelled_by = ${m?.id} WHERE id = ${id}`
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
    expect(await reminderRow(id)).toMatchObject({ next_due_at: null, sent_count: 0 })
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
    await sql`UPDATE reminder SET next_due_at = '2026-11-22T14:55:00Z' WHERE id = ${id}`
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(1)
    expect(await sends()).toHaveLength(1)
  })

  it('a process killed after the claim leaves a started row: unknown later, never sent', async () => {
    await wrote(minutes(5))
    const id = await remind('pagar la Visa', oneOff('2026-11-22 11:55'))
    // What the claim commits, and then the process dies before the Graph call.
    await sql`INSERT INTO reminder_send (reminder_id, due_at, kind, started_at, status)
      VALUES (${id}, '2026-11-22T14:55:00Z', 'text', ${ago(minutes(1))}, 'started')`
    await sql`UPDATE reminder SET next_due_at = NULL WHERE id = ${id}`
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect((await sends())[0]?.status).toBe('started')

    await createReminderSender({
      sql,
      graph: fake.graph,
      template: TEMPLATE,
      now: () => new Date(NOW.getTime() + minutes(11)),
    }).sweep()
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
    await createReminderSender({
      sql,
      graph: fake.graph,
      template: TEMPLATE,
      now: () => new Date('2026-11-22T09:00:30-03:00'),
    }).sweep()
    expect(await reminderRow(id)).toMatchObject({
      next_due_at: new Date('2026-11-23T09:00:00-03:00'),
      sent_count: 1,
    })
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
    expect(await reminderRow(id)).toMatchObject({
      next_due_at: new Date('2026-11-23T09:00:00-03:00'),
    })
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
    expect((await reminderRow(id))?.next_due_at).toBeNull()
  })

  it('a stored schedule that no longer parses ends that reminder and not the sweep', async () => {
    await wrote(minutes(5))
    const bad = await remind('x', oneOff('2026-11-22 11:00'))
    await sql`UPDATE reminder SET schedule = '{"start": "nonsense"}'::jsonb WHERE id = ${bad}`
    await remind('y', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.sent.map((s) => s.body)).toEqual(['⏰ Recordatorio: y'])
    expect((await reminderRow(bad))?.next_due_at).toBeNull()
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
    expect(
      vi
        .mocked(log)
        .mock.calls.filter(
          ([e, f]) => e === 'alert' && (f as { reason: string }).reason === 'reminder_person_cap',
        ),
    ).toHaveLength(2)
    // A later sweep does not send them: the occurrence is spent.
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(PERSON_CAP)
  })

  it('counts the last 24 hours, not the calendar day, and not another person', async () => {
    await wrote(minutes(5))
    const other = await account('5491100000099')
    await wrote(minutes(5), '5491100000099')
    const old = await history()
    for (let i = 0; i < PERSON_CAP; i++) {
      await sql`INSERT INTO reminder_send (reminder_id, due_at, kind, started_at, status)
        VALUES (${old}, ${new Date(Date.UTC(2026, 0, 1 + i))}, 'text', ${ago(minutes(60 * 24 - 1) - i * 1000)}, 'sent')`
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
      await sql`INSERT INTO reminder_send (reminder_id, due_at, kind, started_at, status)
        VALUES (${old}, ${new Date(Date.UTC(2026, 0, 1 + i))}, 'text', ${ago(minutes(10))}, 'failed')`
    }
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.attempts).toBe(1)
  })

  it(`only alerts, and does not block, above ${DAILY_ALERT} sends a day overall`, async () => {
    await wrote(minutes(5))
    // 200 sends in the last day, ten each for twenty other people (so that no one is at their own cap).
    await sql`INSERT INTO account (wa_id) SELECT '54911000' || n FROM generate_series(1, 20) AS n`
    await sql`INSERT INTO reminder (account_id, what, schedule)
      SELECT id, 'old', '{}'::jsonb FROM account WHERE wa_id LIKE '54911000%' AND wa_id <> ${WA}`
    await sql`INSERT INTO reminder_send (reminder_id, due_at, kind, started_at, status)
      SELECT r.id, '2026-01-01'::timestamptz + n * interval '1 day', 'text', ${ago(minutes(30))}, 'sent'
      FROM reminder r CROSS JOIN generate_series(1, 10) AS n WHERE r.what = 'old'`
    expect(DAILY_ALERT).toBe(200)
    await remind('the 201st', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    await sender(fake.graph).sweep()
    expect(fake.calls.sent.map((s) => s.body)).toEqual(['⏰ Recordatorio: the 201st'])
    const alerts = vi
      .mocked(log)
      .mock.calls.filter(
        ([e, f]) => e === 'alert' && (f as { reason: string }).reason === 'reminder_daily_volume',
      )
    expect(alerts).toHaveLength(1)
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
    expect(vi.mocked(log).mock.calls.some(([e]) => e === 'reminder_send_failed')).toBe(true)
  })

  it('still sends text inside the window, and a 131047 then ends failed with its code', async () => {
    await wrote(minutes(5))
    await remind('a', oneOff('2026-11-22 11:55'))
    const open = fakeGraph()
    await sender(open.graph, null).sweep()
    expect(open.calls.sent).toHaveLength(1)

    await remind('b', oneOff('2026-11-22 11:56'))
    const closing = fakeGraph({
      send: async () => {
        throw new GraphError(400, 'Re-engagement message', 131047)
      },
    })
    await sender(closing.graph, null).sweep()
    expect(closing.calls.templates).toEqual([])
    expect((await sends()).at(-1)).toMatchObject({ status: 'failed', error_code: 131047 })
  })
})

describe('delivery status webhooks', () => {
  const statusBody = (id: string, status: string, errors?: unknown) =>
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id, status, timestamp: '1760000000', ...(errors ? { errors } : {}) }],
              },
            },
          ],
        },
      ],
    })

  it('a failed status for a reminder’s wamid updates its send and does not make a reply row', async () => {
    await wrote(minutes(5))
    await remind('x', oneOff('2026-11-22 11:55'))
    const fake = fakeGraph()
    const app = await setup({ fake })
    try {
      await sender(fake.graph).sweep()
      expect(await sends()).toMatchObject([{ status: 'sent', wamid: 'wamid.OUT1' }])

      await post(app.base, statusBody('wamid.OUT1', 'delivered'))
      expect(await sends()).toMatchObject([{ status: 'sent' }])

      await post(
        app.base,
        statusBody('wamid.OUT1', 'failed', [{ code: 131049, title: 'healthy ecosystem' }]),
      )
      expect(await sends()).toMatchObject([
        { status: 'failed', error_code: 131049, wamid: 'wamid.OUT1' },
      ])
      const replies =
        await sql`SELECT count(*)::int AS n FROM reply WHERE outbound_wamid = 'wamid.OUT1'`
      expect(replies[0]?.n).toBe(0)
      expect(
        vi
          .mocked(log)
          .mock.calls.some(
            ([e, f]) => e === 'status_failed' && (f as { reminder?: boolean }).reminder === true,
          ),
      ).toBe(true)
    } finally {
      app.close()
    }
  })

  it('a status for any other wamid still goes to reply, as before', async () => {
    const app = await setup()
    try {
      await post(app.base, statusBody('wamid.REPLY', 'failed', [{ code: 131026 }]))
      const rows = await sql`SELECT failed_at FROM reply WHERE outbound_wamid = 'wamid.REPLY'`
      expect(rows[0]?.failed_at).not.toBeNull()
    } finally {
      app.close()
    }
  })
})

describe('insertReminder', () => {
  it('refuses a schedule with nothing left after now', async () => {
    await expect(
      insertReminder(sql, { accountId, what: 'x', schedule: oneOff('2026-11-20 09:00'), now: NOW }),
    ).rejects.toThrow()
  })

  it('refuses text that is not one line', async () => {
    await expect(
      insertReminder(sql, {
        accountId,
        what: 'a\nb',
        schedule: oneOff('2026-11-23 09:00'),
        now: NOW,
      }),
    ).rejects.toThrow()
  })
})
