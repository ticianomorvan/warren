import { describe, expect, it } from 'vitest'
import {
  ask,
  correct,
  history,
  insist,
  logOf,
  movement,
  remove,
  replyCall,
  script,
  seed,
  summarize,
  undoCall,
  WA,
} from './command-fixtures'
import { execute } from './execute'
import { queryTotals, recentMovements } from './ledger'
import { REPLY_UNDO_EXPIRED, REPLY_UNDO_NOTHING } from './render'
import { undoRequest } from './resolve'
import {
  bodies,
  fakeGraph,
  fakeTranscriber,
  heard,
  messageBody,
  OGG,
  post,
  row,
  setup,
  sql,
  TODAY,
  until,
  useDatabase,
  voiceBody,
} from './test-harness'

useDatabase()

const OTHER = '5491100000001'
const cafe = (amount = '3500') => movement({ amount })
const super_ = movement({ description: 'súper', amount: '5000', category: 'supermercado' })
const panaderia = movement({ description: 'panadería', amount: '3000' })

type App = Awaited<ReturnType<typeof setup>>

/** One message from a sender in, waits until it is committed and answered. Returns the reply. */
let n = 0
async function send(app: App, text: string, from = WA): Promise<string> {
  const wamid = `wamid.UNDO${++n}`
  const before = app.calls.sent.length
  await post(app.base, messageBody(wamid, from, { text: { body: text } }))
  await until(async () => ['done', 'failed'].includes(String((await row(wamid))?.status)))
  return bodies(app.calls)[before] ?? ''
}
const lastMessage = async () =>
  (
    await sql`SELECT id::int AS id, action, undoes::int AS undoes, model_turns, reply_text
      FROM inbound_message ORDER BY id DESC LIMIT 1`
  )[0]

/** Every movement row with its links, oldest first. */
const rows = () =>
  sql`SELECT id::int AS id, description, amount::text AS amount, inbound_message_id::int AS inbound,
    position, superseded_by::int AS superseded_by, deleted_at IS NOT NULL AS deleted,
    deleted_by::int AS deleted_by, restores::int AS restores, created_at, confidence
    FROM movement ORDER BY id`

/**
 * What the ledger must show now, as "description amount", checked three ways against SQL written another way:
 * the live rows (by `deleted_by`, not `deleted_at`), the recent list, and the sum and count of every period.
 */
async function expectLive(expected: string[]) {
  const independent = await sql`
    SELECT description, amount::text AS amount, sum(amount) OVER ()::text AS total, count(*) OVER ()::int AS n
    FROM movement WHERE superseded_by IS NULL AND deleted_by IS NULL ORDER BY id`
  expect(independent.map((r) => `${r.description} ${r.amount}`)).toEqual(expected)
  const [account] = await sql`SELECT id::int AS id FROM account WHERE wa_id = ${WA}`
  const recent = await recentMovements(sql, account?.id ?? 0)
  expect(recent.map((r) => `${r.description} ${r.amount}`).reverse()).toEqual(expected)
  const totals = await queryTotals(sql, account?.id ?? 0, {
    direction: null,
    category: null,
    payment: null,
    description: null,
    range: { from: '2000-01-01', to: '2100-01-01' },
  })
  const [first] = independent
  expect(totals.reduce((s, t) => s + t.count, 0)).toBe(expected.length)
  expect(totals[0]?.total ?? null).toBe(first ? (first.total as string) : null)
}

/** The batch looks 25 hours old: the message that made it was received then. */
const age = (id: number, hours: number) =>
  sql`UPDATE inbound_message SET received_at = now() - make_interval(hours => ${hours}) WHERE id = ${id}`

