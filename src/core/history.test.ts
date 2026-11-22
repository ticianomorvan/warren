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
  hours,
  liveFactList,
  liveMovements,
  liveReminderList,
  log,
  minutes,
  newAccount,
  remember,
  remind,
  remove,
  turn,
  undo,
} from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { MAX_FACTS } from '../domain/facts'
import { recentMovements } from '../domain/movements'
import { MAX_REMINDERS } from '../domain/reminders/guard'
import type { Outcome } from './apply'
import { schemaDir } from './db'
import { describe as say } from './describe'
import { undoDetail } from './history'

useDatabase({ migrations: schemaDir })

type Undo = Extract<Outcome, { tool: 'undo_last' }>
/** Commits an undo `at` and returns its outcome. */
async function undoAt(a: number, at: Date, o: Parameters<typeof turn>[3] = {}): Promise<Undo> {
  const t = await turn(sql, a, [undo], { ...o, at })
  return t.done[0]?.outcome as Undo
}
const kinds = (u: Undo) => (u.status === 'applied' ? u.items.map((i) => i.kind) : u.status)
const views = { today: '2026-11-20', newest: null }

describe('undo of a log', () => {
  it('ends what the turn made, in the undo’s own turn, and marks the turn undone', async () => {
    const a = await newAccount(sql)
    const t1 = await turn(sql, a, [log(cafe(), cafe({ description: 'super', amount: '12000' }))])
    const t2 = await turn(sql, a, [undo], { at: minutes(5) })
    expect(t2.done[0]?.outcome).toMatchObject({
      status: 'applied',
      effect: 'undone',
      turn: t1.turn,
    })
    expect(kinds(t2.done[0]?.outcome as Undo)).toEqual(['logged', 'logged'])
    expect(t2.reply).toBe('↩︎ Deshice: Café $3.500 · Super $12.000')
    expect(await liveMovements(sql)).toEqual([])
    expect((await allMovements(sql)).map((m) => [m.made, m.ended])).toEqual([
      [t1.turn, t2.turn],
      [t1.turn, t2.turn],
    ])
    const [row] = await sql`SELECT undoes::int AS undoes, label FROM turn WHERE id = ${t2.turn}`
    expect(row).toEqual({ undoes: t1.turn, label: 'undo' })
  })
})

describe('undo of a correction', () => {
  it('brings the old values back as the next version of the same entity and keeps the whole chain', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [correct(1, { amount: '3800', payment: 'efectivo' })], { at: minutes(5) })
    const u = await undoAt(a, minutes(10))
    expect(kinds(u)).toEqual(['corrected'])
    expect((await allMovements(sql)).map((m) => [m.entity, m.amount])).toEqual([
      [1, '3500'],
      [1, '3800'],
      [1, '3500'],
    ])
    expect(await liveMovements(sql)).toEqual([{ entity: 1, amount: '3500', description: 'café' }])
    expect(say(u, views)).toBe('↩︎ Deshice:\n• Café $3.500 (estaba $3.800, efectivo)')
  })
})

describe('undo of two corrections of one movement in one turn', () => {
  it('is one step back to what it was before the turn, however many versions the turn made', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(
      sql,
      a,
      [
        correct(1, { amount: '3600' }),
        correct(1, { amount: '3700' }),
        correct(1, { amount: '3800' }),
      ],
      { at: minutes(5) },
    )
    const u = await undoAt(a, minutes(6))
    expect(kinds(u)).toEqual(['corrected'])
    expect(await liveMovements(sql)).toEqual([{ entity: 1, amount: '3500', description: 'café' }])
    expect(await undoAt(a, minutes(7))).toMatchObject({ status: 'applied' })
    expect(await liveMovements(sql)).toEqual([])
  })
})

describe('undo of a delete', () => {
  it('brings the movement back as a new version of the same entity; the deleted one stays ended', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [remove(1)], { at: minutes(5) })
    const u = await undoAt(a, minutes(10))
    expect(kinds(u)).toEqual(['deleted'])
    expect(await liveMovements(sql)).toEqual([{ entity: 1, amount: '3500', description: 'café' }])
    expect((await allMovements(sql)).map((m) => m.ended !== null)).toEqual([true, false])
    expect(say(u, views)).toBe('↩︎ Deshice:\n• Volvió Café $3.500')
  })
})

