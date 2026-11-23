import { describe, expect, it } from 'vitest'
import {
  allFacts,
  allMovements,
  allReminders,
  cafe,
  cancel,
  correct,
  forget,
  forgetAll,
  liveFactList,
  liveMovements,
  liveReminderList,
  log,
  minutes,
  NOW,
  newAccount,
  remember,
  remind,
  remove,
  turn,
} from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { MAX_FACTS } from '../domain/facts'
import { MAX_REMINDERS } from '../domain/reminders/guard'
import type { Outcome } from './apply'
import type { Call } from './commands'
import { schemaDir } from './db'
import { checkValues } from './guards'

useDatabase({ migrations: schemaDir })

/** The outcome of the one write of a turn. */
async function one(
  accountId: number,
  call: Parameters<typeof turn>[2][number],
  at = NOW,
): Promise<Outcome> {
  const t = await turn(sql, accountId, [call], { at })
  return t.done[0]?.outcome as Outcome
}

describe('log_movements', () => {
  it('inserts new entities, in a turn, with the rows from RETURNING', async () => {
    const a = await newAccount(sql)
    const t = await turn(sql, a, [
      log(cafe(), cafe({ description: 'super', amount: '12000.50', payment: ' visa ' })),
    ])
    const o = t.done[0]?.outcome
    expect(o).toMatchObject({ tool: 'log_movements', status: 'applied', effect: 'logged' })
    if (o?.tool !== 'log_movements' || o.status !== 'applied') throw new Error('not applied')
    expect(o.movements.map((m) => [m.id, m.description, m.amount, m.payment, m.time])).toEqual([
      [1, 'café', '3500', null, '12:00'],
      [2, 'super', '12000.50', 'visa', '12:00'],
    ])
    expect((await allMovements(sql)).map((m) => [m.entity, m.made, m.ended])).toEqual([
      [1, t.turn, null],
      [2, t.turn, null],
    ])
  })

  it('refuses a value the table cannot hold, and the whole turn rolls back with no turn row', async () => {
    const a = await newAccount(sql)
    await expect(turn(sql, a, [log(cafe(), cafe({ amount: '1.234' }))])).rejects.toThrow(
      /movement_amount_cents/,
    )
    expect(await allMovements(sql)).toEqual([])
    expect(await sql`SELECT 1 FROM turn`).toHaveLength(0)
  })
})

describe('correct_movement', () => {
  it('ends the version and inserts the next of the same entity, with the time it was first logged', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const t = await turn(sql, a, [correct(1, { amount: '3800', payment: 'efectivo' })], {
      at: minutes(30),
    })
    const o = t.done[0]?.outcome
    expect(o).toMatchObject({
      status: 'applied',
      effect: 'corrected',
      changed: ['money', 'payment'],
    })
    const rows = await allMovements(sql)
    expect(rows.map((r) => [r.entity, r.amount, r.made, r.ended])).toEqual([
      [1, '3500', 1, t.turn],
      [1, '3800', t.turn, null],
    ])
    // The correction keeps when the movement was first logged (how the person tells it apart).
    expect(rows[1]?.logged).toEqual(rows[0]?.logged)
    if (o?.tool === 'correct_movement' && o.status === 'applied') {
      expect(o.old).toMatchObject({ id: 1, amount: '3500', time: '12:00' })
      expect(o.next).toMatchObject({ id: 1, amount: '3800', payment: 'efectivo', time: '12:00' })
    }
  })

  it('says unchanged when the values are the same, and writes nothing', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    expect(await one(a, correct(1, { amount: '3500.00' }))).toMatchObject({
      status: 'unchanged',
      effect: null,
    })
    expect(await allMovements(sql)).toHaveLength(1)
  })

  it('says gone for an id that is not live, and never touches another account’s movement', async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    expect(await one(b, correct(1, { amount: '1' }))).toMatchObject({
      status: 'gone',
      effect: null,
      id: 1,
    })
    expect(await one(b, remove(1))).toMatchObject({ status: 'gone' })
    await turn(sql, a, [remove(1)])
    expect(await one(a, correct(1, { amount: '1' }))).toMatchObject({ status: 'gone' })
    expect(await allMovements(sql)).toHaveLength(1)
  })

  it('two calls in one turn on the same entity: the second sees the first', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const t = await turn(sql, a, [correct(1, { amount: '3600' }), correct(1, { amount: '3700' })])
    expect(t.done.map((d) => d.outcome?.status)).toEqual(['applied', 'applied'])
    expect(await liveMovements(sql)).toEqual([{ entity: 1, amount: '3700', description: 'café' }])
  })
})

