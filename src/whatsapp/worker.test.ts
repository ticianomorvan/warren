import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { message } from '../../test/fakes'
import {
  bodies,
  cafe,
  count,
  doneCount,
  fakeGraph,
  fakeModel,
  forgetAll,
  gate,
  logCall,
  messageBody,
  movement,
  movements,
  post,
  replyCall,
  row,
  script,
  seed,
  seedMovements,
  settle,
  setup,
  sql,
  until,
  useDatabase,
  WA,
} from '../test-harness'
import { GraphError } from './graph'
import { REPLY_FAILED, REPLY_INTERIM } from './replies'

useDatabase()

const RECORD = '✓ Café $3.500 (visa)'

/** Runs `fn` with a trigger on `turn` in place, whatever it does inside the commit transaction; removes it after. */
async function withTurnTrigger(body: string, fn: () => Promise<void>) {
  await sql.unsafe(
    `CREATE FUNCTION slow_turn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`,
  )
  await sql.unsafe(
    'CREATE TRIGGER slow_turn BEFORE INSERT ON turn FOR EACH ROW EXECUTE FUNCTION slow_turn()',
  )
  try {
    await fn()
  } finally {
    await sql.unsafe('DROP TRIGGER slow_turn ON turn; DROP FUNCTION slow_turn()')
  }
}

