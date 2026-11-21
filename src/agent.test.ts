import { describe, expect, it } from 'vitest'
import type { Action } from './agent'
import {
  ask,
  correct,
  find,
  history,
  lastWamid,
  logOf,
  movement,
  remove,
  replyCall,
  say,
  script,
  seed,
  sum,
  summarize,
  WA,
} from './command-fixtures'
import type { Sql } from './db'
import { execute } from './execute'
import { recentMovements } from './ledger'
import { REPLY_FAILED, REPLY_GONE } from './render'
import { createStore } from './store'
import {
  bodies,
  fakeGraph,
  fakeModel,
  gate,
  messageBody,
  post,
  row,
  setup,
  sql,
  TODAY,
  until,
  useDatabase,
} from './test-harness'

useDatabase()

/** Five movements of today, logged at 09:00, 10:10, 10:45, 11:54 and 11:59; ids 1 to 5, the taxi is the newest. */
const day = async () =>
  seed([
    {
      on: TODAY,
      amount: '12000',
      description: 'súper',
      category: 'supermercado',
      payment: 'crédito visa',
      at: '09:12',
    },
    { on: TODAY, amount: '3500', description: 'café', category: 'restaurantes', at: '10:10' },
    {
      on: TODAY,
      amount: '20000',
      description: 'nafta',
      category: 'combustible',
      payment: 'efectivo',
      at: '10:45',
    },
    { on: TODAY, amount: '2900', description: 'café', category: 'restaurantes', at: '11:54' },
    { on: TODAY, amount: '5400', description: 'taxi', category: 'transporte', at: '11:59' },
  ])

const live = async () =>
  (
    await sql`SELECT id::int AS id, description, amount::text AS amount FROM movement
      WHERE superseded_by IS NULL AND deleted_at IS NULL ORDER BY id`
  ).map((r) => `${r.description} ${r.amount}`)

describe('correct', () => {
  it('inserts a new row linked to the correcting message and keeps the old one, superseded', async () => {
    const app = await setup({
      model: script(logOf(movement({ payment: 'crédito visa' })), correct(1, { amount: '3800' })),
    })
    await say(app)
    const reply = await say(app)
    expect(reply).toBe('✓ Corregido: Café $3.800 (crédito visa) (antes $3.500)')
    const rows = await history()
    expect(rows).toHaveLength(2)
    const [old, next] = rows
    expect(old).toMatchObject({ amount: '3500', superseded_by: next?.id, deleted: false })
    expect(next).toMatchObject({ amount: '3800', superseded_by: null, deleted: false })
    expect(next?.inbound).not.toBe(old?.inbound) // linked to the correcting message
    expect(Number((await row(lastWamid))?.id)).toBe(next?.inbound)
    expect(await sum('superseded_by IS NULL')).toBe('3800')
    app.close()
  })

  it('shows only the fields that changed, and the one it said', async () => {
    const app = await setup({
      model: script(
        logOf(movement({ date: '2025-10-08' })),
        correct(1, { date: TODAY, payment: 'efectivo' }),
        correct(2, { category: 'entretenimiento' }),
      ),
    })
    await say(app)
    expect(await say(app)).toBe(
      '✓ Corregido: Café $3.500 (efectivo) · hoy (antes ayer, sin medio de pago)',
    )
    expect(await say(app)).toBe(
      '✓ Corregido: Café $3.500 (efectivo) · Entretenimiento (antes Restaurantes)',
    )
    expect(await history()).toHaveLength(3)
    app.close()
  })

  it('names the day and the time logged when the movement is not the newest', async () => {
    await day()
    const app = await setup({
      model: script(correct(5, { amount: '5600' }), correct(2, { amount: '2500' })),
    })
    expect(await say(app, { text: 'el taxi fue 5600' })).toBe(
      '✓ Corregido: Taxi $5.600 (antes $5.400)',
    )
    // The corrected taxi is a new row, so it is the newest now and the café no longer is.
    expect(await say(app, { text: 'el café de las 10 fueron 2500' })).toBe(
      '✓ Corregido: Café $2.500 (antes $3.500) · 10:10',
    )
    app.close()
  })

  it('says when a correction changes nothing, and stores no new row', async () => {
    await day()
    const app = await setup({ model: script(correct(2, { amount: '3500' })) })
    expect(await say(app)).toBe('Ya figura así: Café $3.500')
    expect(await history()).toHaveLength(5)
    app.close()
  })

  it('a correction keeps the time the movement was first logged', async () => {
    const app = await setup({ model: script(logOf(movement()), correct(1, { amount: '3800' })) })
    await say(app)
    await sql`UPDATE movement SET created_at = '2025-10-09T13:13:00Z'` // 10:13 in Buenos Aires
    await say(app)
    const [account] = await sql`SELECT id FROM account`
    const [now] = await recentMovements(sql, Number(account?.id))
    expect(now).toMatchObject({ amount: '3800', time: '10:13' })
    app.close()
  })
})