describe('undo of a mixed turn', () => {
  it('reverts a log, a correction and a delete of one message together', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe({ description: 'a' }), cafe({ description: 'b', amount: '200' }))])
    const t = await turn(
      sql,
      a,
      [log(cafe({ description: 'c', amount: '300' })), correct(1, { amount: '111' }), remove(2)],
      { at: minutes(5) },
    )
    expect(t.done.every((d) => d.outcome?.status === 'applied')).toBe(true)
    const u = await undoAt(a, minutes(10))
    expect(kinds(u)).toEqual(['logged', 'corrected', 'deleted'])
    expect((await liveMovements(sql)).map((m) => [m.description, m.amount])).toEqual([
      ['a', '3500'],
      ['b', '200'],
    ])
  })
})

describe('a second undo', () => {
  it('undoes the turn before, never redoes, and says there is nothing when it runs out', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe({ description: 'primero' }))])
    await turn(sql, a, [log(cafe({ description: 'segundo' }))], { at: minutes(5) })
    expect(await liveMovements(sql)).toHaveLength(2)
    await undoAt(a, minutes(10))
    expect((await liveMovements(sql)).map((m) => m.description)).toEqual(['primero'])
    await undoAt(a, minutes(11))
    expect(await liveMovements(sql)).toEqual([])
    expect(await undoAt(a, minutes(12))).toMatchObject({ status: 'nothing', effect: null })
    expect(say(await undoAt(a, minutes(13)), views)).toBe('No tengo nada para deshacer.')
  })

  it('does not undo an undo: a log after it is what the next one takes back', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe({ description: 'uno' }))])
    await undoAt(a, minutes(5))
    await turn(sql, a, [log(cafe({ description: 'dos' }))], { at: minutes(6) })
    await undoAt(a, minutes(7))
    expect(await liveMovements(sql)).toEqual([])
    expect(await undoAt(a, minutes(8))).toMatchObject({ status: 'nothing' })
  })

  it('walks back through the undo of a delete to the log behind it', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [remove(1)], { at: minutes(5) })
    await undoAt(a, minutes(10)) // the delete is undone
    expect(await liveMovements(sql)).toHaveLength(1)
    const u = await undoAt(a, minutes(11)) // now the log
    expect(kinds(u)).toEqual(['logged'])
    expect(await liveMovements(sql)).toEqual([])
  })

  it('a correction undone, then the log behind it: the entity is as the log left it', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [correct(1, { amount: '9' })], { at: minutes(5) })
    await undoAt(a, minutes(6))
    expect(kinds(await undoAt(a, minutes(7)))).toEqual(['logged'])
    expect(await liveMovements(sql)).toEqual([])
  })
})

describe('what the undo reaches: the newest turn, in commit order', () => {
  it('skips a turn that only read or answered, and one that made and ended the same thing', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [{ tool: 'list_facts', input: {} }], { at: minutes(2) })
    await turn(sql, a, [remember('cobro', 'el 5'), forget({ key: 'cobro' })], { at: minutes(3) })
    expect(await undoAt(a, minutes(4))).toMatchObject({ status: 'applied' })
    expect(await liveMovements(sql)).toEqual([])
  })

  it('goes by turn id, not by the time on the turn: the later commit is the newer', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe({ description: 'commit 1, message time late' }))], {
      at: minutes(30),
    })
    await turn(sql, a, [log(cafe({ description: 'commit 2, message time early' }))], {
      at: minutes(10),
    })
    await undoAt(a, minutes(31))
    expect((await liveMovements(sql)).map((m) => m.description)).toEqual([
      'commit 1, message time late',
    ])
  })

  it('never reaches another account’s turn, and does not use it up', async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    await turn(sql, a, [log(cafe({ description: 'de a' }))])
    await turn(sql, b, [log(cafe({ description: 'de b' }))], { at: minutes(1) })
    expect(await undoAt(b, minutes(2))).toMatchObject({ status: 'applied' })
    expect(await undoAt(b, minutes(3))).toMatchObject({ status: 'nothing' })
    expect((await liveMovements(sql)).map((m) => m.description)).toEqual(['de a'])
    expect(await undoAt(a, minutes(4))).toMatchObject({ status: 'applied' })
  })

  it('is the same from any channel: an MCP turn is undone by WhatsApp and the other way round', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())], { channel: 'mcp' })
    expect(await undoAt(a, minutes(1))).toMatchObject({ status: 'applied' })
    await turn(sql, a, [log(cafe())], { channel: 'whatsapp', at: minutes(2) })
    expect(await undoAt(a, minutes(3), { channel: 'mcp' })).toMatchObject({ status: 'applied' })
  })
})

