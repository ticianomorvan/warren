import { describe, expect, it } from 'vitest'
import {
  ask,
  correct,
  day,
  find,
  history,
  lastWamid,
  live,
  logOf,
  movement,
  remove,
  replyCall,
  say,
  saying,
  script,
  summarize,
  WA,
} from './command-fixtures'
import { REPLY_FAILED, REPLY_SAY_FALLBACK } from './render'
import {
  bodies,
  fakeModel,
  messageBody,
  post,
  row,
  setup,
  sql,
  until,
  useDatabase,
} from './test-harness'

useDatabase()

/** What the last message stored about each tool call. */
const audit = async () =>
  ((await row(lastWamid))?.tool_calls ?? []) as {
    tool: string
    status: string
    text?: string
    textReason?: string
  }[]

describe('the model’s own words', () => {
  it('go after the record of what changed, never instead of it', async () => {
    await day()
    const app = await setup({ model: script(saying(remove(1), 'No encontré la nafta, ¿cuál es?')) })
    const reply = await say(app, { text: 'borra el super y la nafta' })
    expect(reply).toBe(
      '✓ Borré: Súper $12.000 (crédito visa) · 09:12\nNo encontré la nafta, ¿cuál es?',
    )
    expect(await live()).toHaveLength(4)
    expect(await audit()).toMatchObject([
      { tool: 'delete_movement', status: 'applied', text: 'sent' },
    ])
    app.close()
  })

  it('may use a number the person wrote, one the lists show or one in the lines code rendered', async () => {
    await day()
    const app = await setup({
      model: script(
        // 3800 is in the person's message
        saying(correct(2, { amount: '3800' }), 'Listo, el café de las 10 ahora es 3800.'),
        // $2.900 is another movement in the list; 12.000 is in the line code renders for this delete
        saying(remove(1), 'El otro café fue $2.900; el súper era $12.000.'),
      ),
    })
    expect(await say(app, { text: 'el cafe de las 10 fue 3800' })).toContain(
      'Listo, el café de las 10 ahora es 3800.',
    )
    expect(await say(app, { text: 'borra el super' })).toContain(
      'El otro café fue $2.900; el súper era $12.000.',
    )
    app.close()
  })

  it('may use the amount code rendered, which the person wrote another way', async () => {
    await day()
    // "25 lucas" is 25000: the model sends 25000 and code renders $25.000, a figure only the line has
    const app = await setup({
      model: script(saying(correct(3, { amount: '25000' }), 'Quedó en $25.000.')),
    })
    const reply = await say(app, { text: 'la nafta fue 25 lucas' })
    expect(reply).toContain('✓ Corregido: Nafta $25.000')
    expect(reply).toContain('Quedó en $25.000.')
    app.close()
  })

  it('are dropped when they hold a number code did not give: the record is sent alone, and the audit says why', async () => {
    await day()
    const app = await setup({
      model: script(saying(remove(1), 'Borré el súper de $13.000 y ya llevás $15.800 gastados.')),
    })
    const reply = await say(app, { text: 'borra el super' })
    expect(reply).toBe('✓ Borré: Súper $12.000 (crédito visa) · 09:12')
    expect(reply).not.toContain('13.000')
    expect(await live()).toHaveLength(4) // the delete itself still ran
    const [entry] = await audit()
    expect(entry).toMatchObject({ tool: 'delete_movement', status: 'applied', text: 'dropped' })
    expect(entry?.textReason).toBe('number not given by code: $13.000, $15.800'.replaceAll('$', ''))
    // what the model asked for, text included, is kept in `parsed`
    expect((await row(lastWamid))?.parsed[0].input.text).toContain('13.000')
    app.close()
  })

  it('are dropped when written in words, or shaped like a record', async () => {
    await day()
    const app = await setup({
      model: script(
        saying(remove(5), 'Borré doce mil pesos de taxi.'),
        saying(remove(4), '✓ Borré: Café $2.900'),
      ),
    })
    expect(await say(app, { text: 'borra el taxi' })).toBe('✓ Borré: Taxi $5.400')
    expect((await audit())[0]?.textReason).toMatch(/words/)
    expect(await say(app, { text: 'borra el café' })).toBe('✓ Borré: Café $2.900')
    expect((await audit())[0]?.textReason).toMatch(/imitates/)
    app.close()
  })

  it('do not replace the totals: a total the model computed is dropped, the one summarize gives stays', async () => {
    await day()
    const app = await setup({
      model: script(saying(summarize('today'), 'En total $43.300 entre todo.')),
    })
    const reply = await say(app, { text: 'cuanto gaste hoy' })
    expect(reply).toBe('Hoy gastaste $43.800 (5 movimientos).')
    expect((await audit())[0]).toMatchObject({ text: 'dropped' })
    app.close()
  })

  it('follow a question’s options', async () => {
    await day()
    const app = await setup({
      model: script(saying(ask([4, 2], { after: 'delete' }), 'Hay dos cafés.')),
    })
    const reply = await say(app, { text: 'borra el cafe' })
    expect(reply.startsWith('¿Cuál? 1. Café $2.900 · 2. Café $3.500')).toBe(true)
    // "dos" is not a word the person wrote: the question is sent without it
    expect(reply).not.toContain('Hay dos cafés')
    app.close()
  })

  it('answer a question about what Warren did, from the conversation, with no change to the ledger', async () => {
    await day()
    const app = await setup({
      model: script(remove(1), replyCall('Sí, borré el súper de $12.000.')),
    })
    await say(app, { text: 'borra el super' })
    const before = await history()
    const reply = await say(app, { text: 'borraste el super?' })
    expect(reply).toBe('Sí, borré el súper de $12.000.')
    expect(await history()).toEqual(before)
    // the model saw what it answered the first time
    expect(String(app.requests[1]?.messages[0]?.content)).toContain(
      '(Warren) ✓ Borré: Súper $12.000 (crédito visa) · 09:12',
    )
    app.close()
  })

  it('a reply with a number code did not give, or with nothing in it, gets the fallback', async () => {
    await day()
    const app = await setup({
      model: script(replyCall('Borré el súper a las 10:12.'), replyCall('  '), replyCall('Hola')),
    })
    expect(await say(app, { text: 'borraste el super?' })).toBe(REPLY_SAY_FALLBACK)
    expect((await audit())[0]).toMatchObject({ tool: 'reply', text: 'dropped' })
    expect(await say(app, { text: 'y?' })).toBe(REPLY_SAY_FALLBACK)
    expect((await audit())[0]).toMatchObject({
      tool: 'reply',
      text: 'dropped',
      textReason: 'empty',
    })
    expect(await say(app, { text: 'hola' })).toBe('Hola')
    app.close()
  })

  it('a reply may quote a time that is in the conversation, and nothing else', async () => {
    await day()
    const app = await setup({
      model: script(
        remove(1),
        replyCall('Sí, el súper de las 09:12.'),
        replyCall('Sí, el súper de las 09:13.'),
      ),
    })
    await say(app, { text: 'borra el super' })
    expect(await say(app, { text: 'lo borraste?' })).toBe('Sí, el súper de las 09:12.')
    expect(await say(app, { text: 'seguro?' })).toBe(REPLY_SAY_FALLBACK)
    app.close()
  })

  it('may sit beside a log, and beside several actions, each text once', async () => {
    const app = await setup({
      model: script([
        saying(logOf(movement()), 'No anoté el helado: no dijiste cuánto fue.'),
        saying(
          logOf(movement({ description: 'subte', amount: '800' })),
          'No anoté el helado: no dijiste cuánto fue.',
        ),
      ]),
    })
    const reply = await say(app, { text: 'café 3500, subte 800 y un helado' })
    expect(reply).toBe('✓ Café $3.500\n✓ Subte $800\nNo anoté el helado: no dijiste cuánto fue.')
    app.close()
  })
})

