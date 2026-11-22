import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cafe, newAccount } from '../../test/core'
import { type App, type Connected, mint, WA_A, WA_B, withClaude } from '../auth-test-kit'
import { call, ok, refused, rpc } from '../mcp-test-kit'
import { sql, TODAY, useDatabase } from '../test-harness'
import { addDays } from '../time'
import { runTool } from './tools'

/**
 * The write tools of `/mcp`: the registry's nine writes minus forgetting everything, through `checkValues` and `core/turn.commit` on the
 * channel `mcp`. Ported from v1's `mcp-write.test.ts` (the undo that spans both channels is in `e2e.test.ts`, with WhatsApp).
 */
useDatabase({ max: 12 })

let app: App
let a: Connected
let accountA: number

const movement = (o: Record<string, unknown> = {}) => ({ ...cafe({ date: TODAY }), ...o })
const write = (name: string, args: Record<string, unknown> = {}, who = a) =>
  call(app, who.access_token, `warren_${name}`, args)
const turns = () =>
  sql<
    { id: number; channel: string; label: string }[]
  >`SELECT id::int, channel, label FROM turn WHERE channel = 'mcp' ORDER BY id`
const live = () => sql<{ id: number; description: string; amount: string }[]>`
  SELECT entity_id::int AS id, description, amount::text AS amount FROM movement WHERE ended_at IS NULL ORDER BY id`

beforeEach(async () => {
  ;({ app } = await withClaude({ allowed: [WA_A, WA_B] }))
  a = await mint(app, WA_A)
  accountA = Number(
    (await sql`SELECT account_id FROM account_address WHERE address = ${WA_A}`)[0]?.account_id,
  )
})
afterEach(() => app.close())

describe('warren_log_movements', () => {
  it('logs, renders the record, and leaves a turn on the channel mcp that carries it', async () => {
    const r = ok(
      await write('log_movements', {
        movements: [movement(), movement({ description: 'súper', amount: '12000' })],
      }),
      'log_movements',
    )
    expect(r.movements.map((m) => m.description)).toEqual(['café', 'súper'])
    expect(r.record).toContain('Anoté')
    expect(r.replayed).toBe(false)
    const [row] = await turns()
    expect(row).toMatchObject({ id: r.turn, channel: 'mcp', label: 'log' })
    expect(await live()).toHaveLength(2)
    // The MCP rows are not WhatsApp messages: nothing was queued, nothing is in the conversation's transport.
    expect(await sql`SELECT 1 FROM wa_message`).toHaveLength(waBefore)
  })

  it('refuses what a table cannot hold, with the reason, and writes nothing', async () => {
    refused(
      await write('log_movements', { movements: [movement({ date: addDays(TODAY, 3) })] }),
      'invalid',
    )
    refused(
      await write('log_movements', { movements: [movement({ amount: '1.234,50' })] }),
      'invalid',
    )
    refused(
      await write('log_movements', {
        movements: [movement({ description: 'tarjeta 4111111111111111' })],
      }),
      'invalid',
    )
    expect(await live()).toHaveLength(0)
    expect(await turns()).toHaveLength(0)
  })
})

