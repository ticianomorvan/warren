import { describe, expect, it } from 'vitest'
import { cafe, liveMovements, minutes, NOW, newAccount, turn, undo } from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { schemaDir } from '../core/db'
import { accountOfWaId, importMovements, MAX_ROWS } from './import'

useDatabase({ migrations: schemaDir })

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    cafe({ amount: String(1000 + i), date: '2026-03-02', description: `café ${i % 10}` }),
  )
const into = (accountId: number) => ({ sql, accountId })

describe('importMovements', () => {
  it('writes every row as one cli turn', async () => {
    const a = await newAccount(sql)
    const result = await importMovements({ rows: rows(23), now: NOW, into: into(a) })
    expect(result).toMatchObject({ status: 'imported', movements: 23 })
    expect(await liveMovements(sql)).toHaveLength(23)
    const turns = await sql`SELECT channel, label, jsonb_array_length(calls) AS calls FROM turn`
    expect(turns).toEqual([{ channel: 'cli', label: 'import', calls: 3 }])
  })

  it('only checks without a target', async () => {
    expect(await importMovements({ rows: rows(12), now: NOW })).toEqual({
      status: 'checked',
      movements: 12,
    })
    expect(await sql`SELECT 1 FROM turn`).toHaveLength(0)
  })

  it('writes nothing when one row is refused, and says which', async () => {
    const a = await newAccount(sql)
    const bad = [...rows(12), cafe({ date: '2026-12-01' })]
    const result = await importMovements({ rows: bad, now: NOW, into: into(a) })
    expect(result.status).toBe('refused')
    if (result.status === 'refused') expect(result.problems.map((p) => p.rows)).toEqual([[11, 13]])
    expect(await liveMovements(sql)).toHaveLength(0)
    expect(await sql`SELECT 1 FROM turn`).toHaveLength(0)
  })

  it(`refuses more than ${MAX_ROWS} rows`, async () => {
    const result = await importMovements({ rows: rows(MAX_ROWS + 1), now: NOW })
    expect(result.status).toBe('refused')
  })

  it('is one step of the undo stack: one "deshacer" takes it all back', async () => {
    const a = await newAccount(sql)
    await importMovements({ rows: rows(15), now: NOW, into: into(a) })
    await turn(sql, a, [undo], { at: minutes(5) })
    expect(await liveMovements(sql)).toHaveLength(0)
  })

  it('does not import the same rows twice, unless the first import was undone', async () => {
    const a = await newAccount(sql)
    const first = await importMovements({ rows: rows(15), now: NOW, into: into(a) })
    const again = await importMovements({ rows: rows(15), now: minutes(1), into: into(a) })
    expect(again).toEqual({
      status: 'already',
      turn: first.status === 'imported' ? first.turn : -1,
    })
    expect(await liveMovements(sql)).toHaveLength(15)

    // Other rows, or another person, are another import.
    expect((await importMovements({ rows: rows(3), now: minutes(2), into: into(a) })).status).toBe(
      'imported',
    )
    const b = await newAccount(sql)
    expect((await importMovements({ rows: rows(15), now: minutes(3), into: into(b) })).status).toBe(
      'imported',
    )

    await turn(sql, a, [undo], { at: minutes(4) })
    await turn(sql, a, [undo], { at: minutes(5) })
    expect((await importMovements({ rows: rows(15), now: minutes(6), into: into(a) })).status).toBe(
      'imported',
    )
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