describe('after an undo', () => {
  it('the recent list is the live movements, newest first, and a later correction finds the restored one', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe({ description: 'uno' }), cafe({ description: 'dos' }))])
    await turn(sql, a, [remove(1)], { at: minutes(1) })
    await undoAt(a, minutes(2)) // the delete is undone: `uno` is back as the newest version
    expect((await recentMovements(sql, a)).map((m) => [m.id, m.description])).toEqual([
      [1, 'uno'],
      [2, 'dos'],
    ])
    const t = await turn(sql, a, [correct(1, { amount: '999' })], { at: minutes(3) })
    expect(t.done[0]?.outcome).toMatchObject({ status: 'applied', next: { id: 1, amount: '999' } })
  })

  it('an undo and a correction one after the other: the undo first, so the correction finds the movement gone', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await undoAt(a, minutes(1))
    const t = await turn(sql, a, [correct(1, { amount: '999' })], { at: minutes(2) })
    expect(t.done[0]?.outcome).toMatchObject({ status: 'gone', id: 1 })
    expect(t.reply).toMatch(/^Ese movimiento ya fue corregido o borrado/)
  })

  it('what is kept: the undo’s turn says which turn it undid, the audit says what became of each entity', async () => {
    const a = await newAccount(sql)
    const t1 = await turn(sql, a, [log(cafe())])
    const u = await undoAt(a, minutes(1))
    expect(undoDetail(u)).toBe(`undid turn ${t1.turn}: logged 1`)
  })
})

describe('the time limit', () => {
  it('refuses past 24 hours, says so and touches nothing; still undoes at 23', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const late = await undoAt(a, hours(25))
    expect(late).toMatchObject({ status: 'expired', effect: null })
    expect(say(late, views)).toBe(
      'Lo último que hice fue hace más de 24 horas y ya no lo deshago solo. Decime qué querés corregir o borrar.',
    )
    expect(await liveMovements(sql)).toHaveLength(1)
    expect(await undoAt(a, hours(23))).toMatchObject({ status: 'applied' })
  })

  it('does not reach past an expired turn for an older one', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe({ description: 'viejo' }))])
    await turn(sql, a, [log(cafe({ description: 'nuevo' }))], { at: hours(20) })
    expect(await undoAt(a, hours(45))).toMatchObject({ status: 'expired' })
    expect(await liveMovements(sql)).toHaveLength(2)
  })
})

describe('the staleness check: all or nothing', () => {
  /** A turn that `lastTurn` no longer sees (an undo marker points at it) though nothing brought back what it did. */
  const hide = (a: number, turnId: number) =>
    sql`INSERT INTO turn (account_id, channel, label, calls, reply, undoes) VALUES (${a}, 'cli', 'marker', '[]', 'x', ${turnId})`

  it('refuses a turn whose movement something else deleted: stale, naming it, writing nothing', async () => {
    const a = await newAccount(sql)
    const t1 = await turn(sql, a, [log(cafe(), cafe({ description: 'super', amount: '12000' }))])
    const t2 = await turn(sql, a, [remove(2)], { at: minutes(5) })
    await hide(a, t2.turn)
    const before = await allMovements(sql)
    const u = await undoAt(a, minutes(6))
    expect(u).toMatchObject({ status: 'stale', turn: t1.turn, effect: null })
    if (u.status === 'stale') expect(u.moved.movements.map((m) => m.id)).toEqual([2])
    expect(say(u, views)).toBe(
      'No deshice nada: Súper $12.000 cambió después. Decime qué querés cambiar.'.replace(
        'Súper',
        'Super',
      ),
    )
    expect(await allMovements(sql)).toEqual(before)
    expect(await liveMovements(sql)).toEqual([{ entity: 1, amount: '3500', description: 'café' }])
  })

  it('is all or nothing: one moved movement stops the whole turn, and every one that moved is named', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [
      log(cafe(), cafe({ description: 'super', amount: '12000' }), cafe({ description: 'nafta' })),
    ])
    const t2 = await turn(sql, a, [remove(1), remove(2)], { at: minutes(5) })
    await hide(a, t2.turn)
    const u = await undoAt(a, minutes(6))
    expect(u).toMatchObject({ status: 'stale' })
    if (u.status === 'stale') expect(u.moved.movements.map((m) => m.id)).toEqual([1, 2])
    expect(await liveMovements(sql)).toHaveLength(1)
  })

  it('a later turn that was undone does not make the earlier one stale', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [correct(1, { amount: '9' })], { at: minutes(5) })
    await undoAt(a, minutes(6)) // the correction is undone: its version and the restoring one are settled
    expect(await undoAt(a, minutes(7))).toMatchObject({ status: 'applied' })
  })

  it('a refusal is audited with its reason', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const t2 = await turn(sql, a, [remove(1)], { at: minutes(5) })
    await hide(a, t2.turn)
    expect(undoDetail(await undoAt(a, minutes(6)))).toBe('stale: 1')
  })
})