describe('delete', () => {
  it('soft-deletes: the row stays, stamped with when and by which message', async () => {
    const app = await setup({ model: script(logOf(movement()), remove(1)) })
    await say(app)
    expect(await say(app)).toBe('✓ Borré: Café $3.500')
    const [gone] = await history()
    expect(gone).toMatchObject({ deleted: true, superseded_by: null })
    expect(gone?.deleted_by).toBe(Number((await row(lastWamid))?.id))
    expect(await sum('deleted_at IS NULL')).toBeNull()
    app.close()
  })

  it('names the time it was logged when it is not the newest, and not when it is', async () => {
    await day()
    const app = await setup({ model: script(remove(2), remove(5)) })
    expect(await say(app)).toBe('✓ Borré: Café $3.500 · 10:10')
    expect(await say(app)).toBe('✓ Borré: Taxi $5.400')
    expect(await live()).toEqual(['súper 12000', 'nafta 20000', 'café 2900'])
    app.close()
  })
})

describe('several actions in one message', () => {
  it('runs a delete and a correction in one transaction and answers once', async () => {
    await day()
    const app = await setup({ model: script([remove(4), correct(5, { amount: '4000' })]) })
    const reply = await say(app, { text: 'borrá el 2 y cambiá el 1 a 4000' })
    expect(reply).toBe('✓ Borré: Café $2.900 · 11:54\n✓ Corregido: Taxi $4.000 (antes $5.400)')
    expect(bodies(app.calls)).toHaveLength(1)
    expect(await live()).toEqual(['súper 12000', 'café 3500', 'nafta 20000', 'taxi 4000'])
    const stored = await row(lastWamid)
    expect(stored).toMatchObject({ action: 'multi', model_turns: 1 })
    expect(
      stored?.tool_calls.map((c: { tool: string; status: string }) => [c.tool, c.status]),
    ).toEqual([
      ['delete_movement', 'applied'],
      ['correct_movement', 'applied'],
    ])
    app.close()
  })

  it('corrects two movements and logs a third in the same message, each row in its own position', async () => {
    await day()
    const app = await setup({
      model: script([
        correct(2, { amount: '2500' }),
        correct(1, { amount: '13000' }),
        logOf(movement({ description: 'subte', amount: '1200', category: 'transporte' })),
      ]),
    })
    const reply = await say(app)
    expect(reply.split('\n')).toEqual([
      '✓ Corregido: Café $2.500 (antes $3.500) · 10:10',
      '✓ Corregido: Súper $13.000 (crédito visa) (antes $12.000) · 09:12',
      '✓ Subte $1.200',
    ])
    const rows =
      await sql`SELECT position FROM movement WHERE inbound_message_id = ${(await row(lastWamid))?.id} ORDER BY position`
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2])
    app.close()
  })

  it('one action that cannot run does not stop the others, and the reply says which', async () => {
    await day()
    const app = await setup({
      model: script([remove(5), remove(5), correct(4, { amount: '3000' })]),
    })
    expect((await say(app)).split('\n')).toEqual([
      '✓ Borré: Taxi $5.400',
      REPLY_GONE,
      '✓ Corregido: Café $3.000 (antes $2.900) · 11:54',
    ])
    expect((await row(lastWamid))?.tool_calls.map((c: { status: string }) => c.status)).toEqual([
      'applied',
      'gone',
      'applied',
    ])
    app.close()
  })

  it('an action and a question are one reply, and the question can be answered', async () => {
    await day()
    const app = await setup({
      model: script([remove(4), ask([5], { question: 'Qué querés cambiar' })]),
    })
    expect(await say(app)).toBe('✓ Borré: Café $2.900 · 11:54\n¿Qué querés cambiar? Taxi $5.400')
    app.close()
  })
})

