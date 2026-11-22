import { describe, expect, it } from 'vitest'
import { applyReminderCall } from './apply'
import { ask, logOf, movement, replyCall, say, script, seed, WA } from './command-fixtures'
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
import {
  fakeGraph,
  fakeModel,
  fakeTranscriber,
  heard,
  OGG,
  post,
  row,
  setup,
  sql,
  TODAY,
  until,
  useDatabase,
  voiceBody,
} from './test-harness'

// With PG_TEST_URL set (see AGENTS.md) this runs on a real Postgres, in a schema of its own.
const url = process.env.PG_TEST_URL
useDatabase(url ? { url, max: 12, schema: 'reminder_agent_test' } : undefined)

/**
 * The harness's messages are sent at 2025-10-09 05:53 in Argentina (a Thursday): "today" in these tests.
 * Reminders are set, listed, cancelled, stopped with BAJA and undone through the real pipeline with a scripted model.
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
      `Ya tenés ${MAX_REMINDERS} recordatorios y no me entran más. Decime cuál cancelo y lo pongo.`,
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
        '• llamar al médico · hoy a las 18:00',
        '• pagar el alquiler (el 5 de cada mes a las 09:00) · próximo: el miércoles 5/11 a las 09:00',
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

describe('BAJA', () => {
  it('cancels every live reminder in one batch, with no model call, and says how many and how to bring them back', async () => {
    await seedReminder('pagar el alquiler', {
      start: '2025-10-01',
      every: 'month',
      month_days: [5],
    })
    await seedReminder('la pastilla', { start: '2025-10-10', every: 'week' })
    const app = await setup({ model: script(replyCall('no debería llamarse')) })
    const reply = await say(app, { text: 'BAJA' })
    expect(reply).toBe(
      '⏰ Cancelé tus 2 recordatorios. Si fue sin querer, escribí «deshacer» y vuelven.',
    )
    expect(app.model.n).toBe(0)
    const [message] = await messages()
    expect(message).toMatchObject({ action: 'remind', model_turns: 0 })
    const rows = await reminders()
    expect(rows.every((r) => r.cancelled && r.cancelled_by === message?.id)).toBe(true)
    app.close()
  })

  it('says so when there is nothing to cancel, and one is "tu recordatorio"', async () => {
    const app = await setup({ model: script(replyCall('x')) })
    expect(await say(app, { text: 'baja' })).toBe('No tenés recordatorios para cancelar.')
    await seedReminder('la pastilla', { start: '2025-10-10' })
    expect(await say(app, { text: 'Baja.' })).toBe(
      '⏰ Cancelé tu recordatorio. Si fue sin querer, escribí «deshacer» y vuelve.',
    )
    expect(app.model.n).toBe(0)
    app.close()
  })

  it('works while a question is open: an opt-out does not wait for an answer', async () => {
    await seedReminder('la pastilla', { start: '2025-10-10' })
    const [a, b] = await seed([
      { on: TODAY, amount: '3500', description: 'café' },
      { on: TODAY, amount: '3500', description: 'café' },
    ])
    const app = await setup({ model: script(ask([a as number, b as number])) })
    expect(await say(app, { text: 'cambiá el café' })).toContain('¿Cuál?')
    expect(await say(app, { text: 'BAJA' })).toContain('Cancelé tu recordatorio')
    expect(app.model.n).toBe(1)
    app.close()
  })

  it('is typed text only: by voice it goes to the model', async () => {
    await seedReminder('la pastilla', { start: '2025-10-10' })
    const { transcriber } = fakeTranscriber(heard('baja'))
    const app = await setup({
      fake: fakeGraph({ media: { 'media.v': OGG } }),
      transcriber,
      model: script(replyCall('Para cancelar todos los recordatorios escribime «BAJA».')),
    })
    await post(app.base, voiceBody('wamid.VOICE1', 'media.v'))
    await until(async () =>
      ['done', 'failed'].includes(String((await row('wamid.VOICE1'))?.status)),
    )
    expect(app.model.n).toBe(1)
    expect(await liveWhats()).toEqual(['la pastilla'])
    app.close()
  })

  it('"baja" with more in it is not BAJA', async () => {
    await seedReminder('la pastilla', { start: '2025-10-10' })
    const app = await setup({ model: script(replyCall('no sé')) })
    await say(app, { text: 'baja el precio del café' })
    expect(app.model.n).toBe(1)
    expect(await liveWhats()).toEqual(['la pastilla'])
    app.close()
  })

  it('"deshacer" brings them all back, as new rows, with their next date worked out from now', async () => {
    const daily = await seedReminder('tomar agua', {
      start: '2025-10-01',
      time: '09:00',
      every: 'day',
    })
    const once = await seedReminder('llamar al médico', { start: '2025-10-09', time: '18:00' })
    const app = await setup({ model: script(replyCall('x')) })
    await say(app, { text: 'BAJA', at: later('05:53') })
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
    expect(app.model.n).toBe(0)
    // The old rows stay cancelled: history is never edited.
    expect(rows.filter((r) => r.cancelled)).toHaveLength(2)
    app.close()
  })

  it('refuses to bring back a one-off whose time has passed, and changes nothing', async () => {
    await seedReminder('llamar al médico', { start: '2025-10-09', time: '18:00' })
    const app = await setup({ model: script(replyCall('x')) })
    await say(app, { text: 'BAJA', at: later('05:53') })
    const reply = await say(app, { text: 'deshacer', at: later('19:00') })
    expect(reply).toBe(
      'No deshice nada: ⏰ llamar al médico cambió después. Decime qué querés cambiar.',
    )
    expect(await liveWhats()).toEqual([])
    expect(await reminders()).toHaveLength(1)
    app.close()
  })

  it('does not exceed the cap when it brings them back', async () => {
    for (let i = 0; i < MAX_REMINDERS; i++) await seedReminder(`r${i}`, { start: '2025-10-20' })
    const app = await setup({ model: script(replyCall('x')) })
    await say(app, { text: 'BAJA', at: later('05:53') })
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

  it('a set that BAJA cancelled and "deshacer" restored can still be undone as the set', async () => {
    const app = await setup({
      model: script(setRem('pagar la Visa', { start: '2025-10-10' }), replyCall('x')),
    })
    await say(app, { text: 'recordame mañana pagar la visa' })
    await say(app, { text: 'BAJA' })
    expect(await liveWhats()).toEqual([])
    await say(app, { text: 'deshacer' }) // BAJA undone: the reminder is back as a new row
    expect(await liveWhats()).toEqual(['pagar la Visa'])
    // The next "deshacer" reaches the set before it (BAJA's batch is undone) and cancels the row that stands now.
    expect(await say(app, { text: 'deshacer' })).toBe('↩︎ Deshice:\n• Quité ⏰ pagar la Visa')
    expect(await liveWhats()).toEqual([])
    app.close()
  })
})

describe('the help text', () => {
  it('tells how to set, list and stop reminders', async () => {
    const app = await setup({ model: script({ name: 'help', input: {} }) })
    const reply = await say(app, { text: 'ayuda' })
    expect(reply).toContain('recordame')
    expect(reply).toContain('BAJA')
    app.close()
  })
})
