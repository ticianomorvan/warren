import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { realPostgres } from '../test/db'
import {
  type App,
  browser,
  CLIENT_ID,
  type Connected,
  claims,
  connect,
  mint,
  openSignIn,
  pkce,
  REDIRECT,
  token,
  WA_A,
  WA_B,
  whatsapp,
  withClaude,
} from './auth-test-kit'
import { ask, correct, helpCall, script } from './command-fixtures'
import * as kit from './mcp-test-kit'
import { accountOf, call, ok, refusal } from './mcp-test-kit'
import { REPLY_DISCONNECT } from './render'
import { fakeModel, settle, sql, until, useDatabase } from './test-harness'

/**
 * Slice 5.3: the six write tools over MCP, sharing the WhatsApp commit path (`applyCall`). A real token, JSON-RPC over
 * HTTP, and the WhatsApp pipeline in the same server: a change from one channel is seen, and undone, from the other.
 * On PGlite; with PG_TEST_URL set, on a real Postgres in its own schema (and the concurrency test runs).
 */
useDatabase({ max: 12 })

const NOW = new Date('2026-11-18T15:30:00.000Z')

let app: App
let a: Connected
let b: Connected
let allowed: string[]
const WA_C = '5491100000003'
const rpc = (
  bearer: string | null,
  method: string,
  params: unknown = {},
  extra: Record<string, string> = {},
) => kit.rpc(app, bearer, method, params, extra)
const tool = (bearer: string, name: string, args: Record<string, unknown> = {}) =>
  call(app, bearer, name, args)
const forge = (scope: string) => kit.forge(app, a.userId, { claims: { scope } })

const cafe = {
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: '2026-11-18',
  description: 'café',
  category: 'restaurantes',
  payment: 'efectivo',
}
const log = (...movements: Record<string, unknown>[]) => ({
  movements: movements.length ? movements : [cafe],
})

async function boot(model?: ReturnType<typeof fakeModel>) {
  allowed = [WA_A, WA_B, WA_C]
  ;({ app } = await withClaude({ allowed, now: () => NOW, ...(model ? { model } : {}) }))
  a = await mint(app, WA_A)
  b = await mint(app, WA_B)
}
beforeEach(() => boot())
afterEach(() => app.close())

const live = async (wa: string) =>
  sql`SELECT m.id::int AS id, m.description, m.amount::text AS amount, m.inbound_message_id::int AS batch
    FROM movement m JOIN account a ON a.id = m.account_id
    WHERE a.wa_id = ${wa} AND m.superseded_by IS NULL AND m.deleted_at IS NULL ORDER BY m.id`
const mcpRows = () => sql`SELECT * FROM inbound_message WHERE channel = 'mcp' ORDER BY id`
const REQ = () => crypto.randomUUID()

// ---- Each write tool

describe('warren_log_movements', () => {
  it('logs, renders the record, and leaves the batch the undo of either channel can see', async () => {
    const out = ok(
      await tool(
        a.access_token,
        'warren_log_movements',
        log(cafe, { ...cafe, description: 'súper', amount: '12000.50', category: 'supermercado' }),
      ),
      'log',
    )
    expect(out.movements.map((m) => [m.description, m.amount, m.display])).toEqual([
      ['café', '3500', '$3.500'],
      ['súper', '12000.50', '$12.000,50'],
    ])
    expect(out.record).toBe('✓ Anoté 2:\n• Café $3.500 (efectivo)\n• Súper $12.000,50 (efectivo)')
    expect(out.undo).toContain('warren_undo_last')
    expect(out.undo).toContain('deshacer')
    // The batch: a settled inbound row of channel mcp that carries the account's wa_id and a summary.
    const [row] = await mcpRows()
    expect(row).toMatchObject({
      id: String(out.batch),
      channel: 'mcp',
      status: 'done',
      wa_id: WA_A,
      kind: 'tool',
      action: 'log',
      body: null,
      reply_text: out.record,
    })
    expect(row?.wamid).toMatch(/^mcp:[0-9a-f-]{36}$/)
    const movements =
      await sql`SELECT inbound_message_id::int AS batch, position, confidence FROM movement ORDER BY id`
    expect(movements.every((m) => m.batch === out.batch && m.confidence === 'high')).toBe(true)
    expect(movements.map((m) => m.position)).toEqual([0, 1])
    // What was stored of the call, with its audit.
    expect(row?.command).toEqual([
      { tool: 'log_movements', input: expect.objectContaining({ movements: expect.any(Array) }) },
    ])
    expect(row?.tool_calls).toMatchObject([{ tool: 'log_movements', status: 'applied', action: 0 }])
  })

  it('refuses what a table cannot hold, with the reason, and writes nothing', async () => {
    const bad = async (movement: Record<string, unknown>) =>
      refusal(await tool(a.access_token, 'warren_log_movements', log(movement)))
    expect(await bad({ ...cafe, amount: '3.500,00' })).toContain('amount')
    expect(await bad({ ...cafe, date: '2026-11-19' })).toContain('after today')
    expect(await bad({ ...cafe, date: '2026-02-30' })).toContain('does not exist')
    expect(await bad({ ...cafe, description: 'cuenta 123456789' })).toMatch(/digits|number/)
    const tooMany = await rpc(a.access_token, 'tools/call', {
      name: 'warren_log_movements',
      arguments: log(...Array(11).fill(cafe)),
    })
    expect(tooMany.body?.error ?? tooMany.body?.result?.isError).toBeTruthy()
    expect(await live(WA_A)).toHaveLength(0)
    expect(await mcpRows()).toHaveLength(0)
  })

  it('a secret in the call keeps no inputs: not in the stored command, not in the audit, not in the body', async () => {
    const out = ok(
      await tool(
        a.access_token,
        'warren_log_movements',
        log({ ...cafe, description: 'la contraseña del wifi' }),
      ),
      'log',
    )
    expect(out.movements).toHaveLength(1)
    const [row] = await mcpRows()
    expect(JSON.stringify(row?.command)).not.toContain('contraseña')
    expect(JSON.stringify(row?.tool_calls)).not.toContain('contraseña')
    expect(row?.body).toBe('[dato sensible, no guardado]')
    // No raw inputs are kept; the rendered record (what the reply and the movement row hold anyway) is.
    expect(row?.reply_text).toContain('contraseña')
  })
})