describe('recovery', () => {
  it('a crash after the 200 leaves the row open and the sweep replies exactly once', async () => {
    const app = await setup()
    await seed('wamid.G')
    await seed(
      'wamid.H',
      "status = 'processing', attempts = 1, claimed_at = now() - interval '5 minutes'",
      '5491155550001',
    )
    expect(await app.worker.sweep()).toBe(2) // two senders
    expect(await app.worker.sweep()).toBe(0)
    expect(app.calls.sent).toHaveLength(2)
    expect((await sql`SELECT status FROM wa_message`).every((r) => r.status === 'done')).toBe(true)
    app.close()
  })

  it('killed between a successful send and the commit: unknown, never sent again', async () => {
    const app = await setup()
    await seed(
      'wamid.I',
      "status = 'processing', attempts = 1, claimed_at = now() - interval '5 minutes', send_started_at = now() - interval '5 minutes'",
    )
    await app.worker.sweep()
    await app.worker.sweep()
    expect(app.calls.sent).toHaveLength(0)
    const r = await row('wamid.I')
    expect(r?.status).toBe('unknown')
    expect(r?.error).toContain('unknown')
    app.close()
  })

  it('an abort after Meta accepted the message is unknown and is not retried', async () => {
    const fake = fakeGraph({
      send: async () => {
        throw new DOMException('timeout', 'TimeoutError')
      },
    })
    const app = await setup({ fake })
    await post(app.base, messageBody('wamid.J'))
    await settle()
    expect((await row('wamid.J'))?.status).toBe('unknown')
    await app.worker.sweep()
    expect(fake.calls.attempts).toBe(1)
    app.close()
  })

  it('a 5xx or a 200 without an id on send is unknown, not retried', async () => {
    const fake = fakeGraph({
      send: async (n) => {
        throw n === 1 ? new GraphError(503, 'unavailable') : new GraphError(200, 'no message id')
      },
    })
    const app = await setup({ fake })
    await post(app.base, messageBody('wamid.K1'))
    await post(app.base, messageBody('wamid.K2'))
    await settle()
    expect((await row('wamid.K1'))?.status).toBe('unknown')
    expect((await row('wamid.K2'))?.status).toBe('unknown')
    await app.worker.sweep()
    expect(fake.calls.attempts).toBe(2)
    // The movements exist: a send that ends unknown does not undo the commit.
    expect(await movements()).toHaveLength(2)
    app.close()
  })

  it('a rate limit (4xx) proves nothing was sent: retried, then succeeds', async () => {
    const fake = fakeGraph({
      send: async (n) => {
        if (n === 1) throw new GraphError(400, 'pair rate limit', 131056)
        return 'wamid.OUTX'
      },
    })
    const app = await setup({ fake })
    await post(app.base, messageBody('wamid.L'))
    await settle()
    expect(await row('wamid.L')).toMatchObject({ status: 'pending', send_started_at: null })
    await app.worker.sweep()
    expect(await row('wamid.L')).toMatchObject({ status: 'done', attempts: 2 })
    expect(fake.calls.sent).toHaveLength(1)
    // The agent ran once: the retry sent the stored reply.
    expect(app.model.n).toBe(1)
    expect(await movements()).toHaveLength(1)
    app.close()
  })

  it('a permanent error code fails at once; an auth error (190) is retried', async () => {
    const fake = fakeGraph({
      send: async (n) => {
        throw n === 1
          ? new GraphError(400, 'not allowed', 131026)
          : new GraphError(401, 'token', 190)
      },
    })
    const app = await setup({ fake })
    await post(app.base, messageBody('wamid.M1'))
    await settle()
    await post(app.base, messageBody('wamid.M2'))
    await settle()
    expect((await row('wamid.M1'))?.status).toBe('failed')
    expect((await row('wamid.M2'))?.status).toBe('pending')
    app.close()
  })

  it('a crash after the commit and before the send: the sweep sends the stored reply once, without the model', async () => {
    const app = await setup()
    await post(app.base, messageBody('wamid.CRASH'))
    await settle()
    // Put the row back as a worker that died between the commit and the send leaves it.
    await sql`UPDATE wa_message SET status = 'processing', claimed_at = now() - interval '5 minutes',
      send_started_at = NULL, reply_sent_at = NULL WHERE wamid = 'wamid.CRASH'`
    await sql`DELETE FROM reply`
    const sent = app.calls.sent.length
    await app.worker.sweep()
    await app.worker.sweep()
    expect(bodies(app.calls).slice(sent)).toEqual([RECORD])
    expect(app.model.n).toBe(1)
    expect(await movements()).toHaveLength(1)
    expect((await row('wamid.CRASH'))?.status).toBe('done')
    app.close()
  })

  it('a reply the sweep finds already sent is not sent again', async () => {
    const app = await setup()
    await post(app.base, messageBody('wamid.DONE'))
    await settle()
    const sent = app.calls.sent.length
    await app.worker.sweep()
    await app.worker.sweep()
    expect(app.calls.sent).toHaveLength(sent)
    app.close()
  })

  it('ends rows that ran out of attempts instead of leaving them open', async () => {
    const app = await setup()
    await seed('wamid.X1', "status = 'pending', attempts = 3")
    await seed(
      'wamid.X2',
      "status = 'processing', attempts = 3, claimed_at = now() - interval '5 minutes'",
      '5491155550002',
    )
    await app.worker.sweep()
    expect((await row('wamid.X1'))?.status).toBe('failed')
    expect((await row('wamid.X2'))?.status).toBe('failed')
    expect(app.calls.sent).toHaveLength(0)
    app.close()
  })

  it('the sweep fails a message past its deadline before the commit, without the model', async () => {
    const app = await setup({ deadlineMs: 30_000 })
    await seed('wamid.OLD')
    await sql`UPDATE wa_message SET received_at = now() - interval '2 minutes' WHERE wamid = 'wamid.OLD'`
    await app.worker.sweep()
    await app.worker.sweep()
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    expect((await row('wamid.OLD'))?.status).toBe('failed')
    expect(app.model.n).toBe(0)
    app.close()
  })

  it('drain waits for replies in flight, up to its limit', async () => {
    const hold = gate()
    const fake = fakeGraph({
      send: async () => {
        await hold.promise
        return 'wamid.OUTD'
      },
    })
    const app = await setup({ fake })
    await seed('wamid.Z')
    const work = app.worker.kick([WA])
    await settle()
    const t0 = Date.now()
    await app.worker.drain(100) // gives up
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90)
    expect((await row('wamid.Z'))?.status).toBe('processing')
    const drained = app.worker.drain(5000)
    hold.open()
    await drained
    await work
    expect((await row('wamid.Z'))?.status).toBe('done')
    app.close()
  })
})