describe('find_movements, then act', () => {
  it('finds an older movement by words and corrects it by id, in two model turns', async () => {
    await seed([
      {
        on: '2025-10-01',
        amount: '240000',
        description: 'alquiler',
        category: 'vivienda',
        at: '09:00',
      },
      ...Array.from({ length: 10 }, (_, k) => ({
        on: TODAY,
        amount: String(1000 + k),
        description: `gasto ${k}`,
        at: '10:00',
      })),
    ])
    const app = await setup({
      model: script(find({ text: 'Alquiler' }), correct(1, { amount: '250000' })),
    })
    const reply = await say(app, { text: 'el alquiler fue 250000' })
    expect(reply).toBe('✓ Corregido: Alquiler $250.000 · 01/10 (antes $240.000) · 09:00')
    const stored = await row(lastWamid)
    expect(stored).toMatchObject({ action: 'correct', model_turns: 2 })
    expect(
      stored?.tool_calls.map((c: { tool: string; status: string }) => [c.tool, c.status]),
    ).toEqual([
      ['find_movements', 'ok'],
      ['correct_movement', 'applied'],
    ])
    // The list did not show the alquiler: only the read made its id usable.
    expect(
      String(app.requests[0]?.messages[0]?.content)
        .split('\n')
        .filter((l) => /^\d+\. id=/.test(l))
        .join('\n'),
    ).not.toContain('alquiler')
    const second = app.requests[1]?.messages.at(-1)?.content as { content: string }[]
    expect(second[0]?.content).toContain('id=1 out 240000 ARS 2025-10-01 09:00 alquiler [vivienda]')
    app.close()
  })

  it("searches by text, category, payment, amount, dates and limit, only the sender's live movements", async () => {
    await seed([
      {
        on: '2026-10-04',
        amount: '21000',
        description: 'nafta',
        category: 'combustible',
        payment: 'Efectivo',
      },
      {
        on: '2026-11-19',
        amount: '20000',
        description: 'nafta',
        category: 'combustible',
        payment: 'crédito visa',
      },
      { on: '2026-11-20', amount: '9000', description: 'cine', category: 'entretenimiento' },
      { on: '2026-11-21', amount: '700', description: 'café con leche', category: 'restaurantes' },
    ])
    const store = createStore(sql, { staleMs: 60_000, maxAttempts: 3 })
    const [account] =
      await sql`INSERT INTO account (wa_id) VALUES (${WA}) ON CONFLICT (wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id RETURNING id`
    const id = Number(account?.id)
    const f = (o: object) =>
      store
        .find(id, {
          text: null,
          from: null,
          to: null,
          category: null,
          payment: null,
          amount: null,
          limit: 20,
          ...o,
        })
        .then((r) => r.map((m) => m.description + m.amount))
    expect(await f({ text: 'NAFTA' })).toEqual(['nafta20000', 'nafta21000'])
    expect(await f({ text: 'combustible' })).toEqual(['nafta20000', 'nafta21000'])
    expect(await f({ text: 'cafe leche' })).toEqual(['café con leche700'])
    expect(await f({ category: 'entretenimiento' })).toEqual(['cine9000'])
    expect(await f({ payment: 'EFECTIVO' })).toEqual(['nafta21000'])
    expect(await f({ amount: '20000' })).toEqual(['nafta20000'])
    expect(await f({ from: '2026-11-01', to: '2026-11-19' })).toEqual(['nafta20000'])
    expect(await f({ limit: 2 })).toEqual(['café con leche700', 'cine9000'])
    expect(await f({ text: '100%_' })).toEqual([]) // LIKE wildcards are plain characters
    await sql`UPDATE movement SET deleted_at = now(), deleted_by = (SELECT id FROM inbound_message LIMIT 1) WHERE description = 'cine'`
    expect(await f({ category: 'entretenimiento' })).toEqual([])
    const [other] = await sql`INSERT INTO account (wa_id) VALUES ('5491100000099') RETURNING id`
    expect(await f({ text: 'nafta' })).toHaveLength(2)
    expect(
      await store.find(Number(other?.id), {
        text: 'nafta',
        from: null,
        to: null,
        category: null,
        payment: null,
        amount: null,
        limit: 20,
      }),
    ).toEqual([])
  })
})