describe('warren_correct_movement', () => {
  it('adds a corrected version, keeps the old one replaced, and shows before and after', async () => {
    const id = await boot0()
    const out = ok(
      await tool(a.access_token, 'warren_correct_movement', {
        id,
        changes: { amount: '3800', payment: 'visa' },
      }),
      'correct',
    )
    expect(out.changed.sort()).toEqual(['money', 'payment'])
    expect([out.before.amount, out.after.amount]).toEqual(['3500', '3800'])
    expect(out.after.display).toBe('$3.800')
    expect(out.after.id).not.toBe(id)
    expect(out.record).toMatch(/^✓ Corregido: Café \$3\.800 \(visa\) \(antes \$3\.500, efectivo\)/)
    const history =
      await sql`SELECT id::int AS id, superseded_by::int AS next, inbound_message_id::int AS batch FROM movement ORDER BY id`
    expect(history).toEqual([
      { id, next: out.after.id, batch: expect.any(Number) },
      { id: out.after.id, next: null, batch: out.batch },
    ])
    expect((await live(WA_A)).map((m) => m.amount)).toEqual(['3800'])
  })

  it('a no-op changes nothing and leaves no batch', async () => {
    const id = await boot0()
    const before = (await mcpRows()).length
    const out = ok(
      await tool(a.access_token, 'warren_correct_movement', { id, changes: { amount: '3500' } }),
      'correct',
    )
    expect(out).toMatchObject({ batch: null, undo: null, changed: [] })
    expect(await mcpRows()).toHaveLength(before)
  })

  it("refuses a movement that was already corrected or deleted, one that does not exist, and another person's", async () => {
    const id = await boot0()
    ok(
      await tool(a.access_token, 'warren_correct_movement', { id, changes: { amount: '3800' } }),
      'correct',
    )
    // The old version is replaced.
    expect(
      refusal(
        await tool(a.access_token, 'warren_correct_movement', { id, changes: { amount: '4000' } }),
      ),
    ).toContain('already corrected or deleted')
    expect(
      refusal(
        await tool(a.access_token, 'warren_correct_movement', {
          id: 99999,
          changes: { amount: '4000' },
        }),
      ),
    ).toContain('not found')
    // B's movement, with A's token: refused, untouched.
    const [mine] = await live(WA_A)
    const other = ok(
      await tool(b.access_token, 'warren_log_movements', log({ ...cafe, description: 'de B' })),
      'log',
    )
    const theirs = other.movements[0]?.id as number
    expect(
      refusal(
        await tool(a.access_token, 'warren_correct_movement', {
          id: theirs,
          changes: { amount: '1' },
        }),
      ),
    ).toContain('not found')
    expect(refusal(await tool(a.access_token, 'warren_delete_movement', { id: theirs }))).toContain(
      'not found',
    )
    expect((await live(WA_B)).map((m) => [m.id, m.amount])).toEqual([[theirs, '3500']])
    expect(mine?.amount).toBe('3800')
    // Refusals leave no batch behind.
    expect(await mcpRows()).toHaveLength(3)
  })

  it('refuses an empty correction and a value that cannot be stored', async () => {
    const id = await boot0()
    expect(
      refusal(await tool(a.access_token, 'warren_correct_movement', { id, changes: {} })),
    ).toContain('changes is empty')
    expect(
      refusal(
        await tool(a.access_token, 'warren_correct_movement', { id, changes: { amount: '-5' } }),
      ),
    ).toContain('amount')
  })
})

/** A logs one café over MCP. */
async function boot0(): Promise<number> {
  const out = ok(await tool(a.access_token, 'warren_log_movements', log(cafe)), 'log')
  return out.movements[0]?.id as number
}

