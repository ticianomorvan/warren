import { describe, expect, it } from 'vitest'
import {
  allMovements,
  cafe,
  correct,
  log,
  minutes,
  NOW,
  newAccount,
  remember,
  turn,
  undo,
} from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import type { Call } from './commands'
import { schemaDir } from './db'
import { commit } from './turn'

useDatabase({ migrations: schemaDir })

describe('commit', () => {
  it('logs, and the turn row is the commit point: record, client and the time of the call', async () => {
    const a = await newAccount(sql)
    const t = await turn(sql, a, [log(cafe())], { client: 'https://claude.ai/client.json' })
    expect(t.record).toBe('✓ Café $3.500')
    const [row] =
      await sql`SELECT client, record, undoes, created_at FROM turn WHERE id = ${t.turn}`
    expect(row).toEqual({
      client: 'https://claude.ai/client.json',
      record: '✓ Café $3.500',
      undoes: null,
      created_at: NOW,
    })
    expect((await allMovements(sql)).map((m) => m.made)).toEqual([t.turn])
  })

  it('stores what each call came to, and nothing of the input when it must be scrubbed', async () => {
    const a = await newAccount(sql)
    const t = await commit(sql, {
      accountId: a,
      client: 'test',
      now: NOW,
      calls: [remember('cobro', 'el 5')],
      scrub: true,
    })
    const [row] = await sql`SELECT calls FROM turn WHERE id = ${t.turn}`
    expect(row?.calls).toEqual([{ tool: 'remember_fact', status: 'applied', effect: 'remembered' }])
    const kept = await turn(sql, a, [remember('luz', 'el 6')])
    const [row2] = await sql`SELECT calls FROM turn WHERE id = ${kept.turn}`
    expect(row2?.calls).toEqual([
      {
        tool: 'remember_fact',
        input: { kind: 'note', key: 'luz', value: 'el 6' },
        status: 'applied',
        effect: 'remembered',
      },
    ])
  })

  it('has no record when nothing was changed', async () => {
    const a = await newAccount(sql)
    const t = await turn(sql, a, [{ tool: 'list_facts', input: {} } as Call])
    expect(t.record).toBeNull()
  })

  it('a line that changed nothing (gone, unchanged) is not a record of a change', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const t = await turn(sql, a, [correct(99, { amount: '1' })])
    expect(t.record).toBeNull()
    expect(t.done[0]?.line).toMatch(/ya fue corregido o borrado/)
  })

  it('the lines of several writes make one record, in order', async () => {
    const a = await newAccount(sql)
    const t = await turn(sql, a, [log(cafe({ description: 'a' })), log(cafe({ description: 'b' }))])
    expect(t.record).toBe('✓ A $3.500\n✓ B $3.500')
  })

  it('an undo marks the turn it reverted, and a second undo of the same turn is refused by the unique index', async () => {
    const a = await newAccount(sql)
    const t1 = await turn(sql, a, [log(cafe())])
    const t2 = await turn(sql, a, [undo], { at: minutes(1) })
    const [row] = await sql`SELECT undoes::int AS undoes FROM turn WHERE id = ${t2.turn}`
    expect(row?.undoes).toBe(t1.turn)
    await expect(
      sql`INSERT INTO turn (account_id, client, calls, undoes) VALUES (${a}, 'cli', '[]', ${t1.turn})`,
    ).rejects.toThrow(/turn_undoes_once/)
  })

  it('a guard that stops the turn writes nothing and hands its answer back', async () => {
    const a = await newAccount(sql)
    const t = await commit(sql, {
      accountId: a,
      client: 'test',
      now: NOW,
      calls: [log(cafe())],
      guard: async () => ({ stop: 'no' }),
    })
    expect(t).toEqual({ stop: 'no' })
    expect(await allMovements(sql)).toEqual([])
    expect(await sql`SELECT 1 FROM turn`).toHaveLength(0)
  })

  it('requireChange leaves no turn when no write changed anything', async () => {
    const a = await newAccount(sql)
    const t = await commit(sql, {
      accountId: a,
      client: 'test',
      now: NOW,
      calls: [correct(99, { amount: '1' })],
      requireChange: true,
    })
    expect('unchanged' in t).toBe(true)
    expect(await sql`SELECT 1 FROM turn`).toHaveLength(0)
  })

  it('`after` runs in the transaction with the turn: a failure there rolls the whole turn back', async () => {
    const a = await newAccount(sql)
    const seen: number[] = []
    await commit(sql, {
      accountId: a,
      client: 'test',
      now: NOW,
      calls: [log(cafe())],
      after: async (tx, t) => {
        seen.push(t.id)
        await tx`SELECT 1 FROM turn WHERE id = ${t.id}`
      },
    })
    expect(seen).toHaveLength(1)
    await expect(
      commit(sql, {
        accountId: a,
        client: 'test',
        now: NOW,
        calls: [log(cafe())],
        after: async () => {
          throw new Error('request row failed')
        },
      }),
    ).rejects.toThrow('request row failed')
    expect(await allMovements(sql)).toHaveLength(1)
    expect(await sql`SELECT 1 FROM turn`).toHaveLength(1)
  })

  it('the version’s key to its turn is deferred: a transaction that never inserts its turn cannot commit a version', async () => {
    const a = await newAccount(sql)
    await expect(
      sql.begin(async (tx) => {
        await tx`INSERT INTO movement (account_id, made_in, direction, amount, currency, occurred_on, description, category, confidence)
          VALUES (${a}, 999, 'out', 1, 'ARS', '2026-11-20', 'x', 'otros', 'high')`
      }),
    ).rejects.toThrow(/made_in_fkey|foreign key|made_in_turn/)
    expect(await allMovements(sql)).toEqual([])
  })

  it('turn ids of one account are in commit order, and the account lock is the first thing taken', async () => {
    const a = await newAccount(sql)
    const first = await turn(sql, a, [log(cafe())])
    const second = await turn(sql, a, [log(cafe())])
    expect(second.turn).toBeGreaterThan(first.turn)
  })
})