describe('undo of a log', () => {
  it('takes back one log, in code with no model call, as a recorded batch', async () => {
    const app = await setup({ model: script(logOf(cafe())) })
    await send(app, 'café 3500')
    const before = await rows()
    const reply = await send(app, 'deshacer')
    expect(reply).toBe('↩︎ Deshice: Café $3.500')
    expect(app.model.n).toBe(1) // only the log called the model
    const [log, undo] = await sql`SELECT id::int AS id FROM inbound_message ORDER BY id`
    expect(await lastMessage()).toMatchObject({
      action: 'undo',
      undoes: log?.id,
      model_turns: 0,
    })
    // Append-only: the same row, now stamped deleted by the undo message; nothing else changed.
    expect(await rows()).toEqual([{ ...before[0], deleted: true, deleted_by: undo?.id }])
    await expectLive([])
    app.close()
  })

  it('takes back every movement one message logged, as one step', async () => {
    const app = await setup({ model: script(logOf(super_, panaderia), logOf(cafe())) })
    await send(app, 'super 5000 y panaderia 3000')
    await send(app, 'café 3500')
    await expectLive(['súper 5000', 'panadería 3000', 'café 3500'])
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice: Café $3.500')
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice: Súper $5.000 · Panadería $3.000')
    const all = await rows()
    expect(all.filter((r) => r.deleted)).toHaveLength(3)
    expect(new Set(all.filter((r) => r.deleted).map((r) => r.deleted_by)).size).toBe(2)
    await expectLive([])
    app.close()
  })
})

describe('undo of a correction', () => {
  it('puts the old values back as a new row and keeps the whole chain', async () => {
    const app = await setup({ model: script(logOf(cafe()), correct(1, { amount: '3800' })) })
    await send(app, 'café 3500')
    await send(app, 'no, el café fue 3800')
    await expectLive(['café 3800'])
    const reply = await send(app, 'deshacer')
    expect(reply).toBe('↩︎ Deshice:\n• Café $3.500 (estaba $3.800)')
    const [original, corrected, restored] = await rows()
    expect(original).toMatchObject({ amount: '3500', superseded_by: corrected?.id, deleted: false })
    expect(corrected).toMatchObject({ amount: '3800', superseded_by: restored?.id })
    expect(restored).toMatchObject({ amount: '3500', superseded_by: null, deleted: false })
    // The restored row is the movement as first logged: same logged time, and made by the undo message.
    expect(restored?.created_at).toEqual(original?.created_at)
    expect(restored?.inbound).toBe((await lastMessage())?.id)
    await expectLive(['café 3500'])
    app.close()
  })
})

describe('undo of a delete', () => {
  it('brings the movement back as a new row and keeps the deleted one deleted', async () => {
    const app = await setup({ model: script(logOf(cafe()), remove(1)) })
    await send(app, 'café 3500')
    await send(app, 'borrá el café')
    await expectLive([])
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice:\n• Volvió Café $3.500')
    const [original, back] = await rows()
    expect(original).toMatchObject({ amount: '3500', deleted: true, superseded_by: null })
    expect(back).toMatchObject({ amount: '3500', deleted: false, restores: original?.id })
    expect(back?.created_at).toEqual(original?.created_at)
    await expectLive(['café 3500'])
    app.close()
  })
})

describe('undo of a mixed batch', () => {
  it('reverts a log, a correction and a delete of one message together', async () => {
    const [a, b] = await seed([
      { on: TODAY, amount: '12000', description: 'súper', category: 'supermercado', at: '09:12' },
      { on: TODAY, amount: '3500', description: 'café', category: 'restaurantes', at: '10:10' },
    ])
    const app = await setup({
      model: script([
        correct(b ?? 0, { amount: '4100' }),
        remove(a ?? 0),
        logOf(movement({ description: 'subte', amount: '1200', category: 'transporte' })),
      ]),
    })
    await send(app, 'cambiá el café a 4100, borrá el súper y anotá subte 1200')
    await expectLive(['café 4100', 'subte 1200'])
    const reply = await send(app, 'deshacer')
    expect(reply).toBe(
      [
        '↩︎ Deshice:',
        '• Café $3.500 (estaba $4.100)',
        '• Quité Subte $1.200',
        '• Volvió Súper $12.000',
      ].join('\n'),
    )
    // Every step is a row of the undo message, with its own position, and no row was removed or rewritten.
    const undo = (await lastMessage())?.id
    const made = (await rows()).filter((r) => r.inbound === undo)
    expect(made.map((r) => r.position)).toEqual([0, 1])
    await expectLive(['café 3500', 'súper 12000'])
    app.close()
  })
})