describe('the strict stack', () => {
  it('a change that can never be undone blocks the older ones: it is named, nothing is touched, and fixing the older change directly works', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [remind('pagar la Visa', { day: 'tomorrow', time: '10:00' })], {
      at: minutes(5),
    })
    // The sweep sent the one-off.
    await sql`UPDATE reminder SET next_due_at = NULL WHERE entity_id = 1`
    const u = await undoAt(a, minutes(10))
    expect(u).toMatchObject({ status: 'blocked', effect: null, why: ['sent'] })
    if (u.status === 'blocked')
      expect(u.blocking.reminders.map((r) => r.what)).toEqual(['pagar la Visa'])
    expect(say(u, views)).toMatch(
      /^No deshice nada: ⏰ pagar la Visa ya se mandó y no se puede deshacer, así que tampoco lo anterior\. Si querés cambiar algo más viejo, decime qué, por ejemplo "corregí el café"\.$/,
    )
    expect(undoDetail(u)).toBe('blocked (sent): pagar la Visa'.replace('pagar la Visa', '1'))
    expect(await liveMovements(sql)).toHaveLength(1)
    // The older thing is fixed directly; that turn is the newest and can be undone.
    await turn(sql, a, [correct(1, { amount: '4000' })], { at: minutes(11) })
    expect(await undoAt(a, minutes(12))).toMatchObject({ status: 'applied' })
    expect(await liveMovements(sql)).toEqual([{ entity: 1, amount: '3500', description: 'café' }])
  })

  it('restricts by store: a channel that may not undo reminders is told so, and nothing is touched', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe()), remind('pagar la Visa')])
    const u = await undoAt(a, minutes(5), { channel: 'mcp', stores: ['movement', 'fact'] })
    expect(u).toMatchObject({ status: 'restricted', effect: null })
    expect(say(u, views)).toBe('No tengo nada para deshacer.')
    expect(await liveMovements(sql)).toHaveLength(1)
    expect(await liveReminderList(sql)).toHaveLength(1)
    // With every store (MCP has reminder tools now), the same undo takes both.
    expect(kinds(await undoAt(a, minutes(6), { channel: 'mcp' }))).toEqual([
      'logged',
      'reminder_removed',
    ])
  })
})

