import { describe, expect, it } from 'vitest'
import { cafe, liveMovements, minutes, NOW, newAccount, turn, undo } from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { schemaDir } from '../core/db'
import { accountOfWaId, importMovements } from './import'

useDatabase({ migrations: schemaDir })

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    cafe({ amount: String(1000 + i), date: '2026-03-02', description: `café ${i % 10}` }),
  )

describe('importMovements', () => {
  it('writes every row as one cli turn', async () => {
    const a = await newAccount(sql)
    const result = await importMovements(sql, { accountId: a, rows: rows(23), now: NOW })
    expect(result).toMatchObject({ status: 'imported', movements: 23 })
    expect(await liveMovements(sql)).toHaveLength(23)
    const turns = await sql`SELECT channel, label, jsonb_array_length(calls) AS calls FROM turn`
    expect(turns).toEqual([{ channel: 'cli', label: 'import', calls: 3 }])
  })

  it('writes nothing when one row is refused, and says which', async () => {
    const a = await newAccount(sql)
    const bad = [...rows(12), cafe({ date: '2026-12-01' })]
    const result = await importMovements(sql, { accountId: a, rows: bad, now: NOW })
    expect(result.status).toBe('refused')
    if (result.status === 'refused') expect(result.problems.map((p) => p.rows)).toEqual([[11, 13]])
    expect(await liveMovements(sql)).toHaveLength(0)
    expect(await sql`SELECT 1 FROM turn`).toHaveLength(0)
  })

  it('is one step of the undo stack: one "deshacer" takes it all back', async () => {
    const a = await newAccount(sql)
    await importMovements(sql, { accountId: a, rows: rows(15), now: NOW })
    await turn(sql, a, [undo], { at: minutes(5) })
    expect(await liveMovements(sql)).toHaveLength(0)
  })
})

describe('accountOfWaId', () => {
  it('finds the account of a WhatsApp number', async () => {
    const a = await newAccount(sql)
    await sql`INSERT INTO account_address (account_id, channel, address) VALUES (${a}, 'whatsapp', '5493510000000')`
    expect(await accountOfWaId(sql, '5493510000000')).toBe(a)
    expect(await accountOfWaId(sql, '5493519999999')).toBeNull()
  })
})