describe('the first signal on receipt', () => {
  it('a message that waits behind an older one gets the typing indicator at once, not when its lane reaches it', async () => {
    const hold = gate()
    const app = await setup({
      model: fakeModel(async () => {
        await hold.promise
        return [logCall(movement())]
      }),
    })
    await post(app.base, messageBody('wamid.Q1', WA, { text: { body: 'café 3500 con la visa' } }))
    await until(async () => app.calls.typing.includes('wamid.Q1'))
    await post(app.base, messageBody('wamid.Q2', WA, { text: { body: 'café 3500 con la visa' } }))
    // The first is still in the model, so its lane has not reached the second.
    await until(async () => app.calls.typing.includes('wamid.Q2'))
    expect(app.calls.sent).toHaveLength(0)
    expect((await row('wamid.Q2'))?.status).toBe('pending')
    expect((await row('wamid.Q2'))?.typing_sent_at).toBeInstanceOf(Date)
    hold.open()
    await until(() => doneCount(2))
    expect(bodies(app.calls)).toHaveLength(2)
    app.close()
  })

  it('a sender who is not allowed gets no signal, and nothing is sent twice for a message the lane reaches', async () => {
    const stranger = '5491155559999'
    const app = await setup({ allowed: [WA] })
    // An older row of the stranger is held by a live worker, so the new one waits behind it.
    await seed('wamid.X1', "status = 'processing', attempts = 1, claimed_at = now()", stranger)
    await post(app.base, messageBody('wamid.X2', stranger, { text: { body: 'hola' } }))
    await settle()
    expect(app.calls.typing).not.toContain('wamid.X2')
    expect((await row('wamid.X2'))?.typing_sent_at).toBeNull()
    app.close()
  })
})

describe('the owner of a row', () => {
  it('a slow worker whose row was taken over cannot send again or reopen the row', async () => {
    const slow = gate()
    let first = true
    const fake = fakeGraph({
      typing: async () => {
        if (first) {
          first = false
          await slow.promise // worker A hangs before it starts to send
        }
      },
    })
    const app = await setup({ fake, staleMs: 400 })
    await seed('wamid.S')
    const a = app.worker.kick([WA])
    await until(() => fake.calls.typing.length === 1)
    await new Promise((r) => setTimeout(r, 450))
    // B, another process: A's claim is stale by now, so it takes the row over and finishes it.
    await app.makeWorker().sweep()
    expect(await row('wamid.S')).toMatchObject({ status: 'done', attempts: 2 })
    slow.open()
    await a
    expect(fake.calls.sent).toHaveLength(1)
    expect((await row('wamid.S'))?.status).toBe('done')
    app.close()
  })

  it('a row another worker holds is not taken twice', async () => {
    const app = await setup({ staleMs: 60_000 })
    await seed('wamid.Y')
    await Promise.all([app.worker.kick([WA]), app.makeWorker().kick([WA])])
    expect(app.calls.sent).toHaveLength(1)
    expect((await row('wamid.Y'))?.attempts).toBe(1)
    app.close()
  })

  it('a claim lost at the commit writes nothing and says nothing more', async () => {
    const app = await setup({
      // Another process takes the row over while the model is thinking.
      model: fakeModel(async () => {
        await sql`UPDATE wa_message SET attempts = attempts + 1 WHERE wamid = 'wamid.LOST'`
        return cafe
      }),
    })
    await post(app.base, messageBody('wamid.LOST'))
    await settle()
    expect(app.calls.sent).toHaveLength(0)
    expect(await movements()).toHaveLength(0)
    expect(await count('turn')).toBe(0)
    expect(await row('wamid.LOST')).toMatchObject({ failure_sent_at: null, turn_id: null })
    app.close()
  })

  it('a message from a sender who is not allowed is settled ignored and never touches the model', async () => {
    const app = await setup({ allowed: ['5491155550000'] })
    await post(app.base, messageBody('wamid.NA', '5491100000000'))
    await settle()
    expect(await row('wamid.NA')).toMatchObject({ status: 'ignored', turn_id: null })
    expect(app.model.n).toBe(0)
    expect(app.calls.typing).toHaveLength(0)
    app.close()
  })
})

