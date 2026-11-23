import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { realPostgres } from '../../test/db'
import {
  bodies,
  fakeGraph,
  fakeModel,
  gate,
  logCall,
  messageBody,
  movement,
  post,
  row,
  seed,
  setup,
  sql,
  until,
  useDatabase,
} from '../test-harness'

/**
 * Races on real Postgres (PGlite has one session, so there is nothing to race): what the claim's SQL promises about a sender's messages
 * when more than one worker is awake, as in a burst and in a deploy's overlap of two instances. Each test repeats `RACE_RUNS` times
 * (the CI default is small; the slice's proof ran the whole file in a loop).
 */

const RUNS = Number(process.env.RACE_RUNS ?? 3)
useDatabase({ max: 12 })

type App = Awaited<ReturnType<typeof setup>>

/** The person's message in the context a model request carries. */
const textOf = (params: Anthropic.MessageCreateParamsNonStreaming) =>
  /<mensaje>\n([\s\S]*?)\n<\/mensaje>/.exec(String(params.messages[0]?.content))?.[1] ?? ''

const numberOf = (text: string) => Number(/\d+$/.exec(text)?.[0] ?? 0)

/** A model that logs one movement named after the message (its amount is 100 plus the number the text ends with), after `delay(text)`. */
const logs = (delay: (text: string) => number | Promise<void> = () => 0) =>
  fakeModel(async (_signal, { params }) => {
    const text = textOf(params)
    const wait = delay(text)
    if (typeof wait === 'number') {
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    } else await wait
    return [logCall(movement({ description: text, amount: String(100 + numberOf(text)) }))]
  })

/** What `logs` makes of a message, as the person reads it. */
const record = (description: string) =>
  `✓ ${description.charAt(0).toUpperCase()}${description.slice(1)} $${100 + numberOf(description)} (visa)`

const sender = (n: number) => `54911000000${String(n).padStart(2, '0')}`
const post1 = (app: App, wamid: string, from: string, text: string) =>
  post(app.base, messageBody(wamid, from, { text: { body: text } }))
const sentTo = (app: App, to: string) =>
  app.calls.sent.filter((s) => s.to === to).map((s) => s.body)
const reset = () =>
  sql`TRUNCATE reply, wa_message, movement, turn, account_address, account RESTART IDENTITY CASCADE`