describe('guards at the commit point', () => {
  it('an id the model was never shown is refused three times: failure notice, nothing written', async () => {
    const [mine] = await seed([{ on: TODAY, amount: '1000', description: 'mío' }])
    // Another sender's movement: its id was never in this sender's list.
    const [other] = await sql`INSERT INTO account (wa_id) VALUES ('5491100000099') RETURNING id`
    const [inbound] =
      await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload) VALUES ('seed.other', '5491100000099', 'text', 'x', '{}'::jsonb) RETURNING id`
    const [theirs] =
      await sql`INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency, occurred_on, description, category, confidence)
      VALUES (${other?.id}, ${inbound?.id}, 0, 'out', 77, 'ARS', ${TODAY}, 'ajeno', 'otros', 'high') RETURNING id::int AS id`
    const app = await setup({ model: fakeModel(() => [remove(theirs?.id ?? 0)]) })
    expect(mine).toBe(1)
    expect(await say(app, { text: 'borrá el 1' }).catch(() => 'failed')).not.toContain('✓')
    expect(app.model.n).toBe(3)
    expect(await sum('deleted_at IS NOT NULL')).toBeNull()
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    app.close()
  })

  it("execute refuses an id that is not the sender's or not live, whatever the loop let through", async () => {
    const [mine, gone] = await seed([
      { on: TODAY, amount: '1000', description: 'mío' },
      { on: TODAY, amount: '2000', description: 'borrado' },
    ])
    const [account] = await sql`SELECT id FROM account`
    const [inbound] = await sql`SELECT id FROM inbound_message`
    const [other] = await sql`INSERT INTO account (wa_id) VALUES ('5491100000099') RETURNING id`
    const [theirs] =
      await sql`INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency, occurred_on, description, category, confidence)
      VALUES (${other?.id}, ${inbound?.id}, 5, 'out', 77, 'ARS', ${TODAY}, 'ajeno', 'otros', 'high') RETURNING id::int AS id`
    await sql`UPDATE movement SET deleted_at = now(), deleted_by = ${inbound?.id} WHERE id = ${gone ?? 0}`
    const actions: Action[] = [
      { tool: 'delete_movement', input: { id: theirs?.id ?? 0 } },
      { tool: 'delete_movement', input: { id: gone ?? 0 } },
      { tool: 'correct_movement', input: { id: theirs?.id ?? 0, changes: { amount: '1' } } },
      { tool: 'correct_movement', input: { id: 999, changes: { amount: '1' } } },
      { tool: 'delete_movement', input: { id: mine ?? 0 } },
    ]
    const done = await sql.begin((tx) =>
      execute(tx as unknown as Sql, {
        accountId: Number(account?.id),
        inboundId: Number(inbound?.id),
        actions,
        audit: [],
        today: TODAY,
      }),
    )
    expect(done.reply.split('\n')).toEqual([
      REPLY_GONE,
      REPLY_GONE,
      REPLY_GONE,
      REPLY_GONE,
      '✓ Borré: Mío $1.000',
    ])
    expect(
      await sum(`account_id = ${other?.id} AND deleted_at IS NULL AND superseded_by IS NULL`),
    ).toBe('77')
    expect(await live()).toEqual(['ajeno 77']) // only the other sender's row is left alive
  })

  it("ask_user offers only the sender's live movements, whatever ids it was given", async () => {
    const [mine, gone] = await seed([
      { on: TODAY, amount: '1000', description: 'mío' },
      { on: TODAY, amount: '2000', description: 'borrado' },
    ])
    const [account] = await sql`SELECT id FROM account`
    const [inbound] = await sql`SELECT id FROM inbound_message`
    const [other] = await sql`INSERT INTO account (wa_id) VALUES ('5491100000099') RETURNING id`
    const [theirs] =
      await sql`INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency, occurred_on, description, category, confidence)
      VALUES (${other?.id}, ${inbound?.id}, 5, 'out', 77, 'ARS', ${TODAY}, 'ajeno', 'otros', 'high') RETURNING id::int AS id`
    await sql`UPDATE movement SET deleted_at = now(), deleted_by = ${inbound?.id} WHERE id = ${gone ?? 0}`
    const done = await sql.begin((tx) =>
      execute(tx as unknown as Sql, {
        accountId: Number(account?.id),
        inboundId: Number(inbound?.id),
        actions: [
          {
            tool: 'ask_user',
            input: {
              question: 'Cuál',
              movement_ids: [theirs?.id ?? 0, gone ?? 0, mine ?? 0],
              after_answer: 'delete',
            },
          },
        ],
        audit: [],
        today: TODAY,
      }),
    )
    expect(done.reply).toBe('¿Cuál? Mío $1.000')
    expect(done.asked).toEqual([{ number: 1, id: mine }])
  })

  it('a correction with a value the table cannot hold never reaches the commit: three refusals end in the failure notice', async () => {
    await day()
    const app = await setup({ model: fakeModel(() => [correct(2, { amount: '3.800' })]) })
    await say(app).catch(() => '')
    expect(app.model.n).toBe(3)
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    expect(await history()).toHaveLength(5)
    expect(await sum('superseded_by IS NOT NULL')).toBeNull()
    app.close()
  })

  it('the step cap and the deadline end in the failure notice and write nothing', async () => {
    await day()
    // A model that only ever reads never acts: the cap of 3 model turns stops it.
    const reads = await setup({ model: fakeModel(() => [find({ text: 'café' })]) })
    await post(reads.base, messageBody('wamid.CAP', WA))
    await until(() => reads.calls.sent.length === 1)
    expect(bodies(reads.calls)).toEqual([REPLY_FAILED])
    expect(reads.model.n).toBe(3)
    expect(await row('wamid.CAP')).toMatchObject({
      status: 'failed',
      command: null,
      reply_text: null,
    })
    reads.close()

    // The deadline lands in the middle of the loop: a read came back, the second turn hangs.
    const hang = gate()
    const slow = await setup({
      model: fakeModel(async (signal, { n }) => {
        if (n === 1) return [find({ text: 'café' })]
        await Promise.race([
          hang.promise,
          new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(signal.reason)),
          ),
        ])
        return [remove(2)]
      }),
      deadlineMs: 150,
    })
    await post(slow.base, messageBody('wamid.LATE', WA))
    await until(() => slow.calls.sent.length === 1)
    expect(bodies(slow.calls)).toEqual([REPLY_FAILED])
    hang.open()
    await new Promise((r) => setTimeout(r, 100))
    expect(await row('wamid.LATE')).toMatchObject({ status: 'failed', reply_text: null })
    expect(await live()).toHaveLength(5)
    slow.close()
  })
})

describe('replays', () => {
  it('a replayed two-action message applies once: webhook retry, then the sweep re-claiming it', async () => {
    await day()
    const app = await setup({ model: script([remove(4), correct(5, { amount: '4000' })]) })
    const body = messageBody('wamid.TWO', WA)
    await post(app.base, body)
    await until(async () => (await row('wamid.TWO'))?.status === 'done')
    await post(app.base, body) // Meta delivers it again
    await post(app.base, body)
    await new Promise((r) => setTimeout(r, 150))
    expect(await history()).toHaveLength(6)

    const sentBefore = app.calls.sent.length
    // The worker died after the commit and before the reply was recorded: the row is due again.
    await sql`UPDATE inbound_message SET status = 'pending', send_started_at = NULL, reply_sent_at = NULL WHERE wamid = 'wamid.TWO'`
    await app.processor.sweep()
    expect(app.model.n).toBe(1) // no model call: the stored reply goes out
    expect(app.calls.sent.length).toBe(sentBefore + 1)
    expect(app.calls.sent.at(-1)?.body).toBe(app.calls.sent[0]?.body)
    const rows = await history()
    expect(rows).toHaveLength(6)
    expect(rows.filter((r) => r.superseded_by !== null)).toHaveLength(1)
    expect(rows.filter((r) => r.deleted)).toHaveLength(1)
    app.close()
  })

  it('a second commit for a message that already has its reply never runs the actions', async () => {
    const app = await setup({ model: script(logOf(movement()), correct(1, { amount: '3800' })) })
    await say(app)
    await say(app)
    const [claim] = await sql`
      UPDATE inbound_message SET status = 'processing', attempts = attempts + 1
      WHERE wamid = ${lastWamid} RETURNING id, attempts`
    let ran = false
    const committed = await app.store.commit(
      { id: Number(claim?.id), attempts: Number(claim?.attempts) } as never,
      {
        parsed: null,
        command: [],
        action: 'reply',
        turns: 0,
        modelMs: 1,
        execute: async () => {
          ran = true
          return { reply: 'x', audit: [] }
        },
      },
    )
    expect(committed).toBeNull()
    expect(ran).toBe(false)
    expect(await history()).toHaveLength(2)
    app.close()
  })
})

describe('ask, then answer', () => {
  it('stores what a question offered and what choosing will do; a bare number then runs it, with no model call', async () => {
    await day()
    const app = await setup({
      model: script(ask([5, 4, 3], { after: 'correct', changes: { amount: '5000' } })),
    })
    const question = await say(app, { text: 'cambiame lo del almuerzo a 5000' })
    expect(question).toBe(
      '¿Cuál? 1. Taxi $5.400 · 2. Café $2.900 · 3. Nafta $20.000 (efectivo)\nRespondé con el número, por ejemplo "el 1".',
    )
    const asked = await row(lastWamid)
    expect(asked).toMatchObject({
      action: 'ask',
      asked_numbers: [1, 2, 3],
      pending: { action: 'correct', changes: { amount: '5000' } },
    })
    expect(asked?.asked_ids.map(Number)).toEqual([5, 4, 3])
    expect(await history()).toHaveLength(5)

    expect(await say(app, { text: '2' })).toBe('✓ Corregido: Café $5.000 (antes $2.900) · 11:54')
    expect(app.model.n).toBe(1) // answered by code
    const answered = await row(lastWamid)
    expect(answered).toMatchObject({ action: 'correct', model_turns: 0, parsed: null })
    expect(answered?.command).toEqual([
      { tool: 'correct_movement', input: { id: 4, changes: { amount: '5000' } } },
    ])
    expect(answered?.tool_calls).toMatchObject([
      { tool: 'correct_movement', status: 'applied', turn: 0 },
    ])
    expect(await live()).toEqual([
      'súper 12000',
      'café 3500',
      'nafta 20000',
      'taxi 5400',
      'café 5000',
    ])
    app.close()
  })

  it('answers a delete question, by ordinal too', async () => {
    await day()
    const app = await setup({ model: script(ask([5, 4], { after: 'delete' })) })
    await say(app, { text: 'borrá lo del almuerzo' })
    expect(await say(app, { text: 'la segunda' })).toBe('✓ Borré: Café $2.900 · 11:54')
    expect(app.model.n).toBe(1)
    app.close()
  })

  it('the option is the movement offered, even when it is gone before the answer', async () => {
    await day()
    const app = await setup({ model: script(ask([5, 4], { after: 'delete' })) })
    await say(app, { text: 'borrá lo del almuerzo' })
    await sql`UPDATE movement SET deleted_at = now(), deleted_by = (SELECT id FROM inbound_message LIMIT 1) WHERE id = 4`
    expect(await say(app, { text: '2' })).toBe(REPLY_GONE)
    expect(await live()).toEqual(['súper 12000', 'café 3500', 'nafta 20000', 'taxi 5400'])
    app.close()
  })

  it('a bare number after a reply that was not a question goes to the model, which writes nothing', async () => {
    await day()
    const app = await setup({ model: script(replyCall('help'), replyCall('help')) })
    await say(app, { text: 'hola' })
    await say(app, { text: '2' })
    expect(app.model.n).toBe(2)
    expect(await history()).toHaveLength(5)
    app.close()
  })

  it('does not answer a question that is older than 10 minutes', async () => {
    await day()
    const app = await setup({ model: script(ask([5, 4], { after: 'delete' }), replyCall('help')) })
    await say(app, { text: 'borrá lo del almuerzo' })
    await sql`UPDATE inbound_message SET received_at = now() - interval '11 minutes' WHERE wamid = ${lastWamid}`
    expect(await say(app, { text: '2' })).toContain('Mandame un gasto')
    expect(app.model.n).toBe(2)
    expect(await live()).toHaveLength(5)
    app.close()
  })

  it('"sí" after a several-option question chooses nothing: the model is asked, with the question pending', async () => {
    await day()
    const app = await setup({
      model: script(ask([5, 4, 3], { after: 'delete' }), ask([5, 4, 3], { after: 'delete' })),
    })
    await say(app, { text: 'borrá lo del almuerzo' })
    expect(await say(app, { text: 'sí' })).toContain('¿Cuál?')
    expect(app.model.n).toBe(2)
    expect(String(app.requests[1]?.messages[0]?.content)).toContain(
      'Pregunta pendiente: 1 = id 5, 2 = id 4, 3 = id 3 (la persona pidió borrar)',
    )
    expect(await live()).toHaveLength(5)
    app.close()
  })

  it('"sí" after a one-option question runs the pending action', async () => {
    await day()
    const app = await setup({
      model: script(ask([5], { after: 'delete', question: 'Querés borrar este' })),
    })
    expect(await say(app, { text: 'borrá lo del remís' })).toBe('¿Querés borrar este? Taxi $5.400')
    expect(await say(app, { text: 'dale' })).toBe('✓ Borré: Taxi $5.400')
    expect(app.model.n).toBe(1)
    app.close()
  })

  it('an answer with more than a number goes to the model, which sees the pending options', async () => {
    await day()
    const app = await setup({
      model: script(ask([5, 4], { after: 'delete' }), correct(4, { amount: '4500' })),
    })
    await say(app, { text: 'borrá lo del almuerzo' })
    expect(await say(app, { text: 'el 2 fue 4500' })).toBe(
      '✓ Corregido: Café $4.500 (antes $2.900) · 11:54',
    )
    expect(String(app.requests[1]?.messages[0]?.content)).toContain(
      'Pregunta pendiente: 1 = id 5, 2 = id 4',
    )
    app.close()
  })

  it('a replayed answer applies once: webhook retry, then the sweep re-claiming it', async () => {
    await day()
    const app = await setup({ model: script(ask([5, 4], { after: 'delete' })) })
    await say(app, { text: 'borrá lo del almuerzo' })
    const body = messageBody('wamid.ANS', WA, { text: { body: '1' } })
    await post(app.base, body)
    await until(async () => (await row('wamid.ANS'))?.status === 'done')
    await post(app.base, body)
    await new Promise((r) => setTimeout(r, 150))
    await sql`UPDATE inbound_message SET status = 'pending', send_started_at = NULL, reply_sent_at = NULL WHERE wamid = 'wamid.ANS'`
    await app.processor.sweep()
    expect(await live()).toEqual(['súper 12000', 'café 3500', 'nafta 20000', 'café 2900'])
    expect(app.model.n).toBe(1)
    app.close()
  })

  it('"me equivoqué en uno de los cafés" asks which, listing them newest first, and what to change', async () => {
    await day()
    const app = await setup({ model: script(ask([4, 2], { question: 'Cuál café y qué cambio' })) })
    expect(await say(app, { text: 'me equivoqué en uno de los cafés' })).toBe(
      '¿Cuál café y qué cambio? 1. Café $2.900 · 2. Café $3.500\nRespondé con el número y el cambio, por ejemplo "el 1 fue 4100".',
    )
    expect(await live()).toHaveLength(5)
    app.close()
  })
})

describe('summarize', () => {
  const OCT = { on: '2025-10-03' }

  it('equals an independent SQL sum, with every filter applied', async () => {
    await seed([
      { ...OCT, amount: '12000', category: 'supermercado', payment: 'crédito visa' },
      { ...OCT, amount: '4500.50', category: 'supermercado', payment: 'Débito' },
      { on: TODAY, amount: '8000', category: 'supermercado', payment: null },
      { ...OCT, amount: '999', category: 'restaurantes' },
      { on: '2025-09-30', amount: '777', category: 'supermercado' }, // last month
      { ...OCT, amount: '555', category: 'supermercado', direction: 'in' },
      { ...OCT, amount: '33', category: 'supermercado', currency: 'USD' },
    ])
    const app = await setup({
      model: script(
        summarize('this_month', { category: 'supermercado' }),
        summarize('this_month', { category: 'supermercado', payment: 'CREDITO' }),
      ),
    })
    const reply = await say(app)
    const expected = await sum(
      `direction = 'out' AND currency = 'ARS' AND category = 'supermercado' AND occurred_on BETWEEN '2025-10-01' AND '2025-10-31'`,
    )
    expect(expected).toBe('24500.50')
    expect(reply).toBe(
      'Este mes gastaste $24.500,50 en Súper (3 movimientos).\nY US$ 33 (1 movimiento).',
    )
    expect(await say(app)).toBe('Este mes gastaste $12.000 en Súper con CREDITO (1 movimiento).')
    expect((await row(lastWamid))?.action).toBe('summarize')
    app.close()
  })

  it('matches the payment without caring for case or accents', async () => {
    await seed([
      { ...OCT, amount: '100', payment: 'Crédito Visa' },
      { ...OCT, amount: '200', payment: 'credito visa' },
      { ...OCT, amount: '400', payment: 'crédito amex' },
      { ...OCT, amount: '800', payment: null },
    ])
    const app = await setup({
      model: script(
        summarize('this_month', { payment: 'crédito VISA' }),
        summarize('this_month', { payment: 'CRÉDITO' }),
        summarize('this_month', { payment: 'mp' }),
      ),
    })
    expect(await say(app)).toBe('Este mes gastaste $300 con crédito VISA (2 movimientos).')
    expect(await say(app)).toBe('Este mes gastaste $700 con CRÉDITO (3 movimientos).')
    expect(await say(app)).toBe('No encontré gastos este mes con mp.')
    app.close()
  })

  it('keeps USD apart from ARS and never converts', async () => {
    await seed([
      { ...OCT, amount: '1000' },
      { ...OCT, amount: '2000.5' },
      { ...OCT, amount: '50', currency: 'USD' },
      { ...OCT, amount: '25.25', currency: 'USD' },
    ])
    const app = await setup({ model: script(summarize('this_month')) })
    expect(await say(app)).toBe(
      'Este mes gastaste $3.000,50 (2 movimientos).\nY US$ 75,25 (2 movimientos).',
    )
    expect(await sum(`currency = 'USD'`)).toBe('75.25')
    expect(await sum(`currency = 'ARS'`)).toBe('3000.5')
    app.close()
  })

  it('leaves a deleted movement out of the totals, and a superseded one for its replacement', async () => {
    const app = await setup({
      model: script(
        logOf(movement({ amount: '1000' }), movement({ amount: '2000', description: 'súper' })),
        summarize('this_month'),
        correct(2, { amount: '2500' }),
        summarize('this_month'),
        remove(3),
        summarize('this_month'),
      ),
    })
    await say(app)
    expect(await say(app)).toBe('Este mes gastaste $3.000 (2 movimientos).')
    await say(app)
    expect(await say(app)).toBe('Este mes gastaste $3.500 (2 movimientos).')
    await say(app)
    expect(await say(app)).toBe('Este mes gastaste $1.000 (1 movimiento).')
    expect(await sum('superseded_by IS NULL AND deleted_at IS NULL')).toBe('1000')
    expect(await history()).toHaveLength(3) // nothing was removed
    app.close()
  })

  it('counts only the asking account', async () => {
    await seed([{ ...OCT, amount: '1000' }])
    const [other] = await sql`INSERT INTO account (wa_id) VALUES ('5491199999999') RETURNING id`
    const [inbound] =
      await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload) VALUES ('seed.other', '5491199999999', 'text', 'x', '{}'::jsonb) RETURNING id`
    await sql`INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency, occurred_on, description, category, confidence)
      VALUES (${other?.id}, ${inbound?.id}, 0, 'out', 77, 'ARS', '2025-10-03', 'ajeno', 'otros', 'high')`
    const app = await setup({ model: script(summarize('this_month')) })
    expect(await say(app)).toBe('Este mes gastaste $1.000 (1 movimiento).')
    app.close()
  })
})

