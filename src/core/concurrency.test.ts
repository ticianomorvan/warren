import { describe, expect, it } from 'vitest'
import {
  cafe,
  cancel,
  forget,
  hours,
  liveFactList,
  liveMovements,
  liveReminderList,
  log,
  minutes,
  newAccount,
  remember,
  remind,
  turn,
  undo,
} from '../../test/core'
import { realPostgres, sql, useDatabase } from '../../test/db'
import { fakeGraph } from '../../test/fakes'
import { createReminderSender } from '../domain/reminders/send'
import { schemaDir } from './db'

/**
 * Races on real Postgres (PGlite has one session, so there is nothing to race). Every write transaction takes the account lock first, so
 * the writes of one account are serialized in commit order: whichever goes first, the result must be what that order says (no lost
 * update, no turn that undoes what it should not) and nothing may deadlock (Postgres would abort one with 40P01, which fails the test).
 * Each test repeats its race `RACE_RUNS` times (the CI default is small; the slice's proof ran the whole file in a loop).
 */

const RUNS = Number(process.env.RACE_RUNS ?? 6)
useDatabase({ max: 12, migrations: schemaDir })

type TurnRow = { id: number; label: string; undoes: number | null }
const turns = (a: number) =>
  sql<TurnRow[]>`SELECT id::int, label, undoes::int FROM turn WHERE account_id = ${a} ORDER BY id`

/**
 * The strict stack's law, replayed from the turn log in commit order: an undo undoes the newest turn that did something and was not
 * undone, and nothing else.
 */
async function assertStackLaw(a: number, doing: (label: string) => boolean) {
  const stack: number[] = []
  for (const t of await turns(a)) {
    if (t.label === 'undo') {
      if (t.undoes !== null) expect(stack.pop(), `undo ${t.id} undid ${t.undoes}`).toBe(t.undoes)
    } else if (doing(t.label)) stack.push(t.id)
  }
}