describe('the model’s words beside an action that did not apply', () => {
  it('are dropped: the record says it was already corrected or deleted', async () => {
    await day()
    // The súper is deleted by another message while this one is with the model.
    const app = await setup({
      model: fakeModel(async () => {
        await sql`UPDATE movement SET deleted_at = now(), deleted_by = (SELECT id FROM inbound_message LIMIT 1) WHERE id = 1`
        return [
          saying(remove(1), 'Listo, lo borré.'),
          saying(correct(2, { amount: '3500' }), 'Corregido.'),
        ]
      }),
    })
    const reply = await say(app, { text: 'borra el super y el cafe fue 3500' })
    expect(reply).toBe(
      'Ese movimiento ya fue corregido o borrado. Fijate cómo quedó y mandame de nuevo qué querés cambiar.\nYa figura así: Café $3.500',
    )
    expect(await audit()).toMatchObject([
      { status: 'gone', text: 'dropped', textReason: 'its action was gone' },
      { status: 'unchanged', text: 'dropped', textReason: 'its action was unchanged' },
    ])
    app.close()
  })
})

describe('a turn that mixes a search with changes (live message 48)', () => {
  it('runs the search, holds the changes, and then does every part: the delete and the correction', async () => {
    await day()
    const app = await setup({
      model: script(
        // the model writes the correction and the search together: nothing runs yet
        [find({ text: 'super' }), correct(3, { amount: '4000' })],
        [remove(1), correct(3, { amount: '4000' })],
      ),
    })
    const reply = await say(app, { text: 'borra el super y la nafta fue 4000' })
    expect(reply).toBe(
      '✓ Borré: Súper $12.000 (crédito visa) · 09:12\n✓ Corregido: Nafta $4.000 (efectivo) (antes $20.000) · 10:45',
    )
    expect(app.model.n).toBe(2)
    expect(await live()).toEqual(['café 3500', 'café 2900', 'taxi 5400', 'nafta 4000'])
    const stored = await row(lastWamid)
    expect(stored).toMatchObject({ action: 'multi', model_turns: 2, status: 'done' })
    expect(
      ((stored?.tool_calls ?? []) as { tool: string; status: string }[]).map((c) => [
        c.tool,
        c.status,
      ]),
    ).toEqual([
      ['find_movements', 'ok'],
      ['correct_movement', 'held'],
      ['delete_movement', 'applied'],
      ['correct_movement', 'applied'],
    ])
    // the second turn told the model its changes were not run
    const second = JSON.stringify(app.requests[1]?.messages.at(-1))
    expect(second).toContain('Your changes were not run; send every change again')
    app.close()
  })

  it('says what it could not do: the part it did not find goes in the text, the rest still runs', async () => {
    await day()
    const app = await setup({
      model: script(
        [find({ text: 'alquiler' }), correct(3, { amount: '4000' })],
        [saying(correct(3, { amount: '4000' }), 'No encontré el alquiler.')],
      ),
    })
    const reply = await say(app, { text: 'borra el alquiler y la nafta fue 4000' })
    expect(reply).toBe(
      '✓ Corregido: Nafta $4.000 (efectivo) (antes $20.000) · 10:45\nNo encontré el alquiler.',
    )
    expect(await live()).toContain('nafta 4000')
    app.close()
  })

  it('a model that keeps mixing ends in the failure notice with nothing written, and the audit keeps what it tried', async () => {
    await day()
    const mixed = [find({ text: 'super' }), remove(1)]
    const app = await setup({ model: script(mixed, mixed, mixed) })
    await post(app.base, messageBody('wamid.MIX', WA))
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    expect(await live()).toHaveLength(5)
    const stored = await row('wamid.MIX')
    expect(stored).toMatchObject({ status: 'failed', model_turns: 3, reply_text: null })
    expect(((stored?.tool_calls ?? []) as { status: string }[]).map((c) => c.status)).toEqual([
      'ok',
      'held',
      'ok',
      'held',
      'ok',
      'held',
    ])
    app.close()
  })
})

