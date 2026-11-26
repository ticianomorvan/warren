import { describe, expect, it } from 'vitest'
import { NOW, newAccount, remember, turn } from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { schemaDir } from '../core/db'
import { CONTEXT_FACTS, endFact, findLive, liveFacts, MAX_MATCHED_FACTS } from './facts'

useDatabase({ migrations: schemaDir })

async function seed(a: number, n: number, word: string) {
  for (let i = 0; i < n; i += 25) {
    await turn(
      sql,
      a,
      Array.from({ length: Math.min(25, n - i) }, (_, k) => remember(`${word} ${i + k + 1}`, 'x')),
    )
  }
}

describe('the facts the model is shown', () => {
  it('shows the newest 30 and says how many there are in all', async () => {
    const a = await newAccount(sql)
    await seed(a, 35, 'cosa')
    const { facts, total } = await liveFacts(sql, a)
    expect(facts).toHaveLength(CONTEXT_FACTS)
    expect(total).toBe(35)
    expect(facts[0]?.key).toBe('cosa 35')
  })

  it('an old fact whose key the message says is shown with the newest ones, by its entity id', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('la del brasil', 'la visa', 'alias')])
    await seed(a, 35, 'cosa')
    expect((await liveFacts(sql, a, 'café 3000')).facts.map((f) => f.key)).not.toContain(
      'la del brasil',
    )
    const named = await liveFacts(sql, a, 'café 3000 con la del brasil')
    expect(named.facts).toHaveLength(31)
    expect(named.facts.find((f) => f.key === 'la del brasil')?.id).toBe(1)
  })

  it('at most 20 of them, never twice, and never another person’s', async () => {
    const a = await newAccount(sql)
    const b = await newAccount(sql)
    await seed(a, 30, 'viejo')
    await seed(a, 30, 'cosa')
    await turn(sql, b, [remember('viejo 1', 'de b')])
    const message = `${Array.from({ length: 30 }, (_, k) => `viejo ${k + 1}`).join(' ')} cosa 60`
    const { facts } = await liveFacts(sql, a, message)
    expect(facts.filter((f) => f.key.startsWith('cosa'))).toHaveLength(30)
    expect(facts.filter((f) => f.key.startsWith('viejo'))).toHaveLength(MAX_MATCHED_FACTS)
    expect(new Set(facts.map((f) => f.version)).size).toBe(facts.length)
    expect(facts.every((f) => f.value === 'x')).toBe(true)
  })
})

describe('the lookups of a live fact only find live facts', () => {
  it('an ended or replaced fact is not found, not ended again and not replaced', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [remember('uno', 'x'), remember('dos', 'x')])
    const t2 = await turn(sql, a, [remember('dos', 'y')])
    await sql.begin(async (tx) => {
      const t = tx as never
      const [one] = await findLive(t, a, { id: 1 })
      expect(await endFact(t, one?.version as number, t2.turn)).toBe(true)
      // Already ended: nothing is written and the caller is told.
      expect(await endFact(t, one?.version as number, t2.turn)).toBe(false)
      expect(await findLive(t, a, { id: 1 })).toEqual([])
      // The replaced version of `dos` is not live; the live one is its next version, found by the same entity id.
      expect((await findLive(t, a, { id: 2 })).map((f) => f.value)).toEqual(['y'])
      expect(await findLive(t, a, { key: 'dos' })).toHaveLength(1)
    })
    expect(NOW).toBeInstanceOf(Date)
  })
})
