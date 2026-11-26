import { describe, expect, it } from 'vitest'
import { cafe, liveMovements, log, newAccount, remove, turn } from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { schemaDir } from '../core/db'
import { type FindFilter, findMovements, newestLiveId } from './movements'

useDatabase({ migrations: schemaDir })

const none: FindFilter = {
  text: null,
  from: null,
  to: null,
  category: null,
  payment: null,
  amount: null,
  limit: 20,
}
const find = (a: number, f: Partial<FindFilter>, o: { beforeEntity?: number } = {}) =>
  findMovements(sql, a, { ...none, ...f }, o)

async function seed() {
  const a = await newAccount(sql)
  await turn(sql, a, [
    log(
      cafe({ description: 'Café con leche', date: '2026-11-01', category: 'restaurantes' }),
      cafe({
        description: 'nafta YPF',
        amount: '20000',
        date: '2026-11-05',
        category: 'combustible',
        payment: 'Crédito Visa',
      }),
      cafe({
        description: 'súper Coto',
        amount: '12000.50',
        date: '2026-11-10',
        category: 'supermercado',
        payment: 'débito',
      }),
      cafe({
        description: 'sueldo',
        direction: 'in',
        amount: '850000',
        date: '2026-11-03',
        category: 'sueldo',
      }),
    ),
  ])
  return a
}

describe('find: the search column, with v1’s ranking (newest first)', () => {
  it('matches every word of the description or the category, ignoring accents and case', async () => {
    const a = await seed()
    expect((await find(a, { text: 'CAFE leche' })).map((m) => m.description)).toEqual([
      'Café con leche',
    ])
    expect((await find(a, { text: 'cafe' })).map((m) => m.description)).toEqual(['Café con leche'])
    expect((await find(a, { text: 'super' })).map((m) => m.description)).toEqual(['súper Coto'])
    // The category counts, with its underscore as a space.
    expect((await find(a, { text: 'otros ingresos' })).length).toBe(0)
    expect((await find(a, { text: 'combustible' })).map((m) => m.description)).toEqual([
      'nafta YPF',
    ])
    // One-letter words are ignored.
    expect(await find(a, { text: 'x' })).toHaveLength(4)
  })

  it('filters by dates, category, amount and payment, and returns newest first', async () => {
    const a = await seed()
    expect((await find(a, { from: '2026-11-04' })).map((m) => m.description)).toEqual([
      'súper Coto',
      'nafta YPF',
    ])
    expect((await find(a, { to: '2026-11-03' })).map((m) => m.description)).toEqual([
      'sueldo',
      'Café con leche',
    ])
    expect((await find(a, { category: 'combustible' })).map((m) => m.id)).toEqual([2])
    expect((await find(a, { amount: '12000.5' })).map((m) => m.description)).toEqual(['súper Coto'])
    expect((await find(a, { payment: 'CREDITO' })).map((m) => m.description)).toEqual(['nafta YPF'])
    expect((await find(a, { payment: 'débito' })).map((m) => m.description)).toEqual(['súper Coto'])
    expect((await find(a, {})).map((m) => m.id)).toEqual([4, 3, 2, 1])
  })

  it('does not treat % or _ as wildcards', async () => {
    const a = await seed()
    expect(await find(a, { text: '%%' })).toHaveLength(0)
    expect(await find(a, { text: 'ca_e' })).toHaveLength(0)
  })

  it('pages by movement and caps by limit', async () => {
    const a = await seed()
    const page = await find(a, { limit: 2 })
    expect(page.map((m) => m.id)).toEqual([4, 3])
    const next = await find(a, { limit: 2 }, { beforeEntity: page.at(-1)?.id as number })
    expect(next.map((m) => m.id)).toEqual([2, 1])
  })

  it('a movement corrected between two pages is neither skipped nor shown twice', async () => {
    const a = await seed()
    const page = await find(a, { limit: 2 })
    // Movement 2 is corrected after page one was read: its new version has a higher row id than the cursor's.
    await turn(sql, a, [{ tool: 'correct_movement', input: { id: 2, changes: { amount: '1' } } }])
    const next = await find(a, { limit: 2 }, { beforeEntity: page.at(-1)?.id as number })
    expect(next.map((m) => m.id)).toEqual([2, 1])
    expect([...page, ...next].map((m) => m.id)).toEqual([4, 3, 2, 1])
  })

  it('finds only live movements of the account', async () => {
    const a = await seed()
    const b = await newAccount(sql)
    await turn(sql, b, [log(cafe({ description: 'café de b' }))])
    await turn(sql, a, [remove(1)])
    expect((await find(a, { text: 'cafe' })).map((m) => m.description)).toEqual([])
    expect((await find(b, { text: 'cafe' })).map((m) => m.description)).toEqual(['café de b'])
    expect(await liveMovements(sql)).toHaveLength(4)
  })
})

describe('the newest', () => {
  it('a corrected movement counts as new again: its version is the newest row', async () => {
    const a = await seed()
    expect(await newestLiveId(sql, a)).toBe(4)
    await turn(sql, a, [{ tool: 'correct_movement', input: { id: 1, changes: { amount: '1' } } }])
    expect(await newestLiveId(sql, a)).toBe(1)
    await turn(sql, a, [remove(1)])
    expect(await newestLiveId(sql, a)).toBe(4)
    expect(await newestLiveId(sql, await newAccount(sql))).toBeNull()
  })
})