describe.skipIf(!realPostgres)('real Postgres: races on one account', () => {
  it('two writes and an undo in parallel: no lost update, no deadlock, the undo takes the newest turn in commit order', async () => {
    for (let run = 0; run < RUNS; run++) {
      const a = await newAccount(sql)
      await turn(sql, a, [log(cafe({ description: 'base' }))])
      const results = await Promise.all([
        turn(sql, a, [log(cafe({ description: 'one' }))], { at: minutes(1) }),
        turn(sql, a, [log(cafe({ description: 'two' }))], { at: minutes(1) }),
        turn(sql, a, [undo], { at: minutes(2) }),
      ])
      expect(new Set(results.map((r) => r.turn)).size).toBe(3)
      await assertStackLaw(a, (label) => label === 'log')
      // The live set is what replaying the commit order says: every log, minus the one the undo took.
      const all = await turns(a)
      const undone = all.find((t) => t.label === 'undo')?.undoes
      const logged = await sql<{ made: number; description: string }[]>`
        SELECT made_in::int AS made, description FROM movement WHERE account_id = ${a} ORDER BY id`
      const expected = logged.filter((m) => m.made !== undone).map((m) => m.description)
      expect((await liveMovements(sql)).map((m) => m.description).sort(), `run ${run}`).toEqual(
        expected.sort(),
      )
      await sql`TRUNCATE mcp_request, reminder_send, reminder, fact, movement, reply, wa_message, turn, account_address, account RESTART IDENTITY CASCADE`
    }
  })

  it('several undos in parallel take one turn each, never the same one twice', async () => {
    for (let run = 0; run < RUNS; run++) {
      const a = await newAccount(sql)
      for (let i = 0; i < 4; i++)
        await turn(sql, a, [log(cafe({ description: `m${i}` }))], { at: minutes(i) })
      await Promise.all([1, 2, 3].map((i) => turn(sql, a, [undo], { at: minutes(10 + i) })))
      await assertStackLaw(a, (label) => label === 'log')
      expect(
        (await liveMovements(sql)).map((m) => m.description),
        `run ${run}`,
      ).toEqual(['m0'])
      await sql`TRUNCATE mcp_request, reminder_send, reminder, fact, movement, reply, wa_message, turn, account_address, account RESTART IDENTITY CASCADE`
    }
  })

  it('an undo racing a forget: either order is consistent, neither fails, and the fact is where the order says', async () => {
    for (let run = 0; run < RUNS; run++) {
      const a = await newAccount(sql)
      await turn(sql, a, [remember('cobro', 'el 5')])
      const [forgot, undid] = await Promise.all([
        turn(sql, a, [forget({ key: 'cobro' })], { at: minutes(1) }),
        turn(sql, a, [undo], { at: minutes(1) }),
      ])
      const forgetFirst = forgot.turn < undid.turn
      const live = await liveFactList(sql)
      if (forgetFirst) {
        // The forget is the newest turn when the undo runs: it undoes the forget, and the fact is back.
        expect(forgot.done[0]?.outcome?.status, `run ${run}`).toBe('applied')
        expect(undid.done[0]?.outcome).toMatchObject({ status: 'applied', turn: forgot.turn })
        expect(live).toEqual([{ entity: 1, key: 'cobro', value: 'el 5' }])
      } else {
        // The undo takes the remember first; the forget then finds nothing live.
        expect(undid.done[0]?.outcome).toMatchObject({ status: 'applied' })
        expect(forgot.done[0]?.outcome?.status, `run ${run}`).toBe('gone')
        expect(live).toEqual([])
      }
      await assertStackLaw(a, (label) => label !== 'undo')
      await sql`TRUNCATE mcp_request, reminder_send, reminder, fact, movement, reply, wa_message, turn, account_address, account RESTART IDENTITY CASCADE`
    }
  })

  it('an undo racing a reminder cancel: either order is consistent and neither fails', async () => {
    for (let run = 0; run < RUNS; run++) {
      const a = await newAccount(sql)
      await turn(sql, a, [remind('pagar la Visa')])
      const [cancelled, undid] = await Promise.all([
        turn(sql, a, [cancel(1)], { at: minutes(1) }),
        turn(sql, a, [undo], { at: minutes(1) }),
      ])
      const live = await liveReminderList(sql)
      if (cancelled.turn < undid.turn) {
        expect(cancelled.done[0]?.outcome?.status, `run ${run}`).toBe('applied')
        expect(undid.done[0]?.outcome).toMatchObject({ status: 'applied', turn: cancelled.turn })
        expect(live).toEqual([{ entity: 1, what: 'pagar la Visa' }])
      } else {
        expect(undid.done[0]?.outcome).toMatchObject({ status: 'applied' })
        expect(cancelled.done[0]?.outcome?.status, `run ${run}`).toBe('gone')
        expect(live).toEqual([])
      }
      await sql`TRUNCATE mcp_request, reminder_send, reminder, fact, movement, reply, wa_message, turn, account_address, account RESTART IDENTITY CASCADE`
    }
  })

  it('an undo racing the real sender that finishes a one-off: the set is taken back and nothing is sent, or it is sent and the undo is blocked', async () => {
    for (let run = 0; run < RUNS; run++) {
      const a = await newAccount(sql)
      await sql`INSERT INTO account_address (account_id, channel, address) VALUES (${a}, 'whatsapp', '5491100000000')`
      await turn(sql, a, [remind('llamar', { day: 'tomorrow', time: '10:00' })])
      // The sender takes the reminder's row lock and finishes the one-off, without the account lock.
      const graph = fakeGraph()
      const sender = createReminderSender({
        sql,
        graph: graph.graph,
        allowed: ['*'],
        template: 'warren_reminder',
        now: () => hours(26),
      })
      const [, undid] = await Promise.all([
        sender.sweep(),
        turn(sql, a, [undo], { at: minutes(1) }),
      ])
      const status = undid.done[0]?.outcome?.status
      expect(['applied', 'blocked'], `run ${run}`).toContain(status)
      // Whichever came first: it was sent exactly when the undo found it already sent.
      expect(graph.calls.attempts, `run ${run}`).toBe(status === 'blocked' ? 1 : 0)
      expect(await liveReminderList(sql), `run ${run}`).toEqual([])
      await sql`TRUNCATE mcp_request, reminder_send, reminder, fact, movement, reply, wa_message, turn, account_address, account RESTART IDENTITY CASCADE`
    }
  })

  it('writes to different accounts never wait for each other’s undo', async () => {
    const accounts = await Promise.all(Array.from({ length: 6 }, () => newAccount(sql)))
    await Promise.all(accounts.map((a) => turn(sql, a, [log(cafe())])))
    await Promise.all(
      accounts.flatMap((a) => [
        turn(sql, a, [undo], { at: minutes(1) }),
        turn(sql, a, [log(cafe())], { at: minutes(1) }),
      ]),
    )
    for (const a of accounts) await assertStackLaw(a, (label) => label === 'log')
  })
})