describe('a secret in a row that ends with no turn', () => {
  const CARD = 'mi tarjeta es 4509 9535 6623 3704'

  it('is wiped when the sender is not allowed (settled ignored)', async () => {
    const app = await setup({ allowed: ['5491155550000'] })
    await post(app.base, messageBody('wamid.NS', '5491100000000', { text: { body: CARD } }))
    await settle()
    expect(await row('wamid.NS')).toMatchObject({
      status: 'ignored',
      text: '[dato sensible, no guardado]',
    })
    app.close()
  })

  it('is wiped when the sweep gives up on the row (attempts exhausted)', async () => {
    const app = await setup()
    await seed('wamid.NT', `attempts = 9, text = '${CARD}'`)
    await app.worker.sweep()
    expect(await row('wamid.NT')).toMatchObject({
      status: 'failed',
      text: '[dato sensible, no guardado]',
    })
    app.close()
  })
})

describe('a message that cannot be answered', () => {
  it('a failing model gives exactly one failure message, no rows and no turn, and keeps what it tried', async () => {
    const app = await setup({
      model: fakeModel(() => {
        throw new Error('overloaded')
      }),
    })
    await post(app.base, messageBody('wamid.BAD'))
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    expect(await movements()).toHaveLength(0)
    expect(await count('turn')).toBe(0)
    const r = await row('wamid.BAD')
    expect(r).toMatchObject({ status: 'failed', turn_id: null, text: 'café 3500' })
    expect(r?.failure_sent_at).toBeInstanceOf(Date)
    expect(r?.error).toContain('overloaded')
    app.close()
  })

  it('the failure notice waits for the typing call, so the indicator never lands after it', async () => {
    const hold = gate()
    const fake = fakeGraph({ typing: () => hold.promise })
    const app = await setup({
      fake,
      model: fakeModel(() => {
        throw new Error('overloaded')
      }),
    })
    await post(app.base, messageBody('wamid.BADT'))
    // The model failed at once; the typing call is still out: nothing is sent yet.
    await until(async () => (await row('wamid.BADT')) !== undefined && app.model.n > 0)
    await new Promise((r) => setTimeout(r, 100))
    expect(app.calls.sent).toHaveLength(0)
    hold.open()
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    app.close()
  })

  it('a refusal goes to the failure path with its audit and the category, and the model is not asked again', async () => {
    const refusal = message([], { stop_reason: 'refusal' })
    refusal.stop_details = { type: 'refusal', category: 'general_harms', explanation: null }
    let asked = 0
    const client = {
      messages: {
        create: async () => {
          asked++
          return refusal
        },
      },
    } as unknown as Anthropic
    const app = await setup({ model: { client, calls: { n: 0 }, requests: [] } })
    await post(app.base, messageBody('wamid.REF'))
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    expect(asked).toBe(1)
    const r = await row('wamid.REF')
    expect(r?.status).toBe('failed')
    expect(r?.audit).toMatchObject([
      { tool: 'refusal', status: 'refusal', detail: 'general_harms' },
    ])
    expect(r?.timings.turns).toHaveLength(1)
    expect(await count('turn')).toBe(0)
    app.close()
  })

  it('output that cannot be stored fails the message instead of guessing', async () => {
    const app = await setup({
      model: fakeModel(() => [logCall(movement({ amount: '3.500' }))]),
    })
    await post(app.base, messageBody('wamid.INV'))
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    expect(await movements()).toHaveLength(0)
    app.close()
  })

  it('a secret in a message that failed leaves no trace of it: the text and the audit are wiped', async () => {
    const app = await setup({
      model: fakeModel(() => {
        throw new Error('overloaded')
      }),
    })
    await post(
      app.base,
      messageBody('wamid.SEC', WA, { text: { body: 'mi clave del banco es 1234' } }),
    )
    await until(() => app.calls.sent.length === 1)
    const r = await row('wamid.SEC')
    expect(r?.text).toBe('[dato sensible, no guardado]')
    expect(JSON.stringify(r)).not.toContain('1234')
    app.close()
  })

  it('a secret the model tried to store is declined by code and stored nowhere: the text, the audit and what ran lose it', async () => {
    const app = await setup({
      model: script({
        name: 'remember_fact',
        input: { kind: 'note', key: 'clave', value: 'la clave es 1234' },
      }),
    })
    await post(
      app.base,
      messageBody('wamid.SEC2', WA, { text: { body: 'guardá que mi clave es 1234' } }),
    )
    await until(() => doneCount(1))
    const r = await row('wamid.SEC2')
    expect(r?.text).toBe('[dato sensible, no guardado]')
    expect(JSON.stringify(r?.audit)).not.toContain('1234')
    const [t] = await sql`SELECT calls, reply FROM turn`
    expect(JSON.stringify(t?.calls)).not.toContain('1234')
    expect(t?.reply).toContain('No guardo claves')
    expect(await count('movement')).toBe(0)
    app.close()
  })

  it('a commit that throws gives one failure message and stores nothing', async () => {
    const app = await setup()
    await withTurnTrigger("RAISE EXCEPTION 'connection reset';", async () => {
      await post(app.base, messageBody('wamid.THROW'))
      await until(() => app.calls.sent.length === 1)
    })
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    expect(await movements()).toHaveLength(0)
    expect((await row('wamid.THROW'))?.status).toBe('failed')
    app.close()
  })

  it('a slow model gets exactly one interim note, then the reply', async () => {
    const release = gate()
    const app = await setup({
      model: fakeModel(async () => {
        await release.promise
        return cafe
      }),
      interimMs: 20,
    })
    await post(app.base, messageBody('wamid.SLOW'))
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_INTERIM])
    await until(() => app.calls.typing.length === 2) // typing again after the note
    release.open()
    await until(() => doneCount(1))
    expect(bodies(app.calls)).toEqual([REPLY_INTERIM, RECORD])
    expect(await movements()).toHaveLength(1)
    expect((await row('wamid.SLOW'))?.interim_sent_at).toBeInstanceOf(Date)
    app.close()
  })

  it('the deadline gives one failure message and the late result writes nothing', async () => {
    const release = gate()
    const app = await setup({
      model: fakeModel(async () => {
        await release.promise // ignores the abort, like a stuck socket
        return cafe
      }),
      deadlineMs: 100,
    })
    await post(app.base, messageBody('wamid.LATE'))
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    release.open()
    await until(async () => (await row('wamid.LATE'))?.status === 'failed')
    await settle() // lets a wrongly written late result show up
    expect(bodies(app.calls)).toEqual([REPLY_FAILED])
    expect(await movements()).toHaveLength(0)
    expect(await count('turn')).toBe(0)
    app.close()
  })

  it('a deadline that fires during the commit loses: committed means the reply goes out', async () => {
    const app = await setup({ deadlineMs: 600 })
    await withTurnTrigger('PERFORM pg_sleep(0.9);', async () => {
      await post(app.base, messageBody('wamid.MID'))
      await until(() => doneCount(1), { timeout: 5000 })
    })
    expect(bodies(app.calls)).toEqual([RECORD])
    expect(await movements()).toHaveLength(1)
    expect((await row('wamid.MID'))?.failure_sent_at).toBeNull()
    app.close()
  })

  it('a shutdown during the parse hands the row back, and the next process answers it', async () => {
    const entered = gate()
    const release = gate()
    const app = await setup({
      model: fakeModel(async () => {
        entered.open()
        await release.promise
        return cafe
      }),
    })
    await post(app.base, messageBody('wamid.TERM'))
    await entered.promise
    await app.worker.stop(2000)
    expect(await row('wamid.TERM')).toMatchObject({ status: 'pending', failure_sent_at: null })
    expect(app.calls.sent).toHaveLength(0)

    // The new process: its startup sweep takes the row and answers it.
    const successor = app.makeWorker(fakeModel().client)
    await successor.sweep()
    expect(bodies(app.calls)).toEqual([RECORD])
    expect(await movements()).toHaveLength(1)
    release.open() // the old process's model finally answers: nothing more is written
    await settle()
    expect(await movements()).toHaveLength(1)
    expect(app.calls.sent).toHaveLength(1)
    app.close()
  })

  it('a shutdown also hands back the messages queued behind it, and the next process answers both in order', async () => {
    const entered = gate()
    const release = gate()
    let first = true
    const app = await setup({
      model: fakeModel(async () => {
        if (first) {
          first = false
          entered.open()
          await release.promise
        }
        return cafe
      }),
    })
    await post(app.base, messageBody('wamid.Q1'))
    await entered.promise
    await post(app.base, messageBody('wamid.Q2')) // same sender: queued behind Q1
    await settle()
    await app.worker.stop(2000)
    expect(await row('wamid.Q1')).toMatchObject({ status: 'pending' })
    expect(await row('wamid.Q2')).toMatchObject({ status: 'pending', failure_sent_at: null })
    expect(app.calls.sent).toHaveLength(0)
    const successor = app.makeWorker(fakeModel().client)
    await successor.sweep()
    expect(bodies(app.calls)).toEqual([RECORD, RECORD])
    release.open()
    app.close()
  })
})

