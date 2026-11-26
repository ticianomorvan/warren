import { describe, expect, it } from 'vitest'
import { cafe, liveMovements, minutes, NOW, newAccount, turn, undo } from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { schemaDir } from '../core/db'
import { accountOfEmail, importMovements, MAX_ROWS } from './import'
import { MAX_LIVE_MOVEMENTS } from './movements'

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
    const turns = await sql`SELECT client, jsonb_array_length(calls) AS calls FROM turn`
    expect(turns).toEqual([{ client: 'cli', calls: 3 }])
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

  it('is one step of the undo stack: one undo takes it all back', async () => {
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

describe('the account cap', () => {
  it('refuses an import that would take the account past the live-movement limit, and writes nothing', async () => {
    const a = await newAccount(sql)
    // Fills the account up to the cap in one statement: a real log of 100k rows would only slow the test.
    await sql`INSERT INTO turn (id, account_id, client) VALUES (1000, ${a}, 'test')`
    await sql`
      INSERT INTO movement (account_id, made_in, direction, amount, currency, occurred_on, description, category, confidence)
      SELECT ${a}, 1000, 'out', 1, 'ARS', '2026-11-20', 'x', 'otros', 'high' FROM generate_series(1, ${MAX_LIVE_MOVEMENTS - 5})`
    const result = await importMovements({ rows: rows(6), now: NOW, into: into(a) })
    expect(result).toEqual({ status: 'full', live: MAX_LIVE_MOVEMENTS - 5 })
    expect(await sql`SELECT 1 FROM turn WHERE id <> 1000`).toHaveLength(0)
    expect((await importMovements({ rows: rows(5), now: NOW, into: into(a) })).status).toBe(
      'imported',
    )
  })
})

describe('accountOfEmail', () => {
  it('finds the account of the Google email a person signed in with, ignoring case', async () => {
    const a = await newAccount(sql)
    await sql`INSERT INTO auth_user (name, email, "emailVerified", warren_account_id)
      VALUES ('Ana', 'Ana@Example.test', true, ${a})`
    expect(await accountOfEmail(sql, ' ana@example.test ')).toBe(a)
    expect(await accountOfEmail(sql, 'otra@example.test')).toBeNull()
  })
})