describe('warren_delete_movement', () => {
  it('marks the movement deleted by its batch; it counts no more and the record says what went', async () => {
    const id = await boot0()
    const out = ok(await tool(a.access_token, 'warren_delete_movement', { id }), 'deleted')
    expect(out.deleted.id).toBe(id)
    expect(out.record).toMatch(/^✓ Borré: Café \$3\.500/)
    expect(await live(WA_A)).toHaveLength(0)
    const [row] =
      await sql`SELECT deleted_by::int AS by, deleted_at IS NOT NULL AS gone FROM movement WHERE id = ${id}`
    expect(row).toEqual({ by: out.batch, gone: true })
    // The row is still there: nothing was removed.
    expect(await sql`SELECT 1 FROM movement`).toHaveLength(1)
    expect(refusal(await tool(a.access_token, 'warren_delete_movement', { id }))).toContain(
      'already corrected or deleted',
    )
  })
})

describe('warren_remember_fact and warren_forget_fact', () => {
  it('remembers, updates, and says when nothing changed', async () => {
    const remember = (value: string) =>
      tool(a.access_token, 'warren_remember_fact', { kind: 'alias', key: 'la visa', value })
    const first = ok(await remember('Galicia'), 'remembered')
    expect(first).toMatchObject({
      status: 'new',
      fact: { kind: 'alias', key: 'la visa', value: 'Galicia' },
      previous_value: null,
    })
    expect(first.record).toContain('la visa')
    const again = ok(await remember('galicia'), 'remembered')
    expect(again).toMatchObject({ status: 'unchanged', batch: null })
    const changed = ok(await remember('Santander'), 'remembered')
    expect(changed).toMatchObject({ status: 'updated', previous_value: 'Galicia' })
    const facts = ok(await tool(a.access_token, 'warren_list_facts'), 'facts')
    expect(facts.facts.map((f) => f.value)).toEqual(['Santander'])
    // The row: its batch is the MCP request's.
    const [f] =
      await sql`SELECT inbound_message_id::int AS batch FROM fact WHERE superseded_by IS NULL`
    expect(f?.batch).toBe(changed.batch)
  })

  it('refuses a secret and contact data, and keeps nothing', async () => {
    const remember = (key: string, value: string) =>
      tool(a.access_token, 'warren_remember_fact', { kind: 'note', key, value })
    expect(refusal(await remember('tarjeta', '4509 9535 6623 3704'))).toContain('No guardo')
    expect(refusal(await remember('clave', 'hunter2'))).toContain('No guardo')
    expect(refusal(await remember('mi mail', 'ticiano@example.com'))).toContain('No guardo')
    expect(await sql`SELECT 1 FROM fact`).toHaveLength(0)
    expect(await mcpRows()).toHaveLength(0)
  })

  it('refuses a value that does not fit and a full account', async () => {
    expect(
      refusal(
        await tool(a.access_token, 'warren_remember_fact', {
          kind: 'category',
          key: 'café',
          value: 'bebidas',
        }),
      ),
    ).toContain('exactly one of')
    const account = await accountOf(WA_A)
    const [inbound] =
      await sql`INSERT INTO inbound_message (wamid, wa_id, kind, payload, status) VALUES ('seed.full', ${WA_A}, 'text', '{}'::jsonb, 'done') RETURNING id`
    await sql`INSERT INTO fact ${sql(Array.from({ length: 100 }, (_, i) => ({ account_id: account, kind: 'note', key: `cosa ${i}`, value: 'x', inbound_message_id: inbound?.id })))}`
    expect(
      refusal(
        await tool(a.access_token, 'warren_remember_fact', {
          kind: 'note',
          key: 'una mas',
          value: 'y',
        }),
      ),
    ).toContain('forget one first')
  })

  it('forgets by id or by key, only its own, and refuses what is not there', async () => {
    const remembered = ok(
      await tool(a.access_token, 'warren_remember_fact', {
        kind: 'note',
        key: 'cobro',
        value: 'el cinco',
      }),
      'remembered',
    )
    const theirs = ok(
      await tool(b.access_token, 'warren_remember_fact', {
        kind: 'note',
        key: 'solo de b',
        value: 'privado',
      }),
      'remembered',
    )
    // A cannot reach B's fact by its id, nor by its key.
    expect(
      refusal(await tool(a.access_token, 'warren_forget_fact', { id: theirs.fact.id })),
    ).toContain('not found')
    expect(
      refusal(await tool(a.access_token, 'warren_forget_fact', { key: 'solo de b' })),
    ).toContain('nothing remembered')
    const byId = ok(
      await tool(a.access_token, 'warren_forget_fact', { id: remembered.fact.id }),
      'forgotten',
    )
    expect(byId.forgotten.map((f) => f.key)).toEqual(['cobro'])
    expect(
      refusal(await tool(a.access_token, 'warren_forget_fact', { id: remembered.fact.id })),
    ).toContain('already forgotten')
    const second = ok(
      await tool(a.access_token, 'warren_remember_fact', {
        kind: 'note',
        key: 'otra',
        value: 'cosa',
      }),
      'remembered',
    )
    const byKey = ok(await tool(a.access_token, 'warren_forget_fact', { key: 'otra' }), 'forgotten')
    expect(byKey.forgotten[0]?.id).toBe(second.fact.id)
    expect(refusal(await tool(a.access_token, 'warren_forget_fact', {}))).toContain('id of a fact')
    expect(
      ok(await tool(b.access_token, 'warren_list_facts'), 'facts').facts.map((f) => f.key),
    ).toEqual(['solo de b'])
  })

  it('has no tool for forgetting everything', async () => {
    const r = await rpc(a.access_token, 'tools/call', {
      name: 'warren_forget_all_facts',
      arguments: {},
    })
    expect(r.body?.error ?? r.body?.result?.isError).toBeTruthy()
  })
})