describe('warren_correct_movement and warren_delete_movement', () => {
  const id = async () =>
    ok(await write('log_movements', { movements: [movement()] }), 'log_movements').movements[0]
      ?.id as number

  it('adds a corrected version, keeps the old one replaced, and shows before and after', async () => {
    const m = await id()
    const r = ok(
      await write('correct_movement', { id: m, changes: { amount: '4000' } }),
      'correct_movement',
    )
    expect(r.changed).toEqual(['money'])
    expect([r.before.amount, r.after.amount, r.after.id]).toEqual(['3500', '4000', m])
    expect(await live()).toEqual([{ id: m, description: 'café', amount: '4000' }])
    expect(await sql`SELECT 1 FROM movement`).toHaveLength(2) // the old version stays, ended
  })

  it('a no-op changes nothing and leaves no turn', async () => {
    const m = await id()
    const before = (await turns()).length
    const r = ok(
      await write('correct_movement', { id: m, changes: { amount: '3500' } }),
      'correct_movement',
    )
    expect(r).toMatchObject({ turn: null, changed: [] })
    expect(await turns()).toHaveLength(before)
  })

  it("refuses a movement that was already deleted, one that does not exist, and another person's", async () => {
    const m = await id()
    ok(await write('delete_movement', { id: m }), 'delete_movement')
    expect(await live()).toHaveLength(0)
    refused(await write('correct_movement', { id: m, changes: { amount: '1' } }), 'gone')
    refused(await write('delete_movement', { id: m }), 'gone')
    refused(await write('delete_movement', { id: 999_999 }), 'gone')
    const other = await newAccount(sql)
    const theirs = (await sql`SELECT entity_id::int AS id FROM movement LIMIT 1`)[0]?.id
    await sql`INSERT INTO account_address (account_id, channel, address) VALUES (${other}, 'whatsapp', '5491100000099')`
    const b = await mint(app, WA_B)
    refused(await write('delete_movement', { id: theirs }, b), 'gone')
    // A refusal wrote nothing: only the log and the delete are turns.
    expect(await turns()).toHaveLength(2)
  })

  it('refuses an empty correction and a value that cannot be stored', async () => {
    const m = await id()
    refused(await write('correct_movement', { id: m, changes: {} }), 'invalid')
    refused(await write('correct_movement', { id: m, changes: { amount: '-5' } }), 'invalid')
    refused(
      await write('correct_movement', { id: m, changes: { date: addDays(TODAY, 2) } }),
      'invalid',
    )
    expect(await live()).toEqual([{ id: m, description: 'café', amount: '3500' }])
  })
})

describe('warren_remember_fact and warren_forget_fact', () => {
  it('remembers, updates, and says when nothing changed', async () => {
    const first = ok(
      await write('remember_fact', { kind: 'alias', key: 'La Visa', value: 'galicia' }),
      'remember_fact',
    )
    expect(first).toMatchObject({
      status: 'new',
      previous_value: null,
      fact: { key: 'la visa', value: 'galicia' },
    })
    const upd = ok(
      await write('remember_fact', { kind: 'alias', key: 'la visa', value: 'santander' }),
      'remember_fact',
    )
    expect(upd).toMatchObject({ status: 'updated', previous_value: 'galicia' })
    const same = ok(
      await write('remember_fact', { kind: 'alias', key: 'la visa', value: 'santander' }),
      'remember_fact',
    )
    expect(same).toMatchObject({ status: 'unchanged', turn: null })
  })

  it('declines a secret and contact data with a typed code, and keeps nothing', async () => {
    refused(
      await write('remember_fact', { kind: 'note', key: 'clave', value: 'mi pin es 4821' }),
      'secret',
    )
    refused(
      await write('remember_fact', { kind: 'note', key: 'cbu', value: '0170099220000012345678' }),
      'secret',
    )
    refused(
      await write('remember_fact', { kind: 'note', key: 'mama', value: 'mama@example.com' }),
      'contact',
    )
    expect(await sql`SELECT 1 FROM fact`).toHaveLength(0)
    expect(await turns()).toHaveLength(0)
  })

  it('forgets by id or by key, only its own, and refuses what is not there', async () => {
    const f = ok(
      await write('remember_fact', { kind: 'note', key: 'cobro', value: 'el 5' }),
      'remember_fact',
    ).fact.id
    await write('remember_fact', { kind: 'alias', key: 'gym', value: 'smartfit' })
    expect(
      ok(await write('forget_fact', { target: { id: f } }), 'forget_fact').forgotten,
    ).toHaveLength(1)
    expect(
      ok(await write('forget_fact', { target: { key: 'gym' } }), 'forget_fact').forgotten[0]?.key,
    ).toBe('gym')
    refused(await write('forget_fact', { target: { id: f } }), 'gone')
    refused(await write('forget_fact', { target: { key: 'nada' } }), 'gone')
    expect(ok(await write('list_facts'), 'list_facts').total).toBe(0)
  })

  it('has no tool for forgetting everything', async () => {
    const r = await rpc(app, a.access_token, 'tools/call', {
      name: 'warren_forget_all_facts',
      arguments: {},
    })
    expect(r.body?.error ?? r.body?.result?.isError).toBeTruthy()
  })
})

