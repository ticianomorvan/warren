import { describe, expect, it } from 'vitest'
import {
  allFacts,
  allMovements,
  cafe,
  correct,
  forget,
  hours,
  liveFactList,
  liveMovements,
  log,
  minutes,
  newAccount,
  remember,
  remove,
  turn,
  undo,
} from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import type { Outcome } from './apply'
import { schemaDir } from './db'
import { describe as say } from './describe'

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
    expect(t2.record).toBe('↩︎ Deshice: Café $3.500 · Super $12.000')
    expect(await liveMovements(sql)).toEqual([])
    expect((await allMovements(sql)).map((m) => [m.made, m.ended])).toEqual([
      [t1.turn, t2.turn],
      [t1.turn, t2.turn],
    ])
    const [row] = await sql`SELECT undoes::int AS undoes FROM turn WHERE id = ${t2.turn}`
    expect(row).toEqual({ undoes: t1.turn })
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
  it('skips a turn that changed nothing, and one that made and ended the same thing', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [correct(99, { amount: '1' })], { at: minutes(2) }) // gone: it changed nothing
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

  it('is the same from any client: a turn of one agent is undone by another, and the other way round', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())], { client: 'https://claude.ai/a.json' })
    expect(await undoAt(a, minutes(1), { client: 'cli' })).toMatchObject({ status: 'applied' })
    await turn(sql, a, [log(cafe())], { client: 'cli', at: minutes(2) })
    expect(await undoAt(a, minutes(3), { client: 'https://claude.ai/a.json' })).toMatchObject({
      status: 'applied',
    })
  })
})

describe('after an undo', () => {
  it('a later correction finds the restored movement', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe({ description: 'uno' }), cafe({ description: 'dos' }))])
    await turn(sql, a, [remove(1)], { at: minutes(1) })
    await undoAt(a, minutes(2)) // the delete is undone: `uno` is back as the newest version
    expect((await liveMovements(sql)).map((m) => [m.entity, m.description])).toEqual([
      [2, 'dos'],
      [1, 'uno'],
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
    expect(t.done[0]?.line).toMatch(/^Ese movimiento ya fue corregido o borrado/)
  })
})

describe('the time limit', () => {
  it('refuses past 24 hours, says so and touches nothing; still undoes at 23', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const late = await undoAt(a, hours(25))
    expect(late).toMatchObject({ status: 'expired', effect: null })
    expect(say(late, views)).toBe(
      'Lo último que se hizo fue hace más de 24 horas y ya no se deshace solo. Corregí o borrá el movimiento directamente.',
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

describe('what the turn left stands as it left it', () => {
  it('a later turn that was undone does not matter: the earlier one is undone next', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [correct(1, { amount: '9' })], { at: minutes(5) })
    await undoAt(a, minutes(6)) // the correction is undone: its version and the restoring one are settled
    expect(await undoAt(a, minutes(7))).toMatchObject({ status: 'applied' })
  })

  it('asserts it: a write outside commit (a delete no turn made, hidden by a marker) throws and writes nothing', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe(), cafe({ description: 'super', amount: '12000' }))])
    const t2 = await turn(sql, a, [remove(2)], { at: minutes(5) })
    // What no code path does: the turn that deleted it is made to look settled while the movement stays deleted.
    await sql`INSERT INTO turn (account_id, client, calls, undoes) VALUES (${a}, 'cli', '[]', ${t2.turn})`
    const before = await allMovements(sql)
    await expect(undoAt(a, minutes(6))).rejects.toThrow(/not as the turn left it/)
    expect(await allMovements(sql)).toEqual(before)
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

  it('a fact forgotten and said again: the strict stack takes the new one back first, and then the forget', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('cobro', 'el 5')])
    await turn(sql, a, [forget({ key: 'cobro' })], { at: minutes(5) })
    await turn(sql, a, [remember('cobro', 'el 7')], { at: minutes(6) })
    expect(kinds(await undoAt(a, minutes(7)))).toEqual(['fact_removed'])
    expect(kinds(await undoAt(a, minutes(8)))).toEqual(['fact_restored'])
    expect(await liveFactList(sql)).toEqual([{ entity: 1, key: 'cobro', value: 'el 5' }])
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
