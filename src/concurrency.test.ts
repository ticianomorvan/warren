import { describe, expect, it } from 'vitest'
import type { Action } from './agent'
import { correct, history, logOf, movement, remove, script, seed, WA } from './command-fixtures'
import type { Sql } from './db'
import { execute } from './execute'
import { REPLY_GONE } from './render'
import { createStore } from './store'
import { bodies, messageBody, post, setup, sql, TODAY, until, useDatabase } from './test-harness'

/**
 * Against a real Postgres with a pool of connections, which PGlite's single connection cannot
 * show. Skipped unless PG_TEST_URL is set (see AGENTS.md), so CI and `pnpm test` never need one.
 * The database is truncated between tests: point it at a throwaway one.
 */
const url = process.env.PG_TEST_URL
if (url) useDatabase({ url, max: 12 })

describe.skipIf(!url)('real Postgres: concurrency', () => {
  it('concurrent corrections and deletes of one movement apply once, the rest get a reply', async () => {
    const store = createStore(sql, { staleMs: 60_000, maxAttempts: 3 })
    const actions: Action[][] = [
      ...[3800, 3900, 4000, 4100, 4200].map((n): Action[] => [
        { tool: 'correct_movement', input: { id: 0, changes: { amount: String(n) }, text: null } },
      ]),
      ...[0, 1, 2].map((): Action[] => [{ tool: 'delete_movement', input: { id: 0, text: null } }]),
    ]
    // The race is a few statements wide, so each round can miss it; several rounds do not.
    const ROUNDS = 6
    let corrections = 0
    for (let round = 0; round < ROUNDS; round++) {
      const [target] = await seed([
        { on: TODAY, amount: '3500', description: 'café', category: 'restaurantes' },
      ])
      const [account] = await sql`SELECT id FROM account`
      const accountId = Number(account?.id)
      const inbound = await sql`
        INSERT INTO inbound_message ${sql(
          actions.map((_, k) => ({
            wamid: `race.${round}.${k}`,
            wa_id: WA,
            kind: 'text',
            body: 'x',
            payload: sql.json({}),
            status: 'processing',
            attempts: 1,
          })),
        )}
        RETURNING id::int AS id`
      const replies = await Promise.all(
        actions.map((calls, k) => {
          const aimed = calls.map(
            (a) => ({ ...a, input: { ...a.input, id: target ?? 0 } }) as Action,
          )
          return store.commit({ id: inbound[k]?.id ?? 0, attempts: 1 } as never, {
            parsed: aimed,
            command: aimed,
            action: 'multi',
            turns: 1,
            modelMs: 1,
            execute: async (tx: Sql) => {
              // Every transaction is open and past its guard before any of them touches the movement.
              await tx`SELECT pg_sleep(0.15)`
              return execute(tx, {
                accountId,
                inboundId: inbound[k]?.id ?? 0,
                actions: aimed,
                audit: [],
                today: TODAY,
                message: '',
                facts: [],
                window: [],
              })
            },
          })
        }),
      )
      const applied = replies.filter((r) => r?.startsWith('✓'))
      expect(applied, `round ${round}`).toHaveLength(1)
      corrections += applied.filter((r) => r?.startsWith('✓ Corregido')).length
      for (const r of replies.filter((r) => !r?.startsWith('✓'))) expect(r).toBe(REPLY_GONE)
    }
    const rows = await history()
    expect(rows.filter((r) => r.deleted || r.superseded_by !== null)).toHaveLength(ROUNDS)
    expect(rows).toHaveLength(ROUNDS + corrections)
  })

  it("one sender's burst is processed in arrival order, each message seeing the one before", async () => {
    const app = await setup({
      model: script(
        logOf(movement()),
        correct(1, { amount: '3800' }),
        correct(2, { amount: '4200' }),
        remove(3),
      ),
    })
    for (const k of [1, 2, 3, 4]) await post(app.base, messageBody(`wamid.BURST${k}`, WA))
    await until(
      async () => (await sql`SELECT 1 FROM inbound_message WHERE status = 'done'`).length === 4,
    )
    expect(bodies(app.calls)).toEqual([
      '✓ Café $3.500',
      '✓ Corregido: Café $3.800 (antes $3.500)',
      '✓ Corregido: Café $4.200 (antes $3.800)',
      '✓ Borré: Café $4.200',
    ])
    expect((await history()).map((r) => [r.amount, r.superseded_by !== null, r.deleted])).toEqual([
      ['3500', true, false],
      ['3800', true, false],
      ['4200', false, true],
    ])
    app.close()
  })
})