describe('undo of a fact', () => {
  it('undoes a remember: the fact is forgotten by the undo, the row kept', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5')])
    const u = await undoAt(a, minutes(5))
    expect(kinds(u)).toEqual(['fact_removed'])
    expect(await liveFactList(sql)).toEqual([])
    expect(await allFacts(sql)).toHaveLength(1)
    expect(say(u, views)).toBe('↩︎ Deshice:\n• Olvidé 🧠 cobro: el 5')
  })

  it('undoes an update by putting the old value back as the next version, then a second undo removes it', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('la visa', 'galicia', 'alias')])
    await turn(sql, a, [remember('la visa', 'santander', 'alias')], { at: minutes(5) })
    const u = await undoAt(a, minutes(6))
    expect(kinds(u)).toEqual(['fact_reverted'])
    expect((await liveFactList(sql))[0]).toMatchObject({ entity: 1, value: 'galicia' })
    expect(say(u, views)).toBe('↩︎ Deshice:\n• 🧠 la visa = galicia (estaba santander)')
    expect(kinds(await undoAt(a, minutes(7)))).toEqual(['fact_removed'])
    expect(await liveFactList(sql)).toEqual([])
  })

  it('undoes a forget: the fact comes back as the next version of the same entity', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5')])
    await turn(sql, a, [forget({ key: 'cobro' })], { at: minutes(5) })
    const u = await undoAt(a, minutes(6))
    expect(kinds(u)).toEqual(['fact_restored'])
    expect(await liveFactList(sql)).toEqual([{ entity: 1, key: 'cobro', value: 'el 5' }])
    expect(say(u, views)).toBe('↩︎ Deshice:\n• Volvió 🧠 cobro: el 5')
  })

  it('undoes forgetting everything, all of it', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5'), remember('luz', 'el 12')])
    await turn(sql, a, [forgetAll], { at: minutes(5) })
    expect(await liveFactList(sql)).toEqual([])
    expect(kinds(await undoAt(a, minutes(6)))).toEqual(['fact_restored', 'fact_restored'])
    expect((await liveFactList(sql)).map((f) => f.key)).toEqual(['cobro', 'luz'])
  })

  it('undoes a log and a remember of the same message together', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe()), remember('cobro', 'el 5')])
    expect(kinds(await undoAt(a, minutes(5)))).toEqual(['logged', 'fact_removed'])
    expect(await liveMovements(sql)).toEqual([])
    expect(await liveFactList(sql)).toEqual([])
  })

  it('a fact stored and forgotten by the same message is a net of nothing, and the turn before it can still be undone', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [remember('cobro', 'el 5'), forget({ key: 'cobro' })], { at: minutes(5) })
    expect(kinds(await undoAt(a, minutes(6)))).toEqual(['logged'])
  })

  it('"la visa es la del santander, olvidate de eso" after galicia: the undo brings galicia back, as before the turn', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('la visa', 'galicia', 'alias')])
    await turn(sql, a, [remember('la visa', 'santander', 'alias'), forget({ key: 'la visa' })], {
      at: minutes(5),
    })
    expect(await liveFactList(sql)).toEqual([])
    expect(kinds(await undoAt(a, minutes(6)))).toEqual(['fact_restored'])
    expect(await liveFactList(sql)).toEqual([{ entity: 1, key: 'la visa', value: 'galicia' }])
  })

  it('does not restore a forgotten fact over one the person said again since: stale, writing nothing', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5')])
    const t2 = await turn(sql, a, [forget({ key: 'cobro' })], { at: minutes(5) })
    await turn(sql, a, [remember('cobro', 'el 7')], { at: minutes(6) })
    // The newest turn is the new remember: undoing it first is what the strict stack does, and then the forget comes back.
    expect(kinds(await undoAt(a, minutes(7)))).toEqual(['fact_removed'])
    expect(kinds(await undoAt(a, minutes(8)))).toEqual(['fact_restored'])
    expect(t2.turn).toBeGreaterThan(0)
    // With the new fact standing and the forget turn the last that counts, it is refused.
    await turn(sql, a, [forget({ key: 'cobro' })], { at: minutes(9) })
    const t5 = await turn(sql, a, [remember('cobro', 'el 9')], { at: minutes(10) })
    await sql`INSERT INTO turn (account_id, channel, label, calls, reply, undoes) VALUES (${a}, 'cli', 'marker', '[]', 'x', ${t5.turn})`
    const before = await allFacts(sql)
    const u = await undoAt(a, minutes(11))
    expect(u).toMatchObject({ status: 'stale' })
    if (u.status === 'stale') expect(u.moved.facts.map((f) => f.key)).toEqual(['cobro'])
    expect(await allFacts(sql)).toEqual(before)
  })

  it('the cap applies when facts come back: nothing is restored over MAX_FACTS (blocked)', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('primero', 'x'), remember('segundo', 'x')])
    await turn(sql, a, [forgetAll], { at: minutes(5) })
    const fill = Array.from({ length: MAX_FACTS }, (_, i) => remember(`dato ${i}`, 'x'))
    for (let i = 0; i < fill.length; i += 25)
      await turn(sql, a, fill.slice(i, i + 25), { at: minutes(6) })
    // Hide the fill turns, so the forget-everything turn is the last that counts.
    const fills = await sql<{ id: number }[]>`SELECT id::int FROM turn WHERE id > 2 ORDER BY id`
    for (const f of fills) {
      await sql`INSERT INTO turn (account_id, channel, label, calls, reply, undoes) VALUES (${a}, 'cli', 'marker', '[]', 'x', ${f.id})`
    }
    const u = await undoAt(a, minutes(20))
    expect(u).toMatchObject({ status: 'blocked', why: ['cap'] })
    if (u.status === 'blocked')
      expect(u.blocking.facts.map((f) => f.key)).toEqual(['primero', 'segundo'])
    expect(await liveFactList(sql)).toHaveLength(MAX_FACTS)
  })

  it('one person’s undo never touches another’s facts', async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5')])
    await turn(sql, b, [remember('cobro', 'el 10')], { at: minutes(1) })
    await undoAt(a, minutes(2))
    expect(await liveFactList(sql)).toEqual([{ entity: 2, key: 'cobro', value: 'el 10' }])
  })
})

