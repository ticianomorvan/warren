import { describe, expect, it } from 'vitest'
import type { Action } from './agent'
import { correct, history, logOf, movement, remove, script, seed, WA } from './command-fixtures'
import type { Sql } from './db'
import { execute } from './execute'
import { REPLY_GONE, REPLY_UNDO_NOTHING } from './render'
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

  describe('an undo racing a correction of the same movement', () => {
    /**
     * Commits one message's actions in its own transaction. It waits `start` ms before it begins, and holds
     * its locks `hold` ms after it acted, so a test can make either one go first without a race to win.
     */
    async function commitMessage(
      store: ReturnType<typeof createStore>,
      wamid: string,
      actions: Action[],
      o: { start?: number; hold?: number } = {},
    ) {
      const [account] = await sql`SELECT id::int AS id FROM account WHERE wa_id = ${WA}`
      const [message] = await sql`
        INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, attempts)
        VALUES (${wamid}, ${WA}, 'text', 'x', '{}'::jsonb, 'processing', 1) RETURNING id::int AS id`
      if (o.start) await new Promise((r) => setTimeout(r, o.start))
      return store.commit({ id: message?.id ?? 0, attempts: 1 } as never, {
        parsed: actions,
        command: actions,
        action: actions.some((a) => a.tool === 'undo_last') ? 'undo' : 'multi',
        turns: 1,
        modelMs: 1,
        execute: async (tx: Sql) => {
          const done = await execute(tx, {
            accountId: account?.id ?? 0,
            inboundId: message?.id ?? 0,
            actions,
            audit: [],
            today: TODAY,
            message: '',
            facts: [],
            window: [],
          })
          if (o.hold) await tx`SELECT pg_sleep(${o.hold / 1000})`
          return done
        },
      })
    }
    const undo: Action[] = [{ tool: 'undo_last', input: { text: null } }]
    const fix = (id: number): Action[] => [
      { tool: 'correct_movement', input: { id, changes: { amount: '3800' }, text: null } },
    ]
    const arrange = async () => {
      const store = createStore(sql, { staleMs: 60_000, maxAttempts: 3 })
      const [target] = await seed([
        { on: TODAY, amount: '3500', description: 'café', category: 'restaurantes' },
      ])
      // The café was logged by a committed message: the batch an undo reaches.
      const [batch] = await sql`
        INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, action, reply_text)
        VALUES ('race.batch', ${WA}, 'text', 'café', '{}'::jsonb, 'done', 'log', '✓ Café $3.500')
        RETURNING id::int AS id`
      await sql`UPDATE movement SET inbound_message_id = ${batch?.id ?? 0}, position = 0 WHERE id = ${target ?? 0}`
      return { store, target: target ?? 0 }
    }

    it('the undo first: the correction waits for the lock, then finds the movement gone', async () => {
      const { store, target } = await arrange()
      const [undone, fixed] = await Promise.all([
        commitMessage(store, 'race.u', undo, { hold: 400 }),
        commitMessage(store, 'race.c', fix(target), { start: 150 }),
      ])
      expect(undone).toBe('↩︎ Deshice: Café $3.500')
      expect(fixed).toBe(REPLY_GONE)
      const rows = await history()
      expect(rows.map((r) => [r.amount, r.superseded_by, r.deleted])).toEqual([
        ['3500', null, true],
      ])
    })

    it('the correction first: the undo waits for the lock, then refuses and touches nothing', async () => {
      const { store, target } = await arrange()
      const [fixed, undone] = await Promise.all([
        commitMessage(store, 'race.c', fix(target), { hold: 400 }),
        commitMessage(store, 'race.u', undo, { start: 150 }),
      ])
      expect(fixed).toBe('✓ Corregido: Café $3.800 (antes $3.500)')
      expect(undone).toBe('No deshice nada: Café $3.500 cambió después. Decime qué querés cambiar.')
      const rows = await history()
      expect(rows.map((r) => [r.amount, r.superseded_by !== null, r.deleted])).toEqual([
        ['3500', true, false],
        ['3800', false, false],
      ])
      expect(
        (await sql`SELECT count(*)::int AS n FROM inbound_message WHERE undoes IS NOT NULL`)[0]?.n,
      ).toBe(0)
    })

    it('two undos at once take back two batches, one each, never the same one twice', async () => {
      const store = createStore(sql, { staleMs: 60_000, maxAttempts: 3 })
      const ids = await seed([
        { on: TODAY, amount: '3500', description: 'café', category: 'restaurantes' },
        { on: TODAY, amount: '5000', description: 'súper', category: 'supermercado' },
      ])
      for (const [k, id] of ids.entries()) {
        const [batch] = await sql`
          INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, action, reply_text)
          VALUES (${`two.${k}`}, ${WA}, 'text', 'x', '{}'::jsonb, 'done', 'log', '✓')
          RETURNING id::int AS id`
        await sql`UPDATE movement SET inbound_message_id = ${batch?.id ?? 0}, position = 0 WHERE id = ${id}`
      }
      const [first, second] = await Promise.all([
        commitMessage(store, 'two.u1', undo, { hold: 400 }),
        commitMessage(store, 'two.u2', undo, { start: 150 }),
      ])
      expect(first).toBe('↩︎ Deshice: Súper $5.000')
      expect(second).toBe('↩︎ Deshice: Café $3.500')
      expect((await history()).every((r) => r.deleted)).toBe(true)
      expect(
        (
          await sql`SELECT count(DISTINCT undoes)::int AS n FROM inbound_message WHERE undoes IS NOT NULL`
        )[0]?.n,
      ).toBe(2)
    })

    it('whoever wins, exactly one of them changes the movement, and a second undo races to nothing', async () => {
      for (let round = 0; round < 6; round++) {
        await sql`TRUNCATE movement, inbound_message, account RESTART IDENTITY CASCADE`
        const { store, target } = await arrange()
        const [a, b] = await Promise.all([
          commitMessage(store, `race.u.${round}`, undo, { hold: 20 }),
          commitMessage(store, `race.c.${round}`, fix(target), { hold: 20 }),
        ])
        const rows = await history()
        const live = rows.filter((r) => r.superseded_by === null && !r.deleted)
        // Either the undo went first (café gone, correction refused), the correction went first (undo refused), or the undo
        // took back the correction after it committed. Never both changes, never a half undo.
        expect(
          [
            [a, b, '↩︎ Deshice: Café $3.500', REPLY_GONE],
            [
              a,
              b,
              'No deshice nada: Café $3.500 cambió después. Decime qué querés cambiar.',
              '✓ Corregido: Café $3.800 (antes $3.500)',
            ],
            [
              a,
              b,
              '↩︎ Deshice:\n• Café $3.500 (estaba $3.800)',
              '✓ Corregido: Café $3.800 (antes $3.500)',
            ],
          ].some(([x, y, ex, ey]) => x === ex && y === ey),
          `round ${round}: ${a} | ${b}`,
        ).toBe(true)
        expect(live.length).toBeLessThanOrEqual(1)
        const second = await commitMessage(store, `race.u2.${round}`, undo)
        expect(second === REPLY_UNDO_NOTHING || second?.startsWith('↩︎')).toBe(true)
      }
    })
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