describe('a movement the person was shown, changed meanwhile', () => {
  /** What WhatsApp showed: entity 1 as it was in version `shown`. Then another channel corrects it. */
  async function shownThenChanged() {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const [v1] = await allMovements(sql)
    await turn(sql, a, [correct(1, { description: 'nafta', amount: '20000' })], {
      at: minutes(1),
      channel: 'mcp',
    })
    return { a, shown: v1?.id as number }
  }

  it('is not deleted in its new form: the call names the version that was shown', async () => {
    const { a, shown } = await shownThenChanged()
    const o = await one(a, { ...remove(1), version: shown } as Call, minutes(2))
    expect(o).toMatchObject({ tool: 'delete_movement', status: 'gone', id: 1 })
    expect(await liveMovements(sql)).toEqual([{ entity: 1, amount: '20000', description: 'nafta' }])
  })

  it('is not corrected in its new form either', async () => {
    const { a, shown } = await shownThenChanged()
    const o = await one(a, { ...correct(1, { amount: '1' }), version: shown } as Call, minutes(2))
    expect(o).toMatchObject({ tool: 'correct_movement', status: 'gone' })
  })

  it('a call with no version (an MCP client sees the live state) acts on the live one', async () => {
    const { a } = await shownThenChanged()
    expect(await one(a, remove(1), minutes(2))).toMatchObject({ status: 'applied' })
  })

  it('a version this very turn made is acted on: a correction then a delete of the same movement', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const [v1] = await allMovements(sql)
    const t = await turn(
      sql,
      a,
      [
        { ...correct(1, { amount: '4000' }), version: v1?.id },
        { ...remove(1), version: v1?.id },
      ] as Call[],
      { at: minutes(1) },
    )
    expect(t.done.map((d) => d.outcome?.status)).toEqual(['applied', 'applied'])
    expect(await liveMovements(sql)).toEqual([])
  })
})

describe('delete_movement', () => {
  it('ends the version in the turn and inserts nothing', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const t = await turn(sql, a, [remove(1)])
    expect(t.done[0]?.outcome).toMatchObject({ status: 'applied', effect: 'deleted' })
    expect((await allMovements(sql)).map((r) => [r.entity, r.ended])).toEqual([[1, t.turn]])
    expect(await liveMovements(sql)).toEqual([])
  })

  it('a movement is deleted once: the second delete says it is gone', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const t = await turn(sql, a, [remove(1), remove(1)])
    expect(t.done.map((d) => d.outcome?.status)).toEqual(['applied', 'gone'])
  })
})