describe('warren_set_reminder and warren_cancel_reminder', () => {
  const inDays = (n: number) => ({
    what: 'pagar la Visa',
    first: { date: addDays(TODAY, n), time: '10:00' },
  })

  it('sets one the same way WhatsApp does, lists it, and cancels it', async () => {
    const set = ok(await write('set_reminder', inDays(3)), 'set_reminder')
    expect(set.reminder).toMatchObject({ what: 'pagar la Visa' })
    expect(set.record).toContain('Te aviso')
    expect(set.reminder.next_due_at).toBe(new Date(`${addDays(TODAY, 3)}T13:00:00Z`).toISOString())
    expect(ok(await write('list_reminders'), 'list_reminders').reminders).toHaveLength(1)
    const cancel = ok(await write('cancel_reminder', { id: set.reminder.id }), 'cancel_reminder')
    expect(cancel.record).toContain('Cancelé')
    expect(ok(await write('list_reminders'), 'list_reminders').reminders).toHaveLength(0)
    refused(await write('cancel_reminder', { id: set.reminder.id }), 'gone')
  })

  it('declines a passed time and one over a year away with their typed codes, and writes nothing', async () => {
    refused(
      await write('set_reminder', { what: 'x', first: { date: addDays(TODAY, -1) } }),
      'reminder_past',
    )
    refused(
      await write('set_reminder', { what: 'x', first: { date: addDays(TODAY, 500) } }),
      'reminder_far',
    )
    expect(await sql`SELECT 1 FROM reminder`).toHaveLength(0)
  })

  it('declines a reminder when the account has no WhatsApp address to send it to, with a typed code, and writes nothing', async () => {
    // The door admits only an account with an address, so this is the second check: the tool, under the account lock.
    const lonely = await newAccount(sql)
    const run = (accountId: number) =>
      runTool({ sql, accountId, now: () => new Date(1760000000 * 1000) }, 'set_reminder', inDays(3))
    const r = await run(lonely)
    expect(refused(r as never, 'no_whatsapp_address')).toContain('WhatsApp')
    expect(await sql`SELECT 1 FROM reminder WHERE account_id = ${lonely}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM turn WHERE account_id = ${lonely}`).toHaveLength(0)
    // The same call for an account that has one is written.
    expect((await run(accountA)).isError).toBeUndefined()
  })
})

describe('warren_undo_last over every store', () => {
  it('takes back an MCP write, then the one before it, and says what came back', async () => {
    const one = ok(await write('log_movements', { movements: [movement()] }), 'log_movements')
    const two = ok(
      await write('remember_fact', { kind: 'alias', key: 'gym', value: 'smartfit' }),
      'remember_fact',
    )
    const u2 = ok(await write('undo_last'), 'undo_last')
    expect(u2).toMatchObject({
      undone_turn: two.turn,
      items: [{ kind: 'fact_removed', fact: { key: 'gym' } }],
    })
    expect(await sql`SELECT 1 FROM fact WHERE ended_at IS NULL`).toHaveLength(0)
    const u1 = ok(await write('undo_last'), 'undo_last')
    expect(u1).toMatchObject({
      undone_turn: one.turn,
      items: [{ kind: 'logged', movement: { id: one.movements[0]?.id } }],
    })
    expect(await live()).toHaveLength(0)
    refused(await write('undo_last'), 'nothing')
  })

  it('also takes back reminders: MCP may undo every store', async () => {
    const set = ok(
      await write('set_reminder', { what: 'llamar', first: { date: addDays(TODAY, 4) } }),
      'set_reminder',
    )
    const u = ok(await write('undo_last'), 'undo_last')
    expect(u.items[0]).toMatchObject({
      kind: 'reminder_removed',
      reminder: { id: set.reminder.id, what: 'llamar' },
    })
    expect(ok(await write('list_reminders'), 'list_reminders').reminders).toHaveLength(0)
    // ...and brings a cancelled one back.
    const again = ok(
      await write('set_reminder', { what: 'llamar', first: { date: addDays(TODAY, 4) } }),
      'set_reminder',
    )
    await write('cancel_reminder', { id: again.reminder.id })
    const back = ok(await write('undo_last'), 'undo_last')
    expect(back.items[0]).toMatchObject({ kind: 'reminder_restored' })
  })

  it("never takes another person's turn, and refuses when what the turn touched changed since", async () => {
    const m = ok(await write('log_movements', { movements: [movement()] }), 'log_movements')
      .movements[0]?.id
    // Someone else's write is not this person's to undo.
    const b = await mint(app, WA_B)
    refused(await write('undo_last', {}, b), 'nothing')
    // A turn made after the log, on the same movement, goes first (the strict stack): an undo takes it, not the log under it.
    await write('correct_movement', { id: m, changes: { amount: '9000' } })
    const u = ok(await write('undo_last'), 'undo_last')
    expect(u.items[0]).toMatchObject({ kind: 'corrected' })
    expect(await live()).toEqual([{ id: m, description: 'café', amount: '3500' }])
  })
})

