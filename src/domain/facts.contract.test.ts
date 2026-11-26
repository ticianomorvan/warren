import { describe, expect, it } from 'vitest'
import { NOW, newAccount, remember, turn } from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { schemaDir } from '../core/db'
import { endFact, findLive } from './facts'

useDatabase({ migrations: schemaDir })

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