describe('remember_fact and forget_fact', () => {
  it('stores a fact as an entity', async () => {
    const a = await newAccount(sql)
    expect(await one(a, remember('cobro', 'el 5'))).toMatchObject({
      status: 'applied',
      effect: 'remembered',
    })
    expect(await liveFactList(sql)).toEqual([{ entity: 1, key: 'cobro', value: 'el 5' }])
  })

  it('a new value for the same key is the next version of the same entity; the old one is kept and ended', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('la visa', 'galicia', 'alias')])
    const t = await turn(sql, a, [remember('la visa', 'santander', 'alias')])
    expect(t.done[0]?.outcome).toMatchObject({ status: 'applied', before: 'galicia' })
    expect((await allFacts(sql)).map((f) => [f.entity, f.value, f.ended])).toEqual([
      [1, 'galicia', t.turn],
      [1, 'santander', null],
    ])
  })

  it('the same value again writes nothing (case, accents and spacing aside)', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5')])
    expect(await one(a, remember('cobro', ' El  5 '))).toMatchObject({
      status: 'unchanged',
      effect: null,
    })
    expect(await allFacts(sql)).toHaveLength(1)
  })

  it('holds MAX_FACTS per account: nothing is stored, an update still goes through, and the cap is per account', async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    const seed = Array.from({ length: MAX_FACTS }, (_, i) => remember(`dato ${i}`, 'x'))
    for (let i = 0; i < seed.length; i += 25) await turn(sql, a, seed.slice(i, i + 25))
    expect(await one(a, remember('nuevo', 'x'))).toMatchObject({
      status: 'full',
      effect: null,
      max: MAX_FACTS,
    })
    expect(await one(a, remember('dato 3', 'otro'))).toMatchObject({
      status: 'applied',
      before: 'x',
    })
    expect(await one(b, remember('nuevo', 'x'))).toMatchObject({ status: 'applied' })
  })

  it('forgets by entity id or by key, and keeps the row', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5'), remember('la visa', 'galicia', 'alias')])
    expect(await one(a, forget({ id: 1 }))).toMatchObject({
      status: 'applied',
      effect: 'forgotten',
    })
    expect(await one(a, forget({ key: 'la visa' }))).toMatchObject({ status: 'applied' })
    expect(await liveFactList(sql)).toEqual([])
    expect(await allFacts(sql)).toHaveLength(2)
  })

  it('says gone for what is not live, and never forgets another account’s fact', async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5')])
    expect(await one(b, forget({ id: 1 }))).toMatchObject({ status: 'gone', target: { id: 1 } })
    expect(await one(b, forget({ key: 'cobro' }))).toMatchObject({
      status: 'gone',
      target: { key: 'cobro' },
    })
    await turn(sql, a, [forget({ id: 1 })])
    expect(await one(a, forget({ id: 1 }))).toMatchObject({ status: 'gone' })
  })

  it('two people with the same key are two facts', async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5')])
    await turn(sql, b, [remember('cobro', 'el 10')])
    await turn(sql, a, [remember('cobro', 'el 6')])
    await turn(sql, b, [forget({ key: 'cobro' })])
    expect(await liveFactList(sql)).toEqual([{ entity: 1, key: 'cobro', value: 'el 6' }])
  })

  it('forgetting everything forgets this account’s facts only, and says nothing when there are none', async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5'), remember('luz', 'el 12')])
    await turn(sql, b, [remember('cobro', 'el 10')])
    expect(await one(a, forgetAll)).toMatchObject({
      status: 'applied',
      facts: [{ key: 'cobro' }, { key: 'luz' }],
    })
    expect(await liveFactList(sql)).toEqual([{ entity: 3, key: 'cobro', value: 'el 10' }])
    expect(await one(a, forgetAll)).toMatchObject({ status: 'nothing', effect: null })
  })

  it('a fact never moves the ledger', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [remember('cobro', 'el 5')])
    await turn(sql, a, [forget({ key: 'cobro' })])
    expect(await liveMovements(sql)).toHaveLength(1)
    expect(await allMovements(sql)).toHaveLength(1)
  })
})