describe.skipIf(!realPostgres)('real Postgres: the worker under concurrency', () => {
  it('a burst from one sender is answered in order, whatever the model takes for each message', async () => {
    for (let run = 0; run < RUNS; run++) {
      const from = sender(run)
      // The first message is the slowest and the last the fastest: only the claim's order keeps them in line.
      const app = await setup({ model: logs((t) => 120 - 20 * numberOf(t)) })
      const n = 6
      for (let k = 1; k <= n; k++) await post1(app, `wamid.B${run}.${k}`, from, `burst ${k}`)
      await until(
        async () => (await sql`SELECT 1 FROM wa_message WHERE status = 'done'`).length === n,
        { timeout: 15_000 },
      )
      // Replies went out in the order the messages came, one each.
      expect(sentTo(app, from)).toEqual(
        Array.from({ length: n }, (_, k) => record(`burst ${k + 1}`)),
      )
      // The turns, and so the movements they made, are in that order too.
      const turns = await sql`
        SELECT m.wamid FROM wa_message m JOIN turn t ON t.id = m.turn_id ORDER BY t.id`
      expect(turns.map((t) => t.wamid)).toEqual(
        Array.from({ length: n }, (_, k) => `wamid.B${run}.${k + 1}`),
      )
      expect((await sql`SELECT attempts FROM wa_message`).every((r) => r.attempts === 1)).toBe(true)
      app.close()
      await reset()
    }
  })

  it('two senders run in parallel: one stuck on its model does not hold the other', async () => {
    for (let run = 0; run < RUNS; run++) {
      const stuck = gate()
      const app = await setup({ model: logs((t) => (t.startsWith('lento') ? stuck.promise : 0)) })
      await post1(app, `wamid.P${run}.1`, sender(1), 'lento 1')
      await until(() => app.model.n === 1)
      await post1(app, `wamid.P${run}.2`, sender(2), 'rapido 1')
      await post1(app, `wamid.P${run}.3`, sender(2), 'rapido 2')
      await until(() => sentTo(app, sender(2)).length === 2, { timeout: 10_000 })
      // The first sender is still waiting for its model.
      expect(sentTo(app, sender(1))).toEqual([])
      expect((await row(`wamid.P${run}.1`))?.status).toBe('processing')
      stuck.open()
      await until(() => sentTo(app, sender(1)).length === 1, { timeout: 10_000 })
      app.close()
      await reset()
    }
  })

  it("the deploy's hand-off: an old instance's claimed row is not overtaken by a newer row of the same sender", async () => {
    for (let run = 0; run < RUNS; run++) {
      const from = sender(10 + run)
      const hold = gate()
      const entered = gate()
      // The old instance: its model is slow for the first message.
      const old = await setup({
        model: logs((t) => {
          if (t === 'viejo 1') {
            entered.open()
            return hold.promise
          }
          return 0
        }),
      })
      await post1(old, `wamid.H${run}.1`, from, 'viejo 1')
      await entered.promise
      // The new instance gets the sender's next message while the old one still holds the first: it must wait.
      const fresh = old.makeWorker(logs().client)
      await post1(old, `wamid.H${run}.2`, from, 'nuevo 2')
      await fresh.kick([from])
      expect(await row(`wamid.H${run}.2`)).toMatchObject({ status: 'pending', attempts: 0 })
      expect(sentTo(old, from)).toEqual([])
      // The old instance is stopped (SIGTERM): it gives its row back, and the new one answers both, the older first.
      await old.worker.stop(3000)
      expect((await row(`wamid.H${run}.1`))?.status).toBe('pending')
      await fresh.sweep()
      expect(sentTo(old, from)).toEqual([record('viejo 1'), record('nuevo 2')])
      hold.open()
      old.close()
      await reset()
    }
  })

  it('a stale claim is retaken, once, even when two workers sweep at the same time', async () => {
    for (let run = 0; run < RUNS; run++) {
      const app = await setup({ staleMs: 60_000 })
      const other = app.makeWorker()
      const stale = "status = 'processing', attempts = 1, claimed_at = now() - interval '5 minutes'"
      await seed(`wamid.S${run}.1`, stale, sender(20))
      await seed(`wamid.S${run}.2`, "status = 'pending'", sender(20))
      await seed(`wamid.S${run}.3`, stale, sender(21))
      await Promise.all([app.worker.sweep(), other.sweep()])
      const rows = await sql`SELECT wamid, status, attempts FROM wa_message ORDER BY id`
      expect(rows.map((r) => [r.status, r.attempts])).toEqual([
        ['done', 2],
        ['done', 1],
        ['done', 2],
      ])
      // One reply each.
      expect(app.calls.sent).toHaveLength(3)
      expect(sentTo(app, sender(20))).toHaveLength(2)
      app.close()
      await reset()
    }
  })

  it('a row held by a live worker blocks the sender, but a stale one does not', async () => {
    const app = await setup({ staleMs: 60_000 })
    await seed('wamid.W1', "status = 'processing', attempts = 1, claimed_at = now()", sender(30))
    await seed('wamid.W2', "status = 'pending'", sender(30))
    await app.worker.kick([sender(30)])
    expect(await row('wamid.W2')).toMatchObject({ status: 'pending', attempts: 0 })
    // The holder dies: its claim goes stale, the sender's oldest row is taken again first.
    await sql`UPDATE wa_message SET claimed_at = now() - interval '5 minutes' WHERE wamid = 'wamid.W1'`
    await app.worker.kick([sender(30)])
    expect((await row('wamid.W1'))?.status).toBe('done')
    expect((await row('wamid.W2'))?.status).toBe('done')
    expect(bodies(app.calls)).toHaveLength(2)
    app.close()
  })

  it('first signal on a burst: how long from receipt to the typing indicator', async () => {
    const senders = 4
    const perSender = 5
    const app = await setup({ fake: fakeGraph(), model: logs(() => 40) })
    for (let k = 1; k <= perSender; k++) {
      for (let s = 0; s < senders; s++) {
        await post1(app, `wamid.F${s}.${k}`, sender(40 + s), `señal ${k}`)
      }
    }
    await until(
      async () =>
        (await sql`SELECT 1 FROM wa_message WHERE status = 'done'`).length === senders * perSender,
      { timeout: 30_000 },
    )
    const ms = (
      await sql<{ ms: number }[]>`
        SELECT extract(epoch FROM typing_sent_at - received_at) * 1000 AS ms FROM wa_message ORDER BY 1`
    ).map((r) => Number(r.ms))
    const at = (p: number) =>
      ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)] as number
    // The measurement the slice reports (sending it on receipt is R7's experiment): the typing indicator waits for the lane.
    console.info(
      `FIRST_SIGNAL n=${ms.length} p50=${Math.round(at(50))}ms p95=${Math.round(at(95))}ms max=${Math.round(ms.at(-1) as number)}ms`,
    )
    console.info(`FIRST_SIGNAL_MS ${ms.map((m) => Math.round(m)).join(',')}`)
    expect(ms).toHaveLength(senders * perSender)
    expect(at(95)).toBeLessThan(5000)
    app.close()
  })
})