describe('a second undo', () => {
  it('undoes the batch before, never redoes, and says there is nothing when it runs out', async () => {
    const app = await setup({
      model: script(logOf(cafe()), logOf(super_), correct(2, { amount: '5500' })),
    })
    await send(app, 'café 3500')
    await send(app, 'super 5000')
    await send(app, 'el súper fue 5500')
    await expectLive(['café 3500', 'súper 5500'])
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice:\n• Súper $5.000 (estaba $5.500)')
    await expectLive(['café 3500', 'súper 5000'])
    // The second one reaches the log of the súper, which stands behind an undone correction (a chain of three rows).
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice: Súper $5.000')
    await expectLive(['café 3500'])
    expect(await send(app, 'volvé atrás')).toBe('↩︎ Deshice: Café $3.500')
    await expectLive([])
    expect(await send(app, 'deshacer')).toBe(REPLY_UNDO_NOTHING)
    expect(await send(app, 'deshacer')).toBe(REPLY_UNDO_NOTHING)
    await expectLive([])
    // Each undo message undid a different batch.
    const undone =
      await sql`SELECT undoes::int AS undoes FROM inbound_message WHERE undoes IS NOT NULL ORDER BY id`
    expect(new Set(undone.map((u) => u.undoes)).size).toBe(3)
    app.close()
  })

  it('does not undo an undo: a log after it is what the next one takes back', async () => {
    const app = await setup({ model: script(logOf(cafe()), logOf(super_)) })
    await send(app, 'café 3500')
    await send(app, 'deshacer')
    await send(app, 'super 5000')
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice: Súper $5.000')
    expect(await send(app, 'deshacer')).toBe(REPLY_UNDO_NOTHING) // the café was undone first
    await expectLive([])
    app.close()
  })
})