describe('set_reminder and cancel_reminder', () => {
  it('stores a one-off with its next occurrence, the text on one line', async () => {
    const a = await newAccount(sql)
    const o = await one(a, remind('pagar\n la  Visa', { month_day: 10, time: '09:00' }))
    expect(o).toMatchObject({
      status: 'applied',
      effect: 'reminded',
      reminder: { what: 'pagar la Visa' },
    })
    const [r] = await allReminders(sql)
    expect(r).toMatchObject({ entity: 1, what: 'pagar la Visa', ended: null })
    expect(r?.due).toEqual(new Date('2026-12-10T12:00:00Z'))
  })

  it('a repeating schedule counts from the first day', async () => {
    const a = await newAccount(sql)
    const o = await one(
      a,
      remind(
        'pastilla',
        { day: 'tomorrow', time: '08:00' },
        { every: 'week', weekdays: ['mon', 'thu'] },
      ),
    )
    if (o.tool !== 'set_reminder' || o.status !== 'applied') throw new Error('not applied')
    expect(o.reminder.schedule).toMatchObject({
      every: 'week',
      weekdays: ['mon', 'thu'],
      time: '08:00',
    })
    expect(o.reminder.nextDueAt?.toISOString()).toBe('2026-11-23T11:00:00.000Z') // Monday 23rd at 08:00
  })

  it('says past when the time has gone by, and writes nothing', async () => {
    const a = await newAccount(sql)
    expect(await one(a, remind('x', { day: 'today', time: '09:00' }))).toEqual({
      tool: 'set_reminder',
      status: 'past',
      effect: null,
    })
    expect(await allReminders(sql)).toEqual([])
  })

  it(`holds ${MAX_REMINDERS} reminders at most per account`, async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    for (let i = 0; i < MAX_REMINDERS; i++) await turn(sql, a, [remind(`r${i}`)])
    expect(await one(a, remind('uno más'))).toMatchObject({
      status: 'full',
      effect: null,
      max: MAX_REMINDERS,
    })
    expect(await one(b, remind('mío'))).toMatchObject({ status: 'applied' })
  })

  it('cancels by entity id and keeps the row; a second cancel, another account and a sent one-off say gone', async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    await turn(sql, a, [remind('pagar la Visa'), remind('luz')])
    expect(await one(b, cancel(1))).toMatchObject({ status: 'gone', id: 1 })
    const t = await turn(sql, a, [cancel(1), cancel(1)])
    expect(t.done.map((d) => d.outcome?.status)).toEqual(['applied', 'gone'])
    expect(await liveReminderList(sql)).toEqual([{ entity: 2, what: 'luz' }])
    // A one-off the sweep already finished (next_due_at null) is not live.
    await sql`UPDATE reminder SET next_due_at = NULL WHERE entity_id = 2`
    expect(await one(a, cancel(2))).toMatchObject({ status: 'gone' })
    expect(await allReminders(sql)).toHaveLength(2)
  })

  /** The call as `checkValues` returns it, at the instant the guard ran. */
  const guarded = (input: unknown, at: Date) => {
    const checked = checkValues('set_reminder', input, { today: '2026-11-20', now: at })
    if (checked.kind !== 'ok') throw new Error(`not ok: ${checked.kind}`)
    return checked.call
  }

  it('stores the schedule the guard approved, not one worked out from the message time again', async () => {
    const a = await newAccount(sql)
    // "todos los días a las 8, 3 veces" written at 07:59:50 and checked at 08:00:01: the guard moves the start to tomorrow.
    const written = new Date('2026-11-20T10:59:50Z')
    const checkedAt = new Date('2026-11-20T11:00:01Z')
    const call = guarded(
      { what: 'pastilla', first: { day: 'today', time: '08:00' }, every: 'day', count: 3 },
      checkedAt,
    )
    await turn(sql, a, [call], { at: written, clock: () => new Date('2026-11-20T11:00:05Z') })
    const [r] = await allReminders(sql)
    expect(r?.due).toEqual(new Date('2026-11-21T11:00:00Z')) // tomorrow 08:00, not the 08:00 that has just gone by
  })

  it('a reminder redelivered late counts from the clock, not from the message time', async () => {
    const a = await newAccount(sql)
    const written = new Date('2026-11-20T14:00:00Z')
    const clock = new Date('2026-11-20T15:00:00Z') // an hour late
    const call = guarded({ what: 'llamar', first: { in: { n: 30, unit: 'minutes' } } }, clock)
    await turn(sql, a, [call], { at: written, clock: () => clock })
    const [r] = await allReminders(sql)
    expect(r?.due).toEqual(new Date('2026-11-20T15:30:00Z'))
  })

  it('says past when the approved schedule has gone by before the commit point', async () => {
    const a = await newAccount(sql)
    const call = guarded({ what: 'x', first: { in: { n: 1, unit: 'minutes' } } }, NOW)
    const t = await turn(sql, a, [call], { at: NOW, clock: () => minutes(5) })
    expect(t.done[0]?.outcome).toMatchObject({ tool: 'set_reminder', status: 'past' })
    expect(await allReminders(sql)).toEqual([])
  })

  it('a reminder never moves the ledger or the facts', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remind('x'), log(cafe())])
    expect(await liveMovements(sql)).toHaveLength(1)
    expect(await allFacts(sql)).toEqual([])
  })
})