// ---- Undo, across channels

describe('undo spans both channels', () => {
  it('warren_undo_last takes back an MCP write, then the one before it', async () => {
    const first = ok(await tool(a.access_token, 'warren_log_movements', log(cafe)), 'log')
    ok(
      await tool(a.access_token, 'warren_remember_fact', {
        kind: 'note',
        key: 'cobro',
        value: 'el cinco',
      }),
      'remembered',
    )
    const undo1 = ok(await tool(a.access_token, 'warren_undo_last', {}), 'undone')
    expect(undo1.items.map((i) => i.kind)).toEqual(['fact_removed'])
    const undo2 = ok(await tool(a.access_token, 'warren_undo_last', {}), 'undone')
    expect(undo2.undone_batch).toBe(first.batch)
    expect(undo2.items.map((i) => [i.kind, i.movement?.description])).toEqual([['logged', 'café']])
    expect(undo2.record).toBe('↩︎ Deshice: Café $3.500 (efectivo)')
    expect(await live(WA_A)).toHaveLength(0)
    expect(refusal(await tool(a.access_token, 'warren_undo_last', {}))).toContain('nothing to undo')
    // The undo is itself a batch of the mcp channel, marked as the undo of the first.
    const undoRows =
      await sql`SELECT undoes::int AS undoes FROM inbound_message WHERE channel = 'mcp' AND undoes IS NOT NULL ORDER BY id`
    expect(undoRows.map((r) => r.undoes)).toHaveLength(2)
  })

  it('an MCP write is undone by "deshacer" on WhatsApp, with no model call', async () => {
    const out = ok(
      await tool(a.access_token, 'warren_log_movements', log({ ...cafe, description: 'zzzmcp' })),
      'log',
    )
    expect(await live(WA_A)).toHaveLength(1)
    const [reply] = await whatsapp(app, WA_A, 'deshacer')
    expect(reply).toContain('↩︎ Deshice: Zzzmcp $3.500 (efectivo)')
    expect(app.model.n).toBe(0)
    expect(await live(WA_A)).toHaveLength(0)
    const [undoRow] =
      await sql`SELECT undoes::int AS undoes, channel FROM inbound_message WHERE undoes IS NOT NULL`
    expect(undoRow).toEqual({ undoes: out.batch, channel: 'whatsapp' })
  })

  it('a WhatsApp write is undone by warren_undo_last', async () => {
    const [reply] = await whatsapp(app, WA_A, 'café 3500')
    expect(reply).toContain('Café')
    expect(await live(WA_A)).toHaveLength(1)
    const out = ok(await tool(a.access_token, 'warren_undo_last', {}), 'undone')
    expect(out.items.map((i) => i.kind)).toEqual(['logged'])
    expect(await live(WA_A)).toHaveLength(0)
    const [undoRow] = await sql`SELECT channel FROM inbound_message WHERE undoes IS NOT NULL`
    expect(undoRow?.channel).toBe('mcp')
  })

  it('takes the newest batch of either channel, in order', async () => {
    await whatsapp(app, WA_A, 'café 3500') // WhatsApp batch
    const mcp = ok(
      await tool(a.access_token, 'warren_log_movements', log({ ...cafe, description: 'después' })),
      'log',
    )
    expect(ok(await tool(a.access_token, 'warren_undo_last', {}), 'undone').undone_batch).toBe(
      mcp.batch,
    )
    const [reply] = await whatsapp(app, WA_A, 'deshacer')
    expect(reply).toContain('↩︎ Deshice: Café')
    expect(await live(WA_A)).toHaveLength(0)
  })

  it('warren_undo_last refuses a batch that set or cancelled reminders: they are undone from WhatsApp, and nothing changes', async () => {
    app.close()
    const setReminder = {
      name: 'set_reminder',
      input: {
        what: 'pagar la Visa',
        schedule: { start: '2025-10-10', time: '09:00', interval: 1 },
        text: null,
      },
    }
    await boot(script(setReminder, setReminder))
    const [reply] = await whatsapp(app, WA_A, 'recordame mañana pagar la visa')
    expect(reply).toContain('⏰ Te aviso')
    expect(refusal(await tool(a.access_token, 'warren_undo_last', {}))).toContain('WhatsApp')
    const [live] = await sql`SELECT count(*)::int AS n FROM reminder WHERE cancelled_at IS NULL`
    expect(live?.n).toBe(1)
    // The batch is still there for the person: "deshacer" on WhatsApp takes it back.
    const [undone] = await whatsapp(app, WA_A, 'deshacer')
    expect(undone).toBe('↩︎ Deshice:\n• Quité ⏰ pagar la Visa')
    // A batch before it (an MCP log) is undone from MCP as ever.
    const out = ok(await tool(a.access_token, 'warren_log_movements', log(cafe)), 'log')
    expect(ok(await tool(a.access_token, 'warren_undo_last', {}), 'undone').undone_batch).toBe(
      out.batch,
    )
  })

  it("never takes another person's batch", async () => {
    ok(await tool(b.access_token, 'warren_log_movements', log(cafe)), 'log')
    expect(refusal(await tool(a.access_token, 'warren_undo_last', {}))).toContain('nothing to undo')
    expect(await live(WA_B)).toHaveLength(1)
  })

  it('is refused past 24 hours, and when what the batch touched changed since', async () => {
    const first = ok(await tool(a.access_token, 'warren_log_movements', log(cafe)), 'log')
    await sql`UPDATE inbound_message SET received_at = now() - interval '25 hours' WHERE id = ${first.batch}`
    expect(refusal(await tool(a.access_token, 'warren_undo_last', {}))).toContain('24 hours')
    await sql`UPDATE inbound_message SET received_at = now() WHERE id = ${first.batch}`
    // Something that is not a batch deleted the movement since.
    const [stranger] =
      await sql`INSERT INTO inbound_message (wamid, wa_id, kind, payload, status) VALUES ('stranger', ${WA_A}, 'text', '{}'::jsonb, 'done') RETURNING id`
    await sql`UPDATE movement SET deleted_at = now(), deleted_by = ${stranger?.id}`
    expect(refusal(await tool(a.access_token, 'warren_undo_last', {}))).toMatch(
      /Nothing was undone: movement \d+ changed/,
    )
    expect(await sql`SELECT 1 FROM inbound_message WHERE undoes IS NOT NULL`).toHaveLength(0)
  })
})