describe('periods in Argentine time', () => {
  // One movement per boundary day, each amount a power of two, so a total names exactly its set.
  const days: [string, string][] = [
    ['2025-12-31', '1'],
    ['2026-01-01', '2'],
    ['2026-10-31', '4'],
    ['2026-11-22', '8'], // Sunday
    ['2026-11-23', '16'], // Monday
    ['2026-11-29', '32'], // Sunday
    ['2026-11-30', '64'], // Monday
    ['2026-12-01', '128'],
    ['2026-12-06', '256'], // Sunday
  ]
  // 23:30 on Nov 30 in Buenos Aires is already Dec 1 in UTC; 00:30 on Dec 1 is the next Argentine day.
  const cases: [string, string, Record<string, string>][] = [
    [
      'the last evening of November (02:30 UTC on Dec 1)',
      '2026-12-01T02:30:00Z',
      {
        today: '$64',
        yesterday: '$32',
        this_week: '$448',
        last_week: '$48',
        this_month: '$120',
        last_month: '$4',
        this_year: '$510',
      },
    ],
    [
      'the first night of December (03:30 UTC on Dec 1)',
      '2026-12-01T03:30:00Z',
      {
        today: '$128',
        yesterday: '$64',
        this_week: '$448',
        last_week: '$48',
        this_month: '$384',
        last_month: '$120',
        this_year: '$510',
      },
    ],
  ]

  for (const [label, at, expected] of cases) {
    it(`${label}: every period counts its own days`, async () => {
      await seed(days.map(([on, amount]) => ({ on, amount })))
      const periods = Object.keys(expected)
      const app = await setup({ model: script(...periods.map((p) => summarize(p))) })
      for (const period of periods) {
        expect(await say(app, { at }), `${period} ${label}`).toContain(
          ` gastaste ${expected[period]} (`,
        )
      }
      app.close()
    })
  }

  it('the independent SQL sums agree with the literals above', async () => {
    await seed(days.map(([on, amount]) => ({ on, amount })))
    expect(await sum(`occurred_on BETWEEN '2026-11-01' AND '2026-11-30'`)).toBe('120')
    expect(await sum(`occurred_on BETWEEN '2026-11-30' AND '2026-12-06'`)).toBe('448')
    expect(await sum(`occurred_on BETWEEN '2026-01-01' AND '2026-12-31'`)).toBe('510')
  })
})