describe('answers code gives without the model', () => {
  const pair = async () => {
    const [a, b] = await seedMovements([
      { on: '2025-10-09', amount: '3500', description: 'café', category: 'restaurantes' },
      { on: '2025-10-09', amount: '12000', description: 'súper', category: 'supermercado' },
    ])
    return [a, b] as [number, number]
  }
  const say = async (app: Awaited<ReturnType<typeof setup>>, wamid: string, text: string) => {
    const before = app.calls.sent.length
    await post(app.base, messageBody(wamid, WA, { text: { body: text } }))
    await until(async () => ['done', 'failed'].includes(String((await row(wamid))?.status)))
    return bodies(app.calls)[before] ?? ''
  }

  it('a number picks the option of the question that was just asked, and deletes it by id', async () => {
    const [cafeId, superId] = await pair()
    const app = await setup({
      model: script({
        name: 'ask_user',
        input: { movement_ids: [cafeId, superId], then: { do: 'delete' } },
      }),
    })
    const question = await say(app, 'wamid.Q', 'borrá lo del súper o el café')
    expect(question).toContain('¿Cuál?')
    expect(app.model.n).toBe(1)
    // The question is on the turn; the next message answers it by option number, with no model call.
    const [t] = await sql`SELECT question FROM turn ORDER BY id DESC LIMIT 1`
    expect(t?.question).toMatchObject({ then: { do: 'delete' } })
    const reply = await say(app, 'wamid.A', '1')
    expect(app.model.n).toBe(1)
    expect(reply).toMatch(/^🗑|Borrado|borr/i)
    const live = await sql`SELECT entity_id::int AS id FROM movement WHERE ended_at IS NULL`
    expect(live).toHaveLength(1)
    // Option 1 is the newest first: the súper.
    expect(live[0]?.id).toBe(cafeId)
    expect((await row('wamid.A'))?.audit).toMatchObject([
      { tool: 'delete_movement', status: 'answered' },
    ])
    app.close()
  })

  it('a bare "deshacer" undoes the last turn with no model call', async () => {
    const app = await setup({ model: script(logCall(movement())) })
    await say(app, 'wamid.L1', 'café 3500')
    expect(await movements()).toHaveLength(1)
    const reply = await say(app, 'wamid.U1', 'deshacer')
    expect(app.model.n).toBe(1)
    expect(await movements()).toHaveLength(0)
    expect(reply).toContain('Café')
    const [u] = await sql`SELECT label, undoes FROM turn ORDER BY id DESC LIMIT 1`
    expect(u).toMatchObject({ label: 'undo' })
    expect(u?.undoes).not.toBeNull()
    app.close()
  })

  it('"deshacer" while a question is open is not an undo: the model reads it', async () => {
    const [cafeId, superId] = await pair()
    const app = await setup({
      model: script(
        { name: 'ask_user', input: { movement_ids: [cafeId, superId], then: { do: 'delete' } } },
        replyCall('Decime cuál'),
      ),
    })
    await say(app, 'wamid.Q', 'borrá uno')
    await say(app, 'wamid.D', 'deshacer')
    expect(app.model.n).toBe(2)
    app.close()
  })

  it('"sí" confirms forgetting everything, once the question was asked', async () => {
    const app = await setup({
      model: script(
        { name: 'remember_fact', input: { kind: 'note', key: 'cobro', value: 'el 5 de cada mes' } },
        forgetAll,
      ),
    })
    await say(app, 'wamid.R', 'anotá que cobro el 5 de cada mes')
    expect(await say(app, 'wamid.F', 'olvidate de todo')).toContain('¿Seguro')
    expect(await say(app, 'wamid.Y', 'sí')).toContain('Me olvidé de todo')
    expect(app.model.n).toBe(2)
    expect(await sql`SELECT 1 FROM fact WHERE ended_at IS NULL`).toHaveLength(0)
    app.close()
  })
})
