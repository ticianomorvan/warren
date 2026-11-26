import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cafe } from '../../test/core'
import {
  type App,
  CLIENT_ID,
  type Connected,
  EMAIL_A,
  EMAIL_B,
  mint,
  withClaude,
} from '../auth-test-kit'
import { call, ok, refused, rpc } from '../mcp-test-kit'
import { sql, TODAY, useDatabase } from '../test-harness'
import { addDays } from '../time'

/** The write tools of `/mcp`: the registry's writes through `checkValues` and `core/turn.commit` for the token's OAuth client. */
useDatabase({ max: 12 })

let app: App
let a: Connected
let _accountA: number

const movement = (o: Record<string, unknown> = {}) => ({ ...cafe({ date: TODAY }), ...o })
const write = (name: string, args: Record<string, unknown> = {}, who = a) =>
  call(app, who.access_token, `warren_${name}`, args)
const turns = () =>
  sql<{ id: number; client: string }[]>`SELECT id::int, client FROM turn ORDER BY id`
const live = () => sql<{ id: number; description: string; amount: string }[]>`
  SELECT entity_id::int AS id, description, amount::text AS amount FROM movement WHERE ended_at IS NULL ORDER BY id`

beforeEach(async () => {
  ;({ app } = await withClaude())
  a = await mint(app, EMAIL_A)
  _accountA = Number(
    (await sql`SELECT warren_account_id AS id FROM auth_user WHERE email = ${EMAIL_A}`)[0]?.id,
  )
})
afterEach(() => app.close())

describe('warren_log_movements', () => {
  it('logs, renders the record, and leaves a turn for the client of the token that carries it', async () => {
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
    expect(row).toMatchObject({ id: r.turn, client: CLIENT_ID })
    expect(await live()).toHaveLength(2)
  })

  it('takes a movement without `confidence` (`high` is filled in)', async () => {
    const { confidence: _, ...bare } = movement()
    const r = ok(await write('log_movements', { movements: [bare] }), 'log_movements')
    expect(r.movements).toHaveLength(1)
    const [row] = await sql`SELECT confidence FROM movement`
    expect(row?.confidence).toBe('high')
  })

  it('refuses a text, a day or an amount longer than v1 allowed, whatever the body size', async () => {
    refused(
      await write('log_movements', { movements: [movement({ description: 'x'.repeat(200_000) })] }),
      'invalid',
    )
    refused(
      await write('log_movements', { movements: [movement({ payment: 'y'.repeat(201) })] }),
      'invalid',
    )
    refused(
      await write('log_movements', { movements: [movement({ amount: '1'.repeat(21) })] }),
      'invalid',
    )
    refused(
      await write('remember_fact', { kind: 'note', key: 'k', value: 'v'.repeat(201) }),
      'invalid',
    )
    refused(
      await call(app, a.access_token, 'warren_find_movements', { text: 'z'.repeat(201) }),
      'invalid',
    )
    refused(
      await call(app, a.access_token, 'warren_find_movements', {
        text: 'a1 b1 c1 d1 e1 f1 g1 h1 i1 j1 k1',
      }),
      'invalid',
    )
    expect(await live()).toHaveLength(0)
    // The same text inside the limit is fine.
    ok(
      await write('log_movements', { movements: [movement({ description: 'x'.repeat(200) })] }),
      'log_movements',
    )
  })

  it('declines a secret or contact data in a movement’s words, with a typed code, and stores nothing', async () => {
    refused(
      await write('log_movements', {
        movements: [movement({ description: 'clave del wifi perro' })],
      }),
      'secret',
    )
    refused(
      await write('log_movements', {
        movements: [movement({ description: 'transferencia a juan@mail.com' })],
      }),
      'contact',
    )
    const m = ok(await write('log_movements', { movements: [movement()] }), 'log_movements')
      .movements[0]?.id
    refused(
      await write('correct_movement', {
        id: m,
        changes: { payment: 'cbu 0170099220000067797370' },
      }),
      'secret',
    )
    refused(
      await write('correct_movement', { id: m, changes: { description: 'mail juan@mail.com' } }),
      'contact',
    )
    // Only the plain log was written: the declined calls left no turn and no row.
    expect(await live()).toHaveLength(1)
    expect(await turns()).toHaveLength(1)
    expect(JSON.stringify(await sql`SELECT calls, record FROM turn`)).not.toMatch(/wifi|juan/)
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
      'secret',
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
    const theirs = (await sql`SELECT entity_id::int AS id FROM movement LIMIT 1`)[0]?.id
    const b = await mint(app, EMAIL_B)
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

  it("never takes another person's turn, and refuses when what the turn touched changed since", async () => {
    const m = ok(await write('log_movements', { movements: [movement()] }), 'log_movements')
      .movements[0]?.id
    // Someone else's write is not this person's to undo.
    const b = await mint(app, EMAIL_B)
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
    const b = await mint(app, EMAIL_B)
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