describe('the lane and the context', () => {
  it('a correction sent while an earlier message is still being worked on waits for it and sees its movement', async () => {
    // "nafta 20000" is stored, "café 3500" is still being worked on, "uy, era 3800" must fix the café.
    const hold = gate()
    const app = await setup({
      model: fakeModel(async (_s, { n, params }) => {
        if (n === 1)
          return [
            logOf(movement({ description: 'nafta', amount: '20000', category: 'combustible' })),
          ]
        if (n === 2) {
          await hold.promise
          return [logOf(movement())]
        }
        expect(String(params.messages[0]?.content)).toContain('1. id=2 out 3500 ARS')
        return [correct(2, { amount: '3800' })]
      }),
    })
    await say(app)
    await post(app.base, messageBody('wamid.CAFE', WA))
    await until(() => app.model.n === 2)
    await post(app.base, messageBody('wamid.ERA', WA))
    await new Promise((r) => setTimeout(r, 150))
    expect(app.model.n).toBe(2) // the correction has not started: it queues behind the café
    hold.open()
    await until(async () => (await row('wamid.ERA'))?.status === 'done')
    expect(bodies(app.calls)[2]).toBe('✓ Corregido: Café $3.800 (antes $3.500)')
    expect(await live()).toEqual(['nafta 20000', 'café 3800'])
    app.close()
  })

  it("the sender's next message starts once the previous one is stored, not after its send", async () => {
    const sendHold = gate()
    const fake = fakeGraph({
      send: async (n) => {
        if (n === 1) await sendHold.promise
        return `wamid.OUT${n}`
      },
    })
    const app = await setup({ fake, model: fakeModel(() => [logOf(movement())]) })
    await post(app.base, messageBody('wamid.B1', WA))
    await until(async () => (await row('wamid.B1'))?.reply_text != null)
    await post(app.base, messageBody('wamid.B2', WA))
    await until(() => app.model.n === 2)
    expect((await row('wamid.B1'))?.reply_sent_at ?? null).toBeNull()
    sendHold.open()
    await until(async () => (await row('wamid.B2'))?.status === 'done')
    app.close()
  })

  it('different senders do not wait for each other', async () => {
    const hold = gate()
    const app = await setup({
      model: fakeModel(async () => {
        await hold.promise
        return [logOf(movement())]
      }),
    })
    await post(app.base, messageBody('wamid.S1', '5491100000001'))
    await post(app.base, messageBody('wamid.S2', '5491100000002'))
    await until(() => app.model.n === 2)
    hold.open()
    await until(
      async () => (await sql`SELECT 1 FROM inbound_message WHERE status = 'done'`).length === 2,
    )
    app.close()
  })

  it('shows the model the newest 10 live movements with their ids, a corrected one counting as new', async () => {
    await seed(
      Array.from({ length: 12 }, (_, k) => ({
        on: TODAY,
        amount: String(100 + k),
        description: `m${k}`,
        at: '10:00',
      })),
    )
    const app = await setup({
      model: script(replyCall('help'), correct(12, { amount: '999' }), replyCall('help')),
    })
    await say(app)
    const list = (i: number) =>
      String(app.requests[i]?.messages[0]?.content)
        .split('\n')
        .filter((l) => /^\d+\. id=/.test(l))
    expect(list(0)).toHaveLength(10)
    expect(list(0)[0]).toContain('1. id=12 ')
    expect(list(0)[9]).toContain('10. id=3 ')
    await say(app) // m11 (id 12) is corrected: its new row is the newest
    await say(app)
    expect(list(2)[0]).toContain('1. id=13 out 999 ARS')
    expect(list(2)[1]).toContain('2. id=11 ')
    app.close()
  })

  it('puts the conversation window in the context: the last 6 turns of the last 30 minutes, answered ones only', async () => {
    const app = await setup({ model: fakeModel(() => [replyCall('help')]) })
    for (const k of [1, 2, 3, 4, 5, 6, 7]) await say(app, { text: `mensaje ${k}` })
    await sql`UPDATE inbound_message SET received_at = now() - interval '40 minutes' WHERE body = 'mensaje 1'`
    await sql`UPDATE inbound_message SET received_at = now() - interval '5 minutes' WHERE body = 'mensaje 6'`
    await sql`UPDATE inbound_message SET reply_text = NULL WHERE body = 'mensaje 3'` // failed: no reply
    await say(app, { text: 'ahora' })
    const context = String(app.requests.at(-1)?.messages[0]?.content)
    const turns = [...context.matchAll(/\(persona, hace (\d+) min\) (.*)/g)].map((m) => [
      m[1],
      m[2],
    ])
    expect(turns.map((t) => t[1])).toEqual([
      'mensaje 2',
      'mensaje 4',
      'mensaje 5',
      'mensaje 6',
      'mensaje 7',
    ])
    expect(context).toContain('(Warren) Mandame un gasto')
    expect(context).not.toContain('mensaje 1')
    expect(context).not.toContain('mensaje 3')
    expect(turns.find((t) => t[1] === 'mensaje 6')?.[0]).toBe('5')
    app.close()
  })
})