describe('undo of a reminder', () => {
  it('"deshacer" right after setting one cancels it', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remind('pagar la Visa')])
    const u = await undoAt(a, minutes(5))
    expect(kinds(u)).toEqual(['reminder_removed'])
    expect(await liveReminderList(sql)).toEqual([])
    expect(say(u, views)).toBe('↩︎ Deshice:\n• Quité ⏰ pagar la Visa')
  })

  it('after cancelling one brings it back as the next version, its next date worked out from now', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remind('pagar la Visa', { month_day: 10 }, { every: 'month' })])
    await turn(sql, a, [cancel(1)], { at: minutes(5) })
    const u = await undoAt(a, hours(24 * 20))
    // 24 hours have passed: the window is over for the cancel, so it is refused. Within the window it comes back.
    expect(u).toMatchObject({ status: 'expired' })
    const back = await undoAt(a, minutes(10))
    expect(kinds(back)).toEqual(['reminder_restored'])
    const live = await allReminders(sql)
    expect(live.at(-1)).toMatchObject({ entity: 1, ended: null })
    expect(live.at(-1)?.due).toEqual(new Date('2026-12-10T12:00:00Z'))
  })

  it('a set that a later cancel removed and "deshacer" restored can still be undone as the set', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remind('pagar la Visa')])
    await turn(sql, a, [cancel(1)], { at: minutes(5) })
    await undoAt(a, minutes(6)) // the cancel is undone
    expect(kinds(await undoAt(a, minutes(7)))).toEqual(['reminder_removed'])
    expect(await liveReminderList(sql)).toEqual([])
  })

  it('cancelling several in one message is one turn: "deshacer" brings them all back', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remind('uno'), remind('dos'), remind('tres')])
    await turn(sql, a, [cancel(1), cancel(2), cancel(3)], { at: minutes(5) })
    expect(await liveReminderList(sql)).toEqual([])
    expect(kinds(await undoAt(a, minutes(6)))).toEqual([
      'reminder_restored',
      'reminder_restored',
      'reminder_restored',
    ])
    expect((await liveReminderList(sql)).map((r) => r.what)).toEqual(['uno', 'dos', 'tres'])
  })

  it('refuses to bring back a one-off whose time has passed, naming it, and changes nothing', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remind('llamar', { in: { n: 30, unit: 'minutes' } })])
    await turn(sql, a, [cancel(1)], { at: minutes(5) })
    const u = await undoAt(a, minutes(45))
    expect(u).toMatchObject({ status: 'blocked', why: ['past'] })
    expect(await liveReminderList(sql)).toEqual([])
  })

  it('does not exceed the cap when it brings them back (blocked)', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remind('uno'), remind('dos')])
    await turn(sql, a, [cancel(1), cancel(2)], { at: minutes(5) })
    for (let i = 0; i < MAX_REMINDERS; i++)
      await turn(sql, a, [remind(`n${i}`)], { at: minutes(6 + i) })
    // The newest turns are the new reminders: make the cancel turn the last that counts.
    const marker = await sql<{ id: number }[]>`SELECT id::int FROM turn WHERE id > 2 ORDER BY id`
    for (const m of marker)
      await sql`INSERT INTO turn (account_id, channel, label, calls, reply, undoes) VALUES (${a}, 'cli', 'marker', '[]', 'x', ${m.id})`
    const u = await undoAt(a, minutes(40))
    expect(u).toMatchObject({ status: 'blocked', why: ['cap'] })
    expect(await liveReminderList(sql)).toHaveLength(MAX_REMINDERS)
  })

  it('a stored reminder whose schedule no longer parses does not break an undo of the turn it sits in', async () => {
    const a = await newAccount(sql)
    const t = await turn(sql, a, [log(cafe())])
    await sql`INSERT INTO reminder (account_id, made_in, what, schedule, next_due_at)
      VALUES (${a}, ${t.turn}, 'mala', '{"start":"nope"}'::jsonb, now())`
    const u = await undoAt(a, minutes(5))
    expect(kinds(u)).toEqual(['logged'])
  })

  it('a reminder never moves the ledger when undone', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [remind('x')], { at: minutes(1) })
    await undoAt(a, minutes(2))
    expect(await liveMovements(sql)).toHaveLength(1)
  })
})