describe('the guard', () => {
  it('refuses when a movement changed after the batch, touches nothing and says which', async () => {
    const app = await setup({ model: script(logOf(cafe())) })
    await send(app, 'café 3500')
    const [log] = await sql`SELECT id::int AS id FROM movement`
    // Changed outside any batch (by hand, or by a message that is not a committed batch): the batch is not as it left it.
    const [seeded] = await seed([
      { on: TODAY, amount: '3900', description: 'café', category: 'restaurantes' },
    ])
    await sql`UPDATE movement SET superseded_by = ${seeded ?? 0} WHERE id = ${log?.id ?? 0}`
    const before = await rows()
    const reply = await send(app, 'deshacer')
    expect(reply).toBe('No deshice nada: Café $3.500 cambió después. Decime qué querés cambiar.')
    expect(await rows()).toEqual(before)
    expect((await lastMessage())?.undoes).toBeNull()
    app.close()
  })

  it('is all or nothing: one moved movement stops the whole batch', async () => {
    const app = await setup({ model: script(logOf(super_, panaderia)) })
    await send(app, 'super 5000 y panaderia 3000')
    const [first] = await sql`SELECT id::int AS id FROM movement ORDER BY id`
    const [seeded] = await seed([
      { on: TODAY, amount: '5100', description: 'súper', category: 'supermercado' },
    ])
    await sql`UPDATE movement SET superseded_by = ${seeded ?? 0} WHERE id = ${first?.id ?? 0}`
    const before = await rows()
    expect(await send(app, 'deshacer')).toContain('No deshice nada: Súper $5.000')
    expect(await rows()).toEqual(before)
    app.close()
  })

  it('walks back through the undo of a delete to the log behind it', async () => {
    const app = await setup({ model: script(logOf(cafe()), remove(1)) })
    await send(app, 'café 3500')
    await send(app, 'borrá el café')
    // The delete is the last batch: undoing it brings the café back, and the next undo reaches the log, through the restore.
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice:\n• Volvió Café $3.500')
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice: Café $3.500')
    await expectLive([])
    app.close()
  })

  it('refuses a batch whose movement a message that was never undone deleted', async () => {
    const app = await setup({ model: script(logOf(cafe())) })
    await send(app, 'café 3500')
    const [log] = await sql`SELECT id::int AS id FROM movement`
    const [by] = await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status)
      VALUES ('manual.1', ${WA}, 'text', 'x', '{}'::jsonb, 'done') RETURNING id::int AS id`
    await sql`UPDATE movement SET deleted_at = now(), deleted_by = ${by?.id ?? 0} WHERE id = ${log?.id ?? 0}`
    expect(await send(app, 'deshacer')).toBe(
      'No deshice nada: Café $3.500 cambió después. Decime qué querés cambiar.',
    )
    app.close()
  })
})

describe('whose batch', () => {
  it("never undoes another sender's batch, and does not use it up", async () => {
    const app = await setup({ model: script(logOf(cafe()), logOf(super_)) })
    await send(app, 'café 3500')
    const before = await rows()
    // Another person says "deshacer": they have nothing of their own to undo.
    expect(await send(app, 'deshacer', OTHER)).toBe(REPLY_UNDO_NOTHING)
    expect(await rows()).toEqual(before)
    expect(
      (await sql`SELECT count(*)::int AS n FROM inbound_message WHERE undoes IS NOT NULL`)[0]?.n,
    ).toBe(0)
    // And they undo their own, not mine.
    await send(app, 'super 5000', OTHER)
    expect(await send(app, 'deshacer', OTHER)).toBe('↩︎ Deshice: Súper $5.000')
    await expectLive(['café 3500'])
    // Mine is still there to undo.
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice: Café $3.500')
    app.close()
  })
})

describe('the time limit', () => {
  it('refuses past 24 hours, says so and touches nothing', async () => {
    const app = await setup({ model: script(logOf(cafe())) })
    await send(app, 'café 3500')
    const [log] = await sql`SELECT id::int AS id FROM inbound_message ORDER BY id`
    await age(log?.id ?? 0, 25)
    const before = await rows()
    expect(await send(app, 'deshacer')).toBe(REPLY_UNDO_EXPIRED)
    expect(await rows()).toEqual(before)
    expect((await lastMessage())?.undoes).toBeNull()
    app.close()
  })

  it('still undoes at 23 hours', async () => {
    const app = await setup({ model: script(logOf(cafe())) })
    await send(app, 'café 3500')
    const [log] = await sql`SELECT id::int AS id FROM inbound_message ORDER BY id`
    await age(log?.id ?? 0, 23)
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice: Café $3.500')
    app.close()
  })

  it('does not reach past an expired batch for an older one', async () => {
    const app = await setup({ model: script(logOf(cafe()), logOf(super_)) })
    await send(app, 'café 3500')
    await send(app, 'super 5000')
    const [a, b] = await sql`SELECT id::int AS id FROM inbound_message ORDER BY id`
    await age(a?.id ?? 0, 3)
    await age(b?.id ?? 0, 26)
    expect(await send(app, 'deshacer')).toBe(REPLY_UNDO_EXPIRED)
    await expectLive(['café 3500', 'súper 5000'])
    app.close()
  })
})

describe('by voice and by the model', () => {
  it('a spoken "deshacer" goes to the model, never to the code shortcut', async () => {
    const { transcriber } = fakeTranscriber([heard('café 3500'), heard('Deshacer.')])
    const app = await setup({
      transcriber,
      model: script(logOf(cafe()), undoCall),
      fake: fakeGraph({ media: { a1: OGG, a2: OGG } }),
    })
    await post(app.base, voiceBody('wamid.V1', 'a1', WA))
    await until(async () => (await row('wamid.V1'))?.status === 'done')
    await post(app.base, voiceBody('wamid.V2', 'a2', WA))
    await until(async () => (await row('wamid.V2'))?.status === 'done')
    expect(bodies(app.calls).at(-1)).toBe('↩︎ Deshice: Café $3.500')
    expect(app.model.n).toBe(2) // the note of voice called the model
    expect((await row('wamid.V2'))?.model_turns).toBe(1)
    await expectLive([])
    app.close()
  })

  it('a spoken undo with nothing to undo shows what was heard', async () => {
    const { transcriber } = fakeTranscriber(heard('Deshacer.'))
    const app = await setup({
      transcriber,
      model: script(undoCall),
      fake: fakeGraph({ media: { a1: OGG } }),
    })
    await post(app.base, voiceBody('wamid.V3', 'a1', WA))
    await until(async () => (await row('wamid.V3'))?.status === 'done')
    expect(bodies(app.calls).at(-1)).toBe(`🎙️ "Deshacer."\n${REPLY_UNDO_NOTHING}`)
    app.close()
  })

  it('"no, eso no" runs through the model; the model may add words, never a claim of its own', async () => {
    const app = await setup({
      model: script(logOf(cafe()), [{ ...undoCall, input: { text: 'Ok, volvemos atrás.' } }]),
    })
    await send(app, 'café 3500')
    expect(await send(app, 'no, eso no')).toBe('↩︎ Deshice: Café $3.500\nOk, volvemos atrás.')
    app.close()
  })

  it('undo goes alone: sent with a change, the model is told and sends it again', async () => {
    const app = await setup({
      model: script(logOf(cafe()), [undoCall, logOf(super_)], undoCall),
    })
    await send(app, 'café 3500')
    expect(await send(app, 'no, eso no, y anotá un súper 5000')).toBe('↩︎ Deshice: Café $3.500')
    expect(app.model.n).toBe(3)
    await expectLive([])
    app.close()
  })

  it('a text that claims an undo it did not make is dropped', async () => {
    const app = await setup({ model: insist(replyCall('Listo, deshice todo.')) })
    expect(await send(app, 'te pedí que deshagas todo')).not.toContain('deshice')
    app.close()
  })
})

describe('what is not an undo', () => {
  it.each([
    ['deshacer', true],
    ['Deshacé', true],
    ['deshacé lo último', true],
    ['volvé atrás', true],
    ['volver atrás!', true],
    ['anulá lo que hiciste', true],
    ['uy, deshacé eso por favor', true],
    ['no, deshacelo', false], // the model reads it with the conversation
    ['no deshacer', false],
    ['mejor no anular', false],
    ['no revertir', false],
    ['no, no deshacer', false],
    ['deshacé el último', false], // names one movement; a batch may hold several
    ['deshacé el café', false],
    ['deshacé todo', false],
    ['anulá el súper', false],
    ['no, eso no', false], // may answer a question: the model reads it with the conversation
    ['deshacé el café y anotá un súper de 5000', false],
    ['borrá lo último', false],
    ['cuánto gasté', false],
  ])('%s', (text, yes) => {
    expect(undoRequest(text) !== null).toBe(yes)
  })

  it('a typed "deshacer" while a question is open goes to the model, never undoes in code', async () => {
    const app = await setup({
      model: script(
        logOf(cafe()),
        logOf(super_, panaderia),
        ask([2, 3]),
        replyCall('Dale, no borro nada.'),
      ),
    })
    await send(app, 'café 3500')
    await send(app, 'super 5000 y panadería 3000')
    expect(await send(app, 'borrá uno')).toContain('¿Cuál?')
    expect(await send(app, 'deshacer')).toBe('Dale, no borro nada.')
    expect(app.model.n).toBe(4) // went to the model
    await expectLive(['café 3500', 'súper 5000', 'panadería 3000'])
    app.close()
  })

  it('"deshacé el café" is a deletion of that movement, by the model', async () => {
    const app = await setup({ model: script(logOf(cafe()), logOf(super_), remove(1)) })
    await send(app, 'café 3500')
    await send(app, 'super 5000')
    expect(await send(app, 'deshacé el café')).toBe(`✓ Borré: Café $3.500 · ${await timeOf(1)}`)
    expect(app.model.n).toBe(3) // went to the model
    await expectLive(['súper 5000'])
    app.close()
  })
})

const timeOf = async (id: number) =>
  String(
    (
      await sql`SELECT to_char(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI') AS t
        FROM movement WHERE id = ${id}`
    )[0]?.t,
  )

describe('after an undo', () => {
  it('summaries and the recent list match independent SQL, and a later correction finds the restored row', async () => {
    const app = await setup({
      model: script(
        logOf(cafe(), super_),
        correct(2, { amount: '5400' }),
        summarize('today'),
        correct(4, { amount: '5600' }),
      ),
    })
    await send(app, 'café 3500 y súper 5000')
    await send(app, 'el súper fue 5400')
    expect(await send(app, 'deshacer')).toBe('↩︎ Deshice:\n• Súper $5.000 (estaba $5.400)')
    const total = (
      await sql`SELECT sum(amount)::text AS t FROM movement WHERE superseded_by IS NULL AND deleted_by IS NULL`
    )[0]?.t
    expect(total).toBe('8500')
    expect(await send(app, 'cuánto gasté hoy')).toBe('Hoy (9 oct) gastaste $8.500 (2 movimientos).')
    await expectLive(['café 3500', 'súper 5000'])
    // The restored row is live and corrigible, and the chain grows from it.
    const [restored] =
      await sql`SELECT id::int AS id FROM movement WHERE superseded_by IS NULL AND description = 'súper'`
    expect(restored?.id).toBe(4)
    expect(await send(app, 'el súper fue 5600')).toContain(
      '✓ Corregido: Súper $5.600 (antes $5.000)',
    )
    await expectLive(['café 3500', 'súper 5600'])
    app.close()
  })

  it('a long undone batch is held under the WhatsApp limit and says how many are left out', async () => {
    const app = await setup({ model: script(logOf(cafe())) })
    await send(app, 'café 3500')
    // A batch of 300 deleted movements, planted as a committed message that deleted them.
    const [batch] =
      await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, action, reply_text)
      VALUES ('plant.1', ${WA}, 'text', 'x', '{}'::jsonb, 'done', 'multi', 'x') RETURNING id::int AS id`
    const ids = await seed(
      Array.from({ length: 300 }, (_, k) => ({
        on: TODAY,
        amount: String(1000 + k),
        description: `cosa ${k}`,
      })),
    )
    await sql`UPDATE movement SET deleted_at = now(), deleted_by = ${batch?.id ?? 0} WHERE id = ANY(${ids}::bigint[])`
    const reply = await send(app, 'deshacer')
    expect(reply.length).toBeLessThanOrEqual(4000)
    expect(reply.startsWith('↩︎ Deshice:')).toBe(true)
    expect(reply).toMatch(/y \d+ más/)
    expect(
      (await sql`SELECT count(*)::int AS n FROM movement WHERE restores IS NOT NULL`)[0]?.n,
    ).toBe(300)
    app.close()
  })
})