// ---- Idempotency

describe('request_id', () => {
  it('a retried call returns the first answer and writes nothing twice', async () => {
    const request_id = REQ()
    const first = await tool(a.access_token, 'warren_log_movements', { ...log(cafe), request_id })
    const again = await tool(a.access_token, 'warren_log_movements', { ...log(cafe), request_id })
    expect(ok(again, 'log')).toEqual({ ...ok(first, 'log'), replayed: true })
    expect(ok(first, 'log').replayed).toBe(false)
    expect(await live(WA_A)).toHaveLength(1)
    expect(await mcpRows()).toHaveLength(1)
    expect((await mcpRows())[0]?.wamid).toBe(`mcp:${request_id}`)
  })

  it('the same id with other values is refused, writes nothing, and never answers with the first call', async () => {
    const request_id = REQ()
    const first = ok(
      await tool(a.access_token, 'warren_log_movements', { ...log(cafe), request_id }),
      'log',
    )
    // The client reused a uuid for another call: "nafta 20000", not the café.
    const nafta = { ...cafe, description: 'nafta', amount: '20000', category: 'combustible' }
    const refused = refusal(
      await tool(a.access_token, 'warren_log_movements', { ...log(nafta), request_id }),
    )
    expect(refused).toContain('already used for a different call')
    expect(refused).not.toContain('café')
    expect((await live(WA_A)).map((m) => m.description)).toEqual(['café']) // nafta was never logged
    expect(await mcpRows()).toHaveLength(1)
    // Any one value is another call.
    for (const other of [
      { ...cafe, amount: '3501' },
      { ...cafe, date: '2026-11-17' },
      { ...cafe, payment: 'visa' },
    ]) {
      expect(
        refusal(await tool(a.access_token, 'warren_log_movements', { ...log(other), request_id })),
      ).toContain('different call')
    }
    // The same call, with its fields written in another order, is the same call.
    const reordered = {
      payment: 'efectivo',
      category: 'restaurantes',
      description: 'café',
      date: '2026-11-18',
      currency: 'ARS',
      amount: '3500',
      direction: 'out',
    }
    const again = ok(
      await tool(a.access_token, 'warren_log_movements', { ...log(reordered), request_id }),
      'log',
    )
    expect(again).toEqual({ ...first, replayed: true })
    // The same goes for the other tools: a correction of another movement is another call.
    const id = first.movements[0]?.id as number
    const rid = REQ()
    ok(
      await tool(a.access_token, 'warren_correct_movement', {
        id,
        changes: { amount: '3800' },
        request_id: rid,
      }),
      'correct',
    )
    expect(
      refusal(
        await tool(a.access_token, 'warren_correct_movement', {
          id,
          changes: { amount: '3900' },
          request_id: rid,
        }),
      ),
    ).toContain('different call')
    expect((await live(WA_A)).map((m) => m.amount)).toEqual(['3800'])
  })

  it('a burst of the same request writes once', async () => {
    const request_id = REQ()
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        tool(a.access_token, 'warren_log_movements', { ...log(cafe), request_id }),
      ),
    )
    const outputs = results.map((r) => ok(r, 'log'))
    expect(new Set(outputs.map((o) => o.batch)).size).toBe(1)
    expect(await live(WA_A)).toHaveLength(1)
  })

  it('without one, every call is its own', async () => {
    await tool(a.access_token, 'warren_log_movements', log(cafe))
    await tool(a.access_token, 'warren_log_movements', log(cafe))
    expect(await live(WA_A)).toHaveLength(2)
  })

  it('an id used by another tool, or by another person, is refused and shows nothing of the first', async () => {
    const request_id = REQ()
    ok(
      await tool(a.access_token, 'warren_log_movements', {
        ...log({ ...cafe, description: 'privado de A' }),
        request_id,
      }),
      'log',
    )
    const otherTool = refusal(
      await tool(a.access_token, 'warren_remember_fact', {
        kind: 'note',
        key: 'x',
        value: 'y',
        request_id,
      }),
    )
    expect(otherTool).toContain('already used')
    const otherPerson = refusal(
      await tool(b.access_token, 'warren_log_movements', { ...log(cafe), request_id }),
    )
    expect(otherPerson).toContain('already used')
    expect(otherPerson).not.toContain('privado')
    expect(await live(WA_B)).toHaveLength(0)
  })

  it('a request that was refused can be sent again with the same id', async () => {
    const request_id = REQ()
    expect(
      refusal(await tool(a.access_token, 'warren_delete_movement', { id: 12345, request_id })),
    ).toContain('not found')
    const logged = ok(await tool(a.access_token, 'warren_log_movements', log(cafe)), 'log')
    const id = logged.movements[0]?.id as number
    ok(await tool(a.access_token, 'warren_delete_movement', { id, request_id }), 'deleted')
  })

  it('must be a uuid', async () => {
    const r = await rpc(a.access_token, 'tools/call', {
      name: 'warren_log_movements',
      arguments: { ...log(cafe), request_id: 'not-a-uuid' },
    })
    expect(r.body?.error ?? r.body?.result?.isError).toBeTruthy()
  })
})

