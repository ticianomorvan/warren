import { describe, expect, it } from 'vitest'
import { applyReminderCall } from './apply'
import { logOf, movement, replyCall, say, script, WA } from './command-fixtures'
import { insertReminder } from './reminders/db'
import { MAX_REMINDERS } from './reminders/guard'
import { ScheduleSchema } from './reminders/schedule'
import { createReminderSender } from './reminders/send'
import {
  REPLY_FACT_SECRET,
  REPLY_REMINDER_FAR,
  REPLY_REMINDER_PAST,
  REPLY_UNDO_NOTHING,
} from './render'
import type { ToolCall } from './test-harness'
import { fakeGraph, fakeModel, setup, sql, useDatabase } from './test-harness'

// With PG_TEST_URL set (see AGENTS.md) this runs on a real Postgres, in a schema of its own.
const url = process.env.PG_TEST_URL
useDatabase(url ? { url, max: 12, schema: 'reminder_agent_test' } : undefined)

/**
 * The harness's messages are sent at 2025-10-09 05:53 in Argentina (a Thursday): "today" in these tests.
 * Reminders are set, listed, cancelled, cancelled (one or all) and undone through the real pipeline with a scripted model.
 */
const NOW = new Date('2025-10-09T05:53:20-03:00')
const sched = (s: Record<string, unknown>) => ({ time: '09:00', interval: 1, ...s })
const setRem = (
  what: string,
  schedule: Record<string, unknown>,
  text: string | null = null,
): ToolCall => ({
  name: 'set_reminder',
  input: { what, schedule: sched(schedule), text },
})
const cancelRem = (id: number): ToolCall => ({ name: 'cancel_reminder', input: { id, text: null } })
const listRem: ToolCall = { name: 'list_reminders', input: { text: null } }
const later = (hhmm: string, day = '2025-10-09') => `${day}T${hhmm}:00-03:00`

let accountId = 0
async function seedReminder(
  what: string,
  schedule: Record<string, unknown>,
  now = NOW,
): Promise<number> {
  const [account] = await sql`
    INSERT INTO account (wa_id) VALUES (${WA})
    ON CONFLICT (wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id RETURNING id::int AS id`
  accountId = Number(account?.id)
  const [seed] = await sql`
    INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status)
    VALUES (${`seed.${what}.${Math.random()}`}, ${WA}, 'text', 'seed', '{}'::jsonb, 'done') RETURNING id::int AS id`
  const made = await insertReminder(sql, {
    accountId,
    what,
    schedule: ScheduleSchema.parse(sched(schedule)),
    now,
    inboundId: Number(seed?.id),
  })
  return made.id
}

const reminders = () =>
  sql`SELECT id::int AS id, what, next_due_at, sent_count, inbound_message_id::int AS inbound,
    cancelled_at IS NOT NULL AS cancelled, cancelled_by::int AS cancelled_by, restores::int AS restores
    FROM reminder ORDER BY id`
const liveWhats = async () =>
  (
    await sql`SELECT what FROM reminder WHERE cancelled_at IS NULL AND next_due_at IS NOT NULL ORDER BY id`
  ).map((r) => r.what)
const messages = () =>
  sql`SELECT id::int AS id, action, model_turns, reply_text, undoes::int AS undoes, body, command
    FROM inbound_message WHERE wamid LIKE 'wamid.CMD%' ORDER BY id`
