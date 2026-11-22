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
  it('logs, and the turn row is the commit point: record, reply, label, channel and the time of the message', async () => {
    const a = await newAccount(sql)
    const t = await turn(sql, a, [log(cafe())], { channel: 'mcp' })
    expect(t.reply).toBe('✓ Café $3.500')
    expect(t.record).toBe('✓ Café $3.500')
    const [row] = await sql`
      SELECT label, channel, record, reply, question, undoes, created_at FROM turn WHERE id = ${t.turn}`
    expect(row).toEqual({
      label: 'log',
      channel: 'mcp',
      record: '✓ Café $3.500',
      reply: '✓ Café $3.500',
      question: null,
      undoes: null,
      created_at: NOW,
    })
    expect((await allMovements(sql)).map((m) => m.made)).toEqual([t.turn])
  })

  it('stores what each call came to, and nothing of the input for a message that must be scrubbed', async () => {
    const a = await newAccount(sql)
    const t = await commit(sql, {
      accountId: a,
      channel: 'whatsapp',
      now: NOW,
      calls: [remember('cobro', 'el 5')],
      scrub: true,
      compose: () => ({ reply: 'x' }),
    })
    const [row] = await sql`SELECT calls FROM turn WHERE id = ${t?.turn ?? 0}`
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

  it('has no record when nothing was changed, and a label for each shape of turn', async () => {
    const a = await newAccount(sql)
    const t = await turn(sql, a, [{ tool: 'list_facts', input: {} } as Call])
    expect(t.record).toBeNull()
    const [row] = await sql`SELECT label, record FROM turn WHERE id = ${t.turn}`
    expect(row).toEqual({ label: 'reply', record: null })
    const m = await turn(sql, a, [log(cafe()), log(cafe())])
    expect((await sql`SELECT label FROM turn WHERE id = ${m.turn}`)[0]?.label).toBe('multi')
  })

  it('a line that changed nothing (gone, unchanged) is rendered but is not a record of a change', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())])
    const t = await turn(sql, a, [correct(99, { amount: '1' })])
    expect(t.reply).toBe(
      'Ese movimiento ya fue corregido o borrado. Fijate cómo quedó y mandame de nuevo qué querés cambiar.',
    )
    expect(t.record).toBeNull()
  })

  it('the lines of the writes go to the composer, in order, and the question it asks is stored', async () => {
    const a = await newAccount(sql)
    const t = await commit(sql, {
      accountId: a,
      channel: 'whatsapp',
      now: NOW,
      calls: [log(cafe({ description: 'a' })), log(cafe({ description: 'b' }))],
      compose: (done, record) => ({
        reply: `${record}!`,
        question: { options: [{ n: 1, id: 1 }], then: { do: 'delete' } },
        ...(done.length === 2 ? {} : { reply: 'wrong' }),
      }),
    })
    expect(t?.reply).toBe('✓ A $3.500\n✓ B $3.500!')
    const [row] = await sql`SELECT question FROM turn WHERE id = ${t?.turn ?? 0}`
    expect(row?.question).toEqual({ options: [{ n: 1, id: 1 }], then: { do: 'delete' } })
  })

  it('an undo marks the turn it reverted, and a second undo of the same turn is refused by the unique index', async () => {
    const a = await newAccount(sql)
    const t1 = await turn(sql, a, [log(cafe())])
    const t2 = await turn(sql, a, [undo], { at: minutes(1) })
    const [row] = await sql`SELECT undoes::int AS undoes FROM turn WHERE id = ${t2.turn}`
    expect(row?.undoes).toBe(t1.turn)
    await expect(
      sql`INSERT INTO turn (account_id, channel, label, calls, reply, undoes) VALUES (${a}, 'cli', 'undo', '[]', 'x', ${t1.turn})`,
    ).rejects.toThrow(/turn_undoes_once/)
  })

  it('a turn whose guard says the claim was lost writes nothing', async () => {
    const a = await newAccount(sql)
    const t = await commit(sql, {
      accountId: a,
      channel: 'whatsapp',
      now: NOW,
      calls: [log(cafe())],
      before: async () => false,
      compose: () => ({ reply: 'x' }),
    })
    expect(t).toBeNull()
    expect(await allMovements(sql)).toEqual([])
    expect(await sql`SELECT 1 FROM turn`).toHaveLength(0)
  })

  it('`after` runs in the transaction with the turn: a failure there rolls the whole turn back', async () => {
    const a = await newAccount(sql)
    const seen: number[] = []
    await commit(sql, {
      accountId: a,
      channel: 'whatsapp',
      now: NOW,
      calls: [log(cafe())],
      compose: () => ({ reply: 'x' }),
      after: async (tx, t) => {
        seen.push(t.id)
        await tx`SELECT 1 FROM turn WHERE id = ${t.id}`
      },
    })
    expect(seen).toHaveLength(1)
    await expect(
      commit(sql, {
        accountId: a,
        channel: 'whatsapp',
        now: NOW,
        calls: [log(cafe())],
        compose: () => ({ reply: 'x' }),
        after: async () => {
          throw new Error('send marker failed')
        },
      }),
    ).rejects.toThrow('send marker failed')
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
    ).rejects.toThrow(/made_in_fkey|foreign key/)
    expect(await allMovements(sql)).toEqual([])
  })

  it('turn ids of one account are in commit order, and the account lock is the first thing taken', async () => {
    const a = await newAccount(sql)
    const first = await turn(sql, a, [log(cafe())])
    const second = await turn(sql, a, [log(cafe())])
    expect(second.turn).toBeGreaterThan(first.turn)
  })
})