// ---- Scope

describe('ledger:write', () => {
  const WRITE_CALLS: [string, Record<string, unknown>][] = [
    ['warren_log_movements', log(cafe)],
    ['warren_correct_movement', { id: 1, changes: { amount: '1' } }],
    ['warren_delete_movement', { id: 1 }],
    ['warren_undo_last', {}],
    ['warren_remember_fact', { kind: 'note', key: 'a', value: 'b' }],
    ['warren_forget_fact', { id: 1 }],
  ]
  it.each(WRITE_CALLS)(
    '%s: a read-only token gets 403 insufficient_scope naming ledger:write, and nothing is written',
    async (name, args) => {
      const readOnly = await forge('ledger:read')
      const r = await rpc(readOnly, 'tools/call', { name, arguments: args })
      expect(r.status).toBe(403)
      const challenge = r.headers.get('www-authenticate') ?? ''
      expect(challenge).toContain('error="insufficient_scope"')
      expect(challenge).toContain('scope="ledger:write"')
      expect(await mcpRows()).toHaveLength(0)
      expect(await sql`SELECT 1 FROM movement`).toHaveLength(0)
      expect(await sql`SELECT 1 FROM fact`).toHaveLength(0)
    },
  )

  it('a write-only token writes and cannot read; a token with both does both', async () => {
    const writeOnly = await forge('ledger:write')
    expect(
      ok(await call(app, writeOnly, 'warren_log_movements', log(cafe)), 'log').movements,
    ).toHaveLength(1)
    expect(
      (await rpc(writeOnly, 'tools/call', { name: 'warren_list_facts', arguments: {} })).status,
    ).toBe(403)
    expect(ok(await tool(a.access_token, 'warren_list_facts'), 'facts').total).toBe(0)
  })
})

// ---- WhatsApp does not see MCP rows