const contextOf = (app: Awaited<ReturnType<typeof setup>>, k: number): string => {
  const content = app.requests[k]?.messages[0]?.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

describe('set_reminder', () => {
  it('stores a one-off, says what code understood and touches no movement', async () => {
    const app = await setup({
      model: script(setRem('pagar la Visa', { start: '2025-10-09', time: '18:00' })),
    })
    const reply = await say(app, { text: 'recordame hoy a las 6 pagar la visa' })
    expect(reply).toBe('⏰ Te aviso hoy a las 18:00: pagar la Visa.')
    const [stored] = await reminders()
    const [message] = await messages()
    expect(stored).toMatchObject({
      what: 'pagar la Visa',
      next_due_at: new Date('2025-10-09T21:00:00Z'),
      sent_count: 0,
      inbound: message?.id,
      cancelled: false,
    })
    expect(message).toMatchObject({ action: 'remind', model_turns: 1 })
    expect(Number((await sql`SELECT count(*) AS n FROM movement`)[0]?.n)).toBe(0)
    app.close()
  })

  it('renders a repeated schedule from the typed fields, not from the model’s words', async () => {
    const app = await setup({
      model: script(
        setRem(
          'tomar la pastilla',
          { start: '2025-10-10', time: '08:00', every: 'week', weekdays: ['thu', 'mon'] },
          'Dale, te aviso todos los martes',
        ),
      ),
    })
    const reply = await say(app, { text: 'los lunes y jueves recordame tomar la pastilla a las 8' })
    expect(reply.split('\n')[0]).toBe(
      '⏰ Te aviso todos los lunes y jueves a las 08:00, desde el lunes 13/10: tomar la pastilla.',
    )
    app.close()
  })

  it('collapses the text to one line before it is stored', async () => {
    const app = await setup({
      model: script(setRem('  pagar \n la   Visa  ', { start: '2025-10-10' })),
    })
    await say(app, { text: 'recordame pagar la visa mañana' })
    expect(await liveWhats()).toEqual(['pagar la Visa'])
    app.close()
  })

  it('answers a time that has passed with code’s own line and stores nothing', async () => {
    const app = await setup({
      model: script(setRem('llamar al banco', { start: '2025-10-09', time: '05:00' })),
    })
    expect(await say(app, { text: 'recordame hoy a las 5 llamar al banco' })).toBe(
      REPLY_REMINDER_PAST,
    )
    expect(await reminders()).toEqual([])
    expect(app.model.n).toBe(1)
    app.close()
  })

  it('answers a date more than a year away', async () => {
    const app = await setup({
      model: script(setRem('algo', { start: '2027-01-01' })),
    })
    expect(await say(app, { text: 'recordame algo el 1 de enero de 2027' })).toBe(
      REPLY_REMINDER_FAR,
    )
    expect(await reminders()).toEqual([])
    app.close()
  })

  it('refuses a secret in the text: nothing is stored and the message is wiped', async () => {
    const app = await setup({
      model: script(setRem('pagar con la clave 7788', { start: '2025-10-10' })),
    })
    const reply = await say(app, { text: 'recordame mañana pagar con la clave 7788' })
    expect(reply).toBe(REPLY_FACT_SECRET)
    expect(await reminders()).toEqual([])
    const [message] = await messages()
    expect(message?.body).toBe('[dato sensible, no guardado]')
    app.close()
  })

  it('sends the model back a refusal it can fix: a number the person did not write', async () => {
    const app = await setup({
      model: script(
        setRem('pagar 4509 de la visa', { start: '2025-10-10' }),
        setRem('pagar la visa', { start: '2025-10-10' }),
      ),
    })
    const reply = await say(app, { text: 'recordame pagar la visa mañana' })
    expect(reply).toContain('Te aviso')
    expect(app.model.n).toBe(2)
    expect(await liveWhats()).toEqual(['pagar la visa'])
    app.close()
  })

  it(`holds ${MAX_REMINDERS} reminders at most, and says so`, async () => {
    for (let i = 0; i < MAX_REMINDERS; i++) await seedReminder(`r${i}`, { start: '2025-10-20' })
    const app = await setup({ model: script(setRem('uno más', { start: '2025-10-21' })) })
    const reply = await say(app, { text: 'recordame uno más' })
    expect(reply).toBe(
      `Ya tenés ${MAX_REMINDERS} recordatorios y no me entran más. Cancelá uno y pedime este de nuevo.`,
    )
    expect(await reminders()).toHaveLength(MAX_REMINDERS)
    app.close()
  })

  it('a message can log a movement and set a reminder; one "deshacer" takes back both', async () => {
    const app = await setup({
      model: script([
        logOf(movement({ description: 'luz', amount: '15000', category: 'servicios' })),
        setRem('pagar el gas', { start: '2025-10-20' }),
      ]),
    })
    const reply = await say(app, { text: 'pagué la luz 15000 y recordame pagar el gas el 20' })
    expect(reply).toContain('✓')
    expect(reply).toContain('⏰ Te aviso')
    const undone = await say(app, { text: 'deshacer' })
    expect(undone).toContain('↩︎ Deshice:')
    expect(undone).toContain('Quité ⏰ pagar el gas')
    expect(await liveWhats()).toEqual([])
    expect(app.model.n).toBe(1)
    app.close()
  })

  it('a reminder set here is sent by the sender when it is due', async () => {
    const app = await setup({
      model: script(setRem('pagar la Visa', { start: '2025-10-09', time: '18:00' })),
    })
    await say(app, { text: 'recordame hoy a las 6 pagar la visa' })
    const fake = fakeGraph()
    const sender = createReminderSender({
      sql,
      graph: fake.graph,
      allowed: ['*'],
      template: 'warren_reminder',
      now: () => new Date('2025-10-09T18:00:30-03:00'),
    })
    await sender.sweep()
    expect(fake.calls.sent).toEqual([{ to: WA, body: '⏰ Recordatorio: pagar la Visa' }])
    app.close()
  })
})

describe('what the model is shown', () => {
  it('lists the live reminders with an id and the date in words, and the days ahead', async () => {
    const alquiler = await seedReminder('pagar el alquiler', {
      start: '2025-10-01',
      every: 'month',
      month_days: [5],
    })
    const pastilla = await seedReminder('la pastilla', {
      start: '2025-10-01',
      time: '08:00',
      every: 'week',
      weekdays: ['mon', 'thu'],
    })
    await seedReminder('terminado', { start: '2025-10-09', time: '06:00' }) // next 06:00 today: live
    const [gone] = await sql`SELECT id FROM reminder WHERE what = 'terminado'`
    await sql`UPDATE reminder SET next_due_at = NULL WHERE id = ${gone?.id}` // already sent: not live
    const app = await setup({ model: script(replyCall('ok')) })
    await say(app, { text: 'hola' })
    const context = contextOf(app, 0)
    expect(context).toContain('Recordatorios de la persona')
    expect(context).toContain(
      `id=${pastilla} "la pastilla" — todos los lunes y jueves a las 08:00 (próximo: hoy a las 08:00)`,
    )
    expect(context).toContain(
      `id=${alquiler} "pagar el alquiler" — el 5 de cada mes a las 09:00 (próximo: el miércoles 5/11 a las 09:00)`,
    )
    expect(context).not.toContain('terminado')
    expect(context).toContain('Próximos días')
    expect(context).toContain('mañana: viernes 2025-10-10')
    app.close()
  })

  it('shows nothing when there are none', async () => {
    const app = await setup({ model: script(replyCall('ok')) })
    await say(app, { text: 'hola' })
    expect(contextOf(app, 0)).not.toContain('Recordatorios de la persona')
    app.close()
  })
})

describe('cancel_reminder and list_reminders', () => {
  it('cancels one, by an id it was shown: the row stays, stamped with the message', async () => {
    const alquiler = await seedReminder('pagar el alquiler', {
      start: '2025-10-01',
      every: 'month',
      month_days: [5],
    })
    await seedReminder('la pastilla', { start: '2025-10-10', every: 'week' })
    const app = await setup({ model: script(cancelRem(alquiler)) })
    const reply = await say(app, { text: 'cancelá el del alquiler' })
    expect(reply).toBe(
      '⏰ Cancelé el recordatorio: pagar el alquiler (el 5 de cada mes a las 09:00)',
    )
    const [message] = await messages()
    const rows = await reminders()
    expect(rows.find((r) => r.id === alquiler)).toMatchObject({
      cancelled: true,
      cancelled_by: message?.id,
    })
    expect(await liveWhats()).toEqual(['la pastilla'])
    app.close()
  })

  it('refuses an id it was not shown, and the model fixes it', async () => {
    const mine = await seedReminder('la pastilla', { start: '2025-10-10' })
    const app = await setup({ model: script(cancelRem(mine + 100), cancelRem(mine)) })
    const reply = await say(app, { text: 'cancelá la pastilla' })
    expect(reply).toContain('Cancelé el recordatorio: la pastilla')
    expect(app.model.n).toBe(2)
    app.close()
  })

  it('never cancels another person’s reminder, even with its id', async () => {
    const theirs = await seedReminder('de otro', { start: '2025-10-10' })
    const [other] =
      await sql`INSERT INTO account (wa_id) VALUES ('5491100000099') RETURNING id::int AS id`
    const [inbound] = await sql`INSERT INTO inbound_message (wamid, wa_id, kind, payload, status)
      VALUES ('x.other', '5491100000099', 'text', '{}'::jsonb, 'done') RETURNING id::int AS id`
    const done = await sql.begin((tx) =>
      applyReminderCall(
        tx as unknown as typeof sql,
        { accountId: Number(other?.id), batchId: Number(inbound?.id), now: NOW },
        { tool: 'cancel_reminder', input: { id: theirs, text: null } },
      ),
    )
    expect(done).toMatchObject({ kind: 'gone' })
    expect(await liveWhats()).toEqual(['de otro'])
  })

  it('says it is gone when it was sent or cancelled between the model and the commit', async () => {
    const id = await seedReminder('la pastilla', { start: '2025-10-10' })
    const app = await setup({
      model: fakeModel(async () => {
        // The reminder fires while the model is thinking.
        await sql`UPDATE reminder SET next_due_at = NULL WHERE id = ${id}`
        return [cancelRem(id)]
      }),
    })
    expect(await say(app, { text: 'cancelá la pastilla' })).toBe(
      '⏰ Ese recordatorio ya no existe.',
    )
    app.close()
  })

  it('lists every live reminder, the next first, with no model words', async () => {
    await seedReminder('pagar el alquiler', {
      start: '2025-10-01',
      every: 'month',
      month_days: [5],
    })
    await seedReminder('llamar al médico', { start: '2025-10-09', time: '18:00' })
    const app = await setup({ model: script(listRem) })
    const reply = await say(app, { text: 'qué recordatorios tengo?' })
    expect(reply).toBe(
      [
        '⏰ Tus recordatorios:',
        '• llamar al médico — hoy a las 18:00',
        '• pagar el alquiler — el 5 de cada mes a las 09:00 (próximo: el miércoles 5/11 a las 09:00)',
      ].join('\n'),
    )
    app.close()
  })

  it('says there are none', async () => {
    const app = await setup({ model: script(listRem) })
    expect(await say(app, { text: 'qué recordatorios tengo?' })).toBe('No tenés recordatorios.')
    app.close()
  })
})

describe('cancelling every reminder, through the model', () => {
  const all = (...ids: number[]): ToolCall[] => ids.map(cancelRem)

  it('several cancel_reminder calls in one turn are one batch, one line each, and nothing is invented', async () => {
    const alquiler = await seedReminder('pagar el alquiler', {
      start: '2025-10-01',
      every: 'month',
      month_days: [5],
    })
    const pastilla = await seedReminder('la pastilla', { start: '2025-10-10', every: 'week' })
    const app = await setup({ model: script(all(alquiler, pastilla)) })
    const reply = await say(app, { text: 'cancelá todos los recordatorios' })
    expect(reply.split('\n')).toEqual([
      '⏰ Cancelé el recordatorio: pagar el alquiler (el 5 de cada mes a las 09:00)',
      '⏰ Cancelé el recordatorio: la pastilla (todos los viernes a las 09:00)',
    ])
    expect(app.model.n).toBe(1)
    const [message] = await messages()
    expect(message).toMatchObject({ action: 'multi', model_turns: 1 })
    const rows = await reminders()
    expect(rows.every((r) => r.cancelled && r.cancelled_by === message?.id)).toBe(true)
    app.close()
  })

  it('only the ids it was shown: an id it invented is refused and the model sends them again', async () => {
    const mine = await seedReminder('la pastilla', { start: '2025-10-10' })
    const app = await setup({ model: script(all(mine, mine + 50), all(mine)) })
    const reply = await say(app, { text: 'cancelá todos los recordatorios' })
    expect(reply).toBe('⏰ Cancelé el recordatorio: la pastilla (mañana a las 09:00)')
    expect(app.model.n).toBe(2)
    app.close()
  })

  it('an id sent twice is cancelled once and the second line says it is gone', async () => {
    const id = await seedReminder('la pastilla', { start: '2025-10-10' })
    const app = await setup({ model: script(all(id, id)) })
    expect((await say(app, { text: 'cancelá este' })).split('\n')).toEqual([
      '⏰ Cancelé el recordatorio: la pastilla (mañana a las 09:00)',
      '⏰ Ese recordatorio ya no existe.',
    ])
    app.close()
  })

  it('a bare "baja" is a message like any other: it goes to the model', async () => {
    await seedReminder('la pastilla', { start: '2025-10-10' })
    const app = await setup({ model: script(replyCall('¿Querés que cancele el de la pastilla?')) })
    await say(app, { text: 'baja' })
    expect(app.model.n).toBe(1)
    expect(await liveWhats()).toEqual(['la pastilla'])
    app.close()
  })

  it('"deshacer" brings them all back with one message, as new rows, with their next date worked out from now', async () => {
    const daily = await seedReminder('tomar agua', {
      start: '2025-10-01',
      time: '09:00',
      every: 'day',
    })
    const once = await seedReminder('llamar al médico', { start: '2025-10-09', time: '18:00' })
    const app = await setup({ model: script(all(daily, once)) })
    await say(app, { text: 'cancelá todos los recordatorios', at: later('05:53') })
    expect(await liveWhats()).toEqual([])
    // Back at 10:00: today's 09:00 has passed, so the daily one is tomorrow's; the one-off at 18:00 is still ahead.
    const reply = await say(app, { text: 'deshacer', at: later('10:00') })
    expect(reply).toBe(
      [
        '↩︎ Deshice:',
        '• Volvió ⏰ tomar agua (todos los días a las 09:00)',
        '• Volvió ⏰ llamar al médico (hoy a las 18:00)',
      ].join('\n'),
    )
    const rows = await reminders()
    const [undo] = (await messages()).slice(-1)
    const back = rows.filter((r) => r.restores !== null)
    expect(back.map((r) => [r.restores, r.inbound])).toEqual([
      [daily, undo?.id],
      [once, undo?.id],
    ])
    expect(back[0]?.next_due_at).toEqual(new Date('2025-10-10T12:00:00Z'))
    expect(back[1]?.next_due_at).toEqual(new Date('2025-10-09T21:00:00Z'))
    expect(app.model.n).toBe(1)
    // The old rows stay cancelled: history is never edited.
    expect(rows.filter((r) => r.cancelled)).toHaveLength(2)
    app.close()
  })

  it('refuses to bring back a one-off whose time has passed, and changes nothing', async () => {
    const id = await seedReminder('llamar al médico', { start: '2025-10-09', time: '18:00' })
    const app = await setup({ model: script(cancelRem(id)) })
    await say(app, { text: 'cancelá este', at: later('05:53') })
    const reply = await say(app, { text: 'deshacer', at: later('19:00') })
    expect(reply).toBe(
      'No deshice nada: ⏰ llamar al médico cambió después. Decime qué querés cambiar.',
    )
    expect(await liveWhats()).toEqual([])
    expect(await reminders()).toHaveLength(1)
    app.close()
  })

  it('does not exceed the cap when it brings them back', async () => {
    const ids: number[] = []
    for (let i = 0; i < MAX_REMINDERS; i++) {
      ids.push(await seedReminder(`r${i}`, { start: '2025-10-20' }))
    }
    const app = await setup({ model: script(all(...ids)) })
    // All twenty in one turn: one batch of twenty lines.
    expect(
      (await say(app, { text: 'cancelá todos', at: later('05:53') })).split('\n'),
    ).toHaveLength(MAX_REMINDERS)
    // The person has 20 new ones by now: bringing back the 20 would make 40.
    for (let i = 0; i < MAX_REMINDERS; i++) await seedReminder(`n${i}`, { start: '2025-10-20' })
    expect(await say(app, { text: 'deshacer', at: later('06:10') })).toContain('No deshice nada')
    expect(await liveWhats()).toHaveLength(MAX_REMINDERS)
    app.close()
  })
})

describe('undo', () => {
  it('"deshacer" right after setting one cancels it', async () => {
    const app = await setup({
      model: script(setRem('pagar la Visa', { start: '2025-10-10' })),
    })
    await say(app, { text: 'recordame mañana pagar la visa' })
    expect(await say(app, { text: 'deshacer' })).toBe('↩︎ Deshice:\n• Quité ⏰ pagar la Visa')
    const rows = await reminders()
    const [, undo] = await messages()
    expect(rows[0]).toMatchObject({ cancelled: true, cancelled_by: undo?.id })
    expect(await say(app, { text: 'deshacer' })).toBe(REPLY_UNDO_NOTHING)
    app.close()
  })

  it('"deshacer" after cancelling one brings it back', async () => {
    const id = await seedReminder('pagar el alquiler', {
      start: '2025-10-01',
      every: 'month',
      month_days: [5],
    })
    const app = await setup({ model: script(cancelRem(id)) })
    await say(app, { text: 'cancelá el del alquiler' })
    const reply = await say(app, { text: 'deshacer' })
    expect(reply).toBe('↩︎ Deshice:\n• Volvió ⏰ pagar el alquiler (el 5 de cada mes a las 09:00)')
    expect(await liveWhats()).toEqual(['pagar el alquiler'])
    app.close()
  })

  it('refuses when a one-off has already been sent: nothing to take back', async () => {
    const app = await setup({
      model: script(setRem('pagar la Visa', { start: '2025-10-09', time: '18:00' })),
    })
    await say(app, { text: 'recordame hoy a las 6 pagar la visa', at: later('05:53') })
    // It was sent (the sender ended it).
    await sql`UPDATE reminder SET next_due_at = NULL, sent_count = 1`
    const reply = await say(app, { text: 'deshacer', at: later('18:05') })
    expect(reply).toBe(
      'No deshice nada: ⏰ pagar la Visa cambió después. Decime qué querés cambiar.',
    )
    app.close()
  })

  it('refuses when the reminder was cancelled by a later message', async () => {
    const app = await setup({
      model: script(setRem('pagar la Visa', { start: '2025-10-10' }), replyCall('x')),
    })
    await say(app, { text: 'recordame mañana pagar la visa' })
    const [made] = await reminders()
    await sql`INSERT INTO inbound_message (wamid, wa_id, kind, payload, status)
      VALUES ('later.cancel', ${WA}, 'text', '{}'::jsonb, 'done')`
    const [cancel] = await sql`SELECT id FROM inbound_message WHERE wamid = 'later.cancel'`
    await sql`UPDATE reminder SET cancelled_at = now(), cancelled_by = ${cancel?.id} WHERE id = ${made?.id}`
    expect(await say(app, { text: 'deshacer' })).toBe(
      'No deshice nada: ⏰ pagar la Visa cambió después. Decime qué querés cambiar.',
    )
    app.close()
  })

  it('a set that a later message cancelled and "deshacer" restored can still be undone as the set', async () => {
    const app = await setup({
      model: script(setRem('pagar la Visa', { start: '2025-10-10' }), cancelRem(1)),
    })
    await say(app, { text: 'recordame mañana pagar la visa' })
    await say(app, { text: 'cancelá el de la visa' })
    expect(await liveWhats()).toEqual([])
    await say(app, { text: 'deshacer' }) // the cancel undone: the reminder is back as a new row
    expect(await liveWhats()).toEqual(['pagar la Visa'])
    // The next "deshacer" reaches the set before it (the cancel's batch is undone) and cancels the row that stands now.
    expect(await say(app, { text: 'deshacer' })).toBe('↩︎ Deshice:\n• Quité ⏰ pagar la Visa')
    expect(await liveWhats()).toEqual([])
    app.close()
  })
})

describe('the help text', () => {
  it('tells how to set, list and cancel reminders', async () => {
    const app = await setup({ model: script({ name: 'help', input: {} }) })
    const reply = await say(app, { text: 'ayuda' })
    expect(reply).toContain('recordame')
    expect(reply).not.toContain('BAJA')
    expect(reply).toContain('cancele')
    app.close()
  })
})

describe('a time that has passed by the clock, not only by the message', () => {
  it('refuses a reminder for a moment that went by while the message waited', async () => {
    // Written at 05:53, asked for 06:00; the message was only processed at 06:10 (an outage, a deploy).
    const app = await setup({
      model: script(setRem('tomar agua', { start: '2025-10-09', time: '06:00' })),
      clock: () => new Date('2025-10-09T06:10:00-03:00'),
    })
    expect(await say(app, { text: 'recordame en 7 minutos tomar agua' })).toBe(REPLY_REMINDER_PAST)
    expect(await reminders()).toEqual([])
    app.close()
  })

  it('and sets it when the clock has not got there', async () => {
    const app = await setup({
      model: script(setRem('tomar agua', { start: '2025-10-09', time: '06:00' })),
      clock: () => new Date('2025-10-09T05:55:00-03:00'),
    })
    expect(await say(app, { text: 'recordame en 7 minutos tomar agua' })).toContain(
      '⏰ Te aviso hoy a las 06:00',
    )
    app.close()
  })
})

describe('a stored reminder whose schedule no longer parses', () => {
  const corrupt = async (id: number) =>
    sql`UPDATE reminder SET schedule = '{"start": "nonsense"}'::jsonb WHERE id = ${id}`

  it('is left out of the context and the list; the others still work, and every message still gets answered', async () => {
    const bad = await seedReminder('roto', { start: '2025-10-10' })
    await seedReminder('la pastilla', { start: '2025-10-10', every: 'week' })
    await corrupt(bad)
    const app = await setup({ model: script(listRem, replyCall('ok')) })
    const reply = await say(app, { text: 'qué recordatorios tengo?' })
    expect(reply).toContain('la pastilla')
    expect(reply).not.toContain('roto')
    await say(app, { text: 'hola' })
    expect(contextOf(app, 1)).toContain('la pastilla')
    expect(contextOf(app, 1)).not.toContain('roto')
    app.close()
  })

  it('does not count toward the cap: nobody can see or cancel it', async () => {
    const bad = await seedReminder('roto', { start: '2025-10-20' })
    for (let i = 0; i < MAX_REMINDERS - 1; i++) await seedReminder(`r${i}`, { start: '2025-10-20' })
    await corrupt(bad)
    const app = await setup({
      model: script(
        setRem('uno más', { start: '2025-10-21' }),
        setRem('y otro', { start: '2025-10-22' }),
      ),
    })
    // 19 that parse and 1 that does not: one more fits (20), and then the account is full.
    expect(await say(app, { text: 'recordame uno más' })).toContain('⏰ Te aviso')
    expect(await say(app, { text: 'recordame y otro' })).toContain('no me entran más')
    app.close()
  })

  it('cancelling all of the others leaves it alone, and the message is answered', async () => {
    const bad = await seedReminder('roto', { start: '2025-10-10' })
    const good = await seedReminder('la pastilla', { start: '2025-10-10', every: 'week' })
    await corrupt(bad)
    const app = await setup({ model: script(cancelRem(good)) })
    expect(await say(app, { text: 'cancelá todos los recordatorios' })).toContain('la pastilla')
    expect((await reminders()).filter((r) => !r.cancelled).map((r) => r.id)).toEqual([bad])
    app.close()
  })

  it('does not break an undo of the batch it sits in', async () => {
    const bad = await seedReminder('roto', { start: '2025-10-10' })
    const good = await seedReminder('la pastilla', { start: '2025-10-10', every: 'week' })
    await corrupt(bad)
    const app = await setup({ model: script(cancelRem(good)) })
    await say(app, { text: 'cancelá la pastilla' })
    expect(await say(app, { text: 'deshacer' })).toContain('Volvió ⏰ la pastilla')
    app.close()
  })
})

// A sweep that is finishing a one-off while an undo reads it: on a real Postgres only (the lock needs two connections).
describe.skipIf(!url)('real Postgres: an undo and the sender', () => {
  it('an undo that finds a one-off ended by a sweep in flight is refused as stale, not failed', async () => {
    const app = await setup({
      model: script(setRem('pagar la Visa', { start: '2025-10-09', time: '18:00' })),
    })
    await say(app, { text: 'recordame hoy a las 6 pagar la visa', at: later('05:53') })
    // A sweep holds the row (claiming it) and ends the one-off, while "deshacer" is on its way.
    const claiming = sql.begin(async (tx) => {
      await tx`SELECT id FROM reminder FOR UPDATE`
      await new Promise((r) => setTimeout(r, 600))
      await tx`UPDATE reminder SET next_due_at = NULL`
    })
    await new Promise((r) => setTimeout(r, 150))
    const undone = say(app, { text: 'deshacer', at: later('18:01') })
    await claiming
    expect(await undone).toBe(
      'No deshice nada: ⏰ pagar la Visa cambió después. Decime qué querés cambiar.',
    )
    app.close()
  })
})