describe('a question that expired', () => {
  const asked = async (app: Awaited<ReturnType<typeof setup>>, minutesAgo: number) => {
    await say(app, { text: 'uno de los cafés estaba mal' })
    await sql`UPDATE inbound_message SET received_at = now() - make_interval(mins => ${minutesAgo}) WHERE wamid = ${lastWamid}`
  }

  it('is marked as expired in the context, so "borrá el 2" is a position of the list again', async () => {
    await day()
    const app = await setup({ model: script(ask([4, 2]), remove(4)) })
    await asked(app, 14)
    await say(app, { text: 'borrá el 2' })
    const context = String(app.requests[1]?.messages[0]?.content)
    expect(context).toContain('(Warren) ¿Cuál? 1. Café $2.900 · 2. Café $3.500')
    expect(context).toContain('pregunta vencida')
    // no pending question either: the number is not an answer
    expect(context).not.toContain('Pregunta pendiente')
    expect(await live()).toEqual(['súper 12000', 'café 3500', 'nafta 20000', 'taxi 5400'])
    app.close()
  })

  it('is not marked while it can still be answered', async () => {
    await day()
    const app = await setup({ model: script(ask([4, 2], { after: 'none' }), remove(4)) })
    await asked(app, 3)
    await say(app, { text: 'el 2 fue 4100' })
    const context = String(app.requests[1]?.messages[0]?.content)
    expect(context).not.toContain('pregunta vencida')
    expect(context).toContain('Pregunta pendiente')
    app.close()
  })
})