describe('an undo and a correction one after the other', () => {
  /** Runs `execute` for an action in its own transaction, as the commit point does. */
  async function run(inboundWamid: string, calls: Parameters<typeof execute>[1]['actions']) {
    const [account] = await sql`SELECT id::int AS id FROM account`
    const [message] =
      await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, attempts)
      VALUES (${inboundWamid}, ${WA}, 'text', 'x', '{}'::jsonb, 'processing', 1) RETURNING id::int AS id`
    const reply = await (await import('./store'))
      .createStore(sql, { staleMs: 60_000, maxAttempts: 3 })
      .commit({ id: message?.id ?? 0, attempts: 1 } as never, {
        parsed: calls,
        command: calls,
        action: 'multi',
        turns: 1,
        modelMs: 1,
        execute: (tx) =>
          execute(tx, {
            accountId: account?.id ?? 0,
            inboundId: message?.id ?? 0,
            actions: calls,
            audit: [],
            today: TODAY,
            message: '',
            facts: [],
            window: [],
          }),
      })
    return reply
  }

  it('the undo first: the correction finds the movement gone', async () => {
    const app = await setup({ model: script(logOf(cafe())) })
    await send(app, 'café 3500')
    const gone = await run('race.u', [{ tool: 'undo_last', input: { text: null } }])
    expect(gone).toBe('↩︎ Deshice: Café $3.500')
    const reply = await run('race.c', [
      { tool: 'correct_movement', input: { id: 1, changes: { amount: '3800' }, text: null } },
    ])
    expect(reply).toContain('ya fue corregido o borrado')
    expect((await history()).filter((r) => r.superseded_by !== null)).toHaveLength(0)
    app.close()
  })
})

describe('what is kept about an undo', () => {
  it('the audit says what was undone, and the message says which batch it undid', async () => {
    const app = await setup({ model: script(logOf(cafe())) })
    await send(app, 'café 3500')
    await send(app, 'deshacer')
    const [log, undo] = await sql`
      SELECT id::int AS id, tool_calls, action, undoes::int AS undoes FROM inbound_message ORDER BY id`
    expect(undo?.undoes).toBe(log?.id)
    expect(undo?.tool_calls).toMatchObject([
      { tool: 'undo_last', status: 'applied', detail: `undid batch ${log?.id}: logged 1` },
    ])
    app.close()
  })

  it('a refusal is audited with its reason and leaves the message unmarked', async () => {
    const app = await setup({ model: script(logOf(cafe())) })
    await send(app, 'deshacer')
    const [only] = await sql`SELECT tool_calls, undoes::int AS undoes FROM inbound_message`
    expect(only?.undoes).toBeNull()
    expect(only?.tool_calls).toMatchObject([{ tool: 'undo_last', status: 'nothing' }])
    app.close()
  })
})