describe('the MCP rows are not WhatsApp messages', () => {
  it('the conversation window and the context of the model ignore them', async () => {
    await whatsapp(app, WA_A, 'hola') // a WhatsApp turn: it does appear
    ok(
      await tool(a.access_token, 'warren_log_movements', log({ ...cafe, description: 'zzzmcp' })),
      'log',
    )
    await whatsapp(app, WA_A, 'otra cosa')
    const context = JSON.stringify(app.requests.at(-1))
    expect(context).toContain('(Warren) ✓ Café') // the WhatsApp turn
    expect(context).not.toMatch(/\(Warren\)[^"]*zzzmcp/i) // the MCP summary is not a turn
    expect(context).toMatch(/zzzmcp/i) // but the movement is in the person's list, as any is
  })

  it("an MCP write between WhatsApp's question and its bare answer does not take the question away", async () => {
    app.close()
    let ids: number[] = []
    await boot(fakeModel(() => [ask(ids, { question: 'Cuál', after: 'delete' })]))
    ids = ok(
      await tool(
        a.access_token,
        'warren_log_movements',
        log({ ...cafe, description: 'uno' }, { ...cafe, description: 'dos' }),
      ),
      'log',
    ).movements.map((m) => m.id as number)
    const [question] = await whatsapp(app, WA_A, 'borrá el café')
    expect(question).toContain('1.')
    // Between the question and the answer: an MCP write (its row is the newest of this sender).
    ok(
      await tool(a.access_token, 'warren_log_movements', log({ ...cafe, description: 'zzzmcp' })),
      'log',
    )
    const modelCalls = app.model.n
    const [answer] = await whatsapp(app, WA_A, '1')
    expect(answer).toContain('✓ Borré')
    expect(app.model.n).toBe(modelCalls) // answered by code, from the stored options
  })

  it('the claim and the sweep never pick up an MCP row, even one left pending', async () => {
    ok(await tool(a.access_token, 'warren_log_movements', log(cafe)), 'log')
    await sql`UPDATE inbound_message SET status = 'pending', reply_text = NULL WHERE channel = 'mcp'`
    const sent = app.calls.sent.length
    await app.processor.sweep()
    await settle()
    expect(app.calls.sent).toHaveLength(sent)
    expect(app.model.n).toBe(0)
    expect((await mcpRows())[0]).toMatchObject({ status: 'pending', attempts: 0, claimed_at: null })
    // A WhatsApp row in the same state is claimed and answered.
    await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status) VALUES ('wamid.PENDING', ${WA_A}, 'text', 'café 3500', '{}'::jsonb, 'pending')`
    await app.processor.sweep()
    await until(() => app.calls.sent.length === sent + 1)
  })

  it('a stale MCP row is never settled by the sweep either', async () => {
    ok(await tool(a.access_token, 'warren_log_movements', log(cafe)), 'log')
    await sql`UPDATE inbound_message SET status = 'processing', claimed_at = now() - interval '1 hour', attempts = 9 WHERE channel = 'mcp'`
    await app.processor.sweep()
    expect((await mcpRows())[0]).toMatchObject({ status: 'processing', attempts: 9, error: null })
  })
})

// ---- desconectar

describe('"desconectar"', () => {
  it('cuts the connection: a live token dies on its next call, the refresh token fails, consents and sessions go', async () => {
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
    expect(ok(await tool(a.access_token, 'warren_list_facts'), 'facts').total).toBe(0)
    const [before] =
      await sql`SELECT (SELECT count(*) FROM auth_oauth_consent)::int AS consents, (SELECT count(*) FROM auth_session)::int AS sessions`
    expect(before?.consents).toBeGreaterThan(0)

    const [reply] = await whatsapp(app, WA_A, 'desconectar')
    expect(reply).toBe(REPLY_DISCONNECT.done(1))
    expect(app.model.n).toBe(0)

    const dead = await rpc(a.access_token, 'tools/list')
    expect(dead.status).toBe(401)
    expect(dead.headers.get('www-authenticate')).toContain('resource_metadata=')
    // The refresh token is revoked.
    const refreshed = await token(a.b, {
      grant_type: 'refresh_token',
      refresh_token: a.refresh_token,
      client_id: CLIENT_ID,
    })
    expect(refreshed.status).toBe(400)
    expect(((await refreshed.json()) as { error: string }).error).toBe('invalid_grant')
    const [after] = await sql`
      SELECT (SELECT count(*) FROM auth_oauth_consent WHERE "userId" = ${a.userId}::uuid)::int AS consents,
             (SELECT count(*) FROM auth_session WHERE "userId" = ${a.userId}::uuid)::int AS sessions,
             (SELECT count(*) FROM auth_oauth_refresh_token WHERE "userId" = ${a.userId}::uuid AND revoked IS NULL)::int AS refresh,
             (SELECT mcp_revoked_at IS NOT NULL FROM account WHERE wa_id = ${WA_A}) AS stamped`
    expect(after).toEqual({ consents: 0, sessions: 0, refresh: 0, stamped: true })
    // Nobody else's connection was touched, and nothing was lost.
    expect((await rpc(b.access_token, 'tools/list')).status).toBe(200)
    // The action is a code command of the whatsapp channel.
    const [row] =
      await sql`SELECT action, model_turns FROM inbound_message WHERE wa_id = ${WA_A} AND channel = 'whatsapp' ORDER BY id DESC LIMIT 1`
    expect(row).toMatchObject({ action: 'disconnect', model_turns: 0 })
  })

  it('an authorization code issued just before the cut cannot be exchanged after it', async () => {
    const c = browser(app.base)
    const { verifier, challenge } = pkce()
    // The consent was given and the client holds a code, not yet exchanged.
    const back = await connect(app, c, { challenge, from: WA_C })
    const code = back.searchParams.get('code') ?? ''
    expect(code).not.toBe('')
    expect(
      await sql`SELECT 1 FROM auth_verification WHERE value LIKE '%authorization_code%'`,
    ).toHaveLength(1)
    expect((await whatsapp(app, WA_C, 'desconectar'))[0]).toBe(REPLY_DISCONNECT.done(1))
    expect(
      await sql`SELECT 1 FROM auth_verification WHERE value LIKE '%authorization_code%'`,
    ).toHaveLength(0)
    const exchanged = await token(c, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: `${app.base}/mcp`,
    })
    expect(exchanged.status).toBe(400)
    expect(((await exchanged.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('the help tells how, where connecting an agent is on', async () => {
    app.close()
    await boot(script(helpCall))
    expect((await whatsapp(app, WA_A, 'ayuda'))[0]).toContain('escribime "desconectar"')
  })

  it('also by "desconectá a Claude", and says when there was nothing to cut', async () => {
    expect((await whatsapp(app, WA_A, 'desconectá a Claude'))[0]).toBe(REPLY_DISCONNECT.done(1))
    expect((await whatsapp(app, WA_A, 'Desconectar.'))[0]).toBe(REPLY_DISCONNECT.none)
    expect((await whatsapp(app, WA_B, 'por favor desconectar todo'))[0]).toBe(
      REPLY_DISCONNECT.done(1),
    )
  })

  it('the person can connect again: a new sign-in gives tokens newer than the cut', async () => {
    await whatsapp(app, WA_A, 'desconectar')
    await new Promise((r) => setTimeout(r, 1100)) // tokens are stamped in whole seconds
    const again = await mint(app, WA_A)
    expect(claims(again.access_token).iat).toBeGreaterThan(claims(a.access_token).iat)
    expect(ok(await tool(again.access_token, 'warren_list_facts'), 'facts').total).toBe(0)
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(401) // the old one stays dead
  })

  it("keeps the person's data, and a message with more in it goes to the model", async () => {
    ok(await tool(a.access_token, 'warren_log_movements', log(cafe)), 'log')
    await whatsapp(app, WA_A, 'desconectar')
    expect(await live(WA_A)).toHaveLength(1)
    await whatsapp(app, WA_A, 'desconectar y borrame todo')
    expect(app.model.n).toBe(1)
  })

  it('an open question is answered first: "desconectar" then goes to the model', async () => {
    // A sign-in question is open.
    const { code } = await openSignIn(browser(app.base), app.base, pkce().challenge)
    await whatsapp(app, WA_A, `vincular ${code}`)
    await whatsapp(app, WA_A, 'desconectar')
    expect(app.model.n).toBe(1)
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
  })
})

// ---- Racing channels, on a real Postgres

describe.skipIf(!realPostgres)(
  'real Postgres: an MCP correct racing a WhatsApp correct of the same movement',
  () => {
    it('exactly one wins, the other is refused, over several rounds', async () => {
      app.close()
      let target = 0
      await boot(fakeModel(() => [correct(target, { amount: '3800' })]))
      for (let round = 0; round < 8; round++) {
        const made = ok(
          await tool(
            a.access_token,
            'warren_log_movements',
            log({ ...cafe, amount: String(1000 + round) }),
          ),
          'log',
        )
        target = made.movements[0]?.id as number
        const before = await sql`SELECT count(*)::int AS n FROM movement`
        const [mcp, whatsappReply] = await Promise.all([
          tool(a.access_token, 'warren_correct_movement', {
            id: target,
            changes: { amount: '4200' },
          }),
          whatsapp(app, WA_A, `corregí el ${round}`, { allowFailed: true }),
        ])
        const mcpWon = !mcp.isError
        const waWon = (whatsappReply[0] ?? '').startsWith('✓ Corregido')
        expect(
          Number(mcpWon) + Number(waWon),
          `round ${round}: ${JSON.stringify([mcp, whatsappReply])}`,
        ).toBe(1)
        if (!mcpWon) expect(refusal(mcp)).toContain('already corrected or deleted')
        // WhatsApp loses either at the commit ("ya fue corregido o borrado"), or earlier: the movement it was shown was
        // replaced before its model read the list, so the id it sends is no longer one it was shown (the message fails).
        if (!waWon) expect(whatsappReply[0]).toMatch(/ya fue corregido o borrado|No pude procesar/)
        // One new row; the old one is replaced once.
        const after = await sql`SELECT count(*)::int AS n FROM movement`
        expect(Number(after[0]?.n) - Number(before[0]?.n)).toBe(1)
        expect(
          await sql`SELECT 1 FROM movement WHERE superseded_by IS NOT NULL AND id = ${target}`,
        ).toHaveLength(1)
      }
    })

    it('an MCP undo racing a WhatsApp "deshacer": the batch is undone once', async () => {
      app.close()
      await boot()
      const made = ok(await tool(a.access_token, 'warren_log_movements', log(cafe)), 'log')
      const [mcp, wa] = await Promise.all([
        tool(a.access_token, 'warren_undo_last', {}),
        whatsapp(app, WA_A, 'deshacer'),
      ])
      const mcpWon = !mcp.isError
      const waWon = (wa[0] ?? '').startsWith('↩︎ Deshice')
      expect(Number(mcpWon) + Number(waWon)).toBe(1)
      expect(await live(WA_A)).toHaveLength(0)
      expect(await sql`SELECT 1 FROM inbound_message WHERE undoes = ${made.batch}`).toHaveLength(1)
    })
  },
)