describe('request_id', () => {
  const log = (r?: string, extra: Record<string, unknown> = {}) =>
    write('log_movements', { movements: [movement(extra)], ...(r ? { request_id: r } : {}) })

  it('a retried call returns the first answer and writes nothing twice', async () => {
    const id = randomUUID()
    const first = ok(await log(id), 'log_movements')
    const retry = ok(await log(id), 'log_movements')
    expect(retry).toEqual({ ...first, replayed: true })
    expect(await live()).toHaveLength(1)
    expect(await turns()).toHaveLength(1)
  })

  it('the same id with other values is refused, writes nothing, and never answers with the first call', async () => {
    const id = randomUUID()
    ok(await log(id), 'log_movements')
    const other = await log(id, { amount: '9999' })
    expect(refused(other, 'request_id_reused')).toContain('different call')
    expect(JSON.stringify(other)).not.toContain('café')
    // Another tool under the same id is another call too.
    refused(
      await write('remember_fact', { kind: 'note', key: 'x', value: 'y', request_id: id }),
      'request_id_reused',
    )
    expect(await live()).toHaveLength(1)
  })

  it('the same key order does not matter, and a burst of the same request writes once', async () => {
    const id = randomUUID()
    const results = await Promise.all(Array.from({ length: 6 }, () => log(id)))
    const done = results.map((r) => ok(r, 'log_movements'))
    expect(done.filter((r) => !r.replayed)).toHaveLength(1)
    expect(new Set(done.map((r) => r.turn)).size).toBe(1)
    expect(await live()).toHaveLength(1)
  })

  it('without one, every call is its own; a refused request can be sent again with the same id', async () => {
    ok(await log(), 'log_movements')
    ok(await log(), 'log_movements')
    expect(await live()).toHaveLength(2)
    const id = randomUUID()
    refused(await log(id, { amount: 'abc' }), 'invalid')
    expect(await sql`SELECT 1 FROM mcp_request`).toHaveLength(0)
    ok(await log(id), 'log_movements')
  })

  it('an id belongs to its person: another account cannot replay it, and sees nothing of the first answer', async () => {
    const id = randomUUID()
    ok(await log(id), 'log_movements')
    const b = await mint(app, WA_B)
    const theirs = ok(
      await write(
        'log_movements',
        { movements: [movement({ description: 'de b' })], request_id: id },
        b,
      ),
      'log_movements',
    )
    expect(theirs.replayed).toBe(false)
    expect(theirs.movements[0]?.description).toBe('de b')
  })

  it('must be a uuid', async () => {
    const r = await rpc(app, a.access_token, 'tools/call', {
      name: 'warren_log_movements',
      arguments: { movements: [movement()], request_id: 'abc' },
    })
    expect(r.body?.error ?? r.body?.result?.isError).toBeTruthy()
    expect(await live()).toHaveLength(0)
  })
})
