import { describe, expect, it } from 'vitest'
import {
  allFacts,
  allMovements,
  cafe,
  correct,
  forget,
  liveFactList,
  liveMovements,
  log,
  minutes,
  NOW,
  newAccount,
  remember,
  remove,
  turn,
} from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { MAX_FACTS } from '../domain/facts'
import type { Outcome } from './apply'
import { schemaDir } from './db'

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

  it('a fact never moves the ledger', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    await turn(sql, a, [remember('cobro', 'el 5')])
    await turn(sql, a, [forget({ key: 'cobro' })])
    expect(await liveMovements(sql)).toHaveLength(1)
    expect(await allMovements(sql)).toHaveLength(1)
  })
})
