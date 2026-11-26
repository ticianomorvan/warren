import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { cafe as cafeMovement, turn as coreTurn, log } from '../../test/core'
import { type App, type Connected, mint, WA_A, WA_B, withClaude } from '../auth-test-kit'
import { COMMANDS, type OUTPUTS, type Tool } from '../core/commands'
import { call, forge, type Json, ok, refused, rpc } from '../mcp-test-kit'
import { sql, TODAY, useDatabase } from '../test-harness'
import { addDays } from '../time'
import { decodeCursor, encodeCursor, listGroups, MAX_GROUPS_LISTED } from './tools'

/**
 * The tools of `/mcp` over real HTTP with real tokens (the sign-in flow mints them): what `tools/list` says, and the read tools. Ported
 * from v1's `mcp.test.ts`; the registry now derives the tools, and an output is held to the registry's own output schema.
 */
useDatabase({ max: 12 })

let app: App
let a: Connected
let b: Connected
let accountA: number
let accountB: number

/** The tests' clock (the harness's, which the MCP server shares): the core kit's own clock is another day. */
const AT = new Date(1760000000 * 1000)
const turn = (account: number, calls: Parameters<typeof coreTurn>[2]) =>
  coreTurn(sql, account, calls, { at: AT })

const accountOf = async (wa: string) =>
  Number((await sql`SELECT account_id FROM account_address WHERE address = ${wa}`)[0]?.account_id)

/** Seeds movements through the core's own commit (the same path every channel writes by), dated `n` days before the fixed test day. */
const seed = (
  account: number,
  rows: {
    d: string
    a: string
    n?: number
    cat?: 'supermercado' | 'restaurantes' | 'transporte'
    pay?: string
    dir?: 'in' | 'out'
    cur?: 'ARS' | 'USD'
  }[],
) =>
  turn(account, [
    log(
      ...rows.map((r) =>
        cafeMovement({
          description: r.d,
          amount: r.a,
          date: addDays(TODAY, -(r.n ?? 0)),
          category: r.cat ?? 'restaurantes',
          ...(r.pay ? { payment: r.pay } : {}),
          direction: r.dir ?? 'out',
          currency: r.cur ?? 'ARS',
        }),
      ),
    ),
  ])

beforeEach(async () => {
  ;({ app } = await withClaude({ allowed: [WA_A, WA_B] }))
  a = await mint(app, WA_A)
  b = await mint(app, WA_B)
  accountA = await accountOf(WA_A)
  accountB = await accountOf(WA_B)
})
afterEach(() => app.close())

describe('the protocol', () => {
  it('initialize: Warren, its tools, how to use them', async () => {
    const r = await rpc(app, a.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(r.status).toBe(200)
    expect(r.body?.result).toMatchObject({
      serverInfo: { name: 'warren' },
      capabilities: { tools: {} },
    })
    expect(r.body?.result.instructions).toContain('never add, convert or round')
  })

  it('tools/list: one tool per registry entry with an mcp block, reminders included, annotated, each with an output schema', async () => {
    const r = await rpc(app, a.access_token, 'tools/list')
    const tools = r.body?.result.tools as Json[]
    const wanted = (Object.keys(COMMANDS) as Tool[]).filter((t) => 'mcp' in COMMANDS[t])
    expect(tools.map((t) => t.name).sort()).toEqual(wanted.map((t) => `warren_${t}`).sort())
    expect(wanted).toEqual(
      expect.arrayContaining(['set_reminder', 'cancel_reminder', 'list_reminders', 'undo_last']),
    )
    // Not offered: forgetting everything (the person's own "sí" on WhatsApp) and the conversation's tools.
    expect(tools.some((t) => /forget_all|reply|help|ask|skip/.test(t.name))).toBe(false)
    for (const t of tools) {
      const entry = COMMANDS[t.name.replace('warren_', '') as Tool]
      const write = entry.kind === 'write'
      expect(t.annotations, t.name).toMatchObject(
        write
          ? {
              readOnlyHint: false,
              destructiveHint: 'mcp' in entry && entry.mcp?.destructive === true,
              idempotentHint: false,
              openWorldHint: false,
            }
          : { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      )
      expect(t.outputSchema, t.name).toBeTruthy()
      expect(t.description.length, t.name).toBeGreaterThan(80)
      expect(t.description, t.name).toContain('quote the amounts')
      if (write) expect(Object.keys(t.inputSchema.properties), t.name).toContain('request_id')
      expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/account|user_id/i)
    }
    const find = tools.find((t) => t.name === 'warren_find_movements')
    expect(Object.keys(find.inputSchema.properties).sort()).toEqual([
      'amount',
      'category',
      'cursor',
      'from',
      'limit',
      'payment',
      'text',
      'to',
    ])
    expect(find.inputSchema.properties.limit.maximum).toBe(50)
    // The canonical schemas, not a second copy: a write's own fields, with the registry's `then`/`first` unions.
    const remind = tools.find((t) => t.name === 'warren_set_reminder')
    expect(Object.keys(remind.inputSchema.properties)).toEqual(
      expect.arrayContaining(['what', 'first', 'every', 'request_id']),
    )
  })

  it('a tool that does not exist is a protocol error', async () => {
    const r = await rpc(app, a.access_token, 'tools/call', {
      name: 'warren_forget_everything',
      arguments: {},
    })
    expect(r.body?.error ?? r.body?.result?.isError).toBeTruthy()
  })

  it("scope is each tool's: a write-only token cannot read, a read-only one cannot write, discovery needs none (403 insufficient_scope)", async () => {
    const writeOnly = await forge(app, a.userId, { claims: { scope: 'ledger:write' } })
    expect((await rpc(app, writeOnly, 'tools/list')).status).toBe(200)
    for (const name of [
      'warren_find_movements',
      'warren_summarize',
      'warren_list_facts',
      'warren_list_reminders',
    ]) {
      const r = await rpc(app, writeOnly, 'tools/call', { name, arguments: {} })
      expect(r.status, name).toBe(403)
      const challenge = r.headers.get('www-authenticate') ?? ''
      expect(challenge, name).toContain('error="insufficient_scope"')
      expect(challenge, name).toContain('scope="ledger:read"')
    }
    const readOnly = await forge(app, a.userId, { claims: { scope: 'ledger:read' } })
    expect(ok(await call(app, readOnly, 'warren_list_facts'), 'list_facts').total).toBe(0)
    const w = await rpc(app, readOnly, 'tools/call', {
      name: 'warren_log_movements',
      arguments: { movements: [cafeMovement({ date: TODAY })] },
    })
    expect(w.status).toBe(403)
    expect(w.headers.get('www-authenticate')).toContain('scope="ledger:write"')
    expect(await sql`SELECT 1 FROM movement`).toHaveLength(0)
    // Write alone is enough to write.
    const wrote = await call(app, writeOnly, 'warren_log_movements', {
      movements: [cafeMovement({ date: TODAY })],
    })
    ok(wrote, 'log_movements')
  })

  it('a token of one person is never the other: the account comes from the token alone', async () => {
    await seed(accountB, [{ d: 'DE-B', a: '1000' }])
    const tokenOfB = await forge(app, a.userId, { sub: b.userId })
    const mine = await call(app, a.access_token, 'warren_find_movements', { text: 'DE-B' })
    expect(ok(mine, 'find_movements').movements).toHaveLength(0)
    const theirs = await call(app, tokenOfB, 'warren_find_movements', { text: 'DE-B' })
    expect(ok(theirs, 'find_movements').movements).toHaveLength(1)
  })
})

describe('warren_find_movements', () => {
  it('pages through everything the person has, newest first, by cursor, each row once', async () => {
    await seed(
      accountA,
      Array.from({ length: 7 }, (_, i) => ({ d: `item${i}`, a: String(1000 + i) })),
    )
    const seen: number[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const result: z.infer<typeof OUTPUTS.find_movements> = ok(
        await call(app, a.access_token, 'warren_find_movements', {
          limit: 3,
          ...(cursor ? { cursor } : {}),
        }),
        'find_movements',
      )
      seen.push(...result.movements.map((m) => m.id))
      cursor = result.next_cursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect(seen).toEqual([...seen].sort((x, y) => y - x))
    expect(cursor).toBeNull()
  })

  it('shows each movement with its exact amount and the amount as Warren writes it', async () => {
    await seed(accountA, [
      { d: 'cine', a: '1500.50' },
      { d: 'netflix', a: '20', cur: 'USD' },
    ])
    const { movements } = ok(
      await call(app, a.access_token, 'warren_find_movements'),
      'find_movements',
    )
    expect(movements.find((m) => m.description === 'cine')).toMatchObject({
      amount: '1500.50',
      display: '$1.500,50',
      currency: 'ARS',
      date: TODAY,
    })
    expect(movements.find((m) => m.description === 'netflix')).toMatchObject({
      amount: '20',
      display: 'US$ 20',
    })
  })

  it('filters by words, dates, category, payment and amount, as the agent does', async () => {
    await seed(accountA, [
      { d: 'café', a: '3500', pay: 'efectivo' },
      { d: 'súper', a: '12000', cat: 'supermercado', pay: 'crédito visa', n: 3 },
      { d: 'taxi', a: '5400', cat: 'transporte', n: 10 },
    ])
    const find = async (args: Record<string, unknown>) =>
      ok(
        await call(app, a.access_token, 'warren_find_movements', args),
        'find_movements',
      ).movements.map((m) => m.description)
    expect(await find({ text: 'CAFE' })).toEqual(['café'])
    expect(await find({ category: 'supermercado' })).toEqual(['súper'])
    expect(await find({ payment: 'VISA' })).toEqual(['súper'])
    expect(await find({ amount: '5400' })).toEqual(['taxi'])
    expect(await find({ from: addDays(TODAY, -5), to: TODAY })).toEqual(['súper', 'café'])
  })

  it('refuses with the reason the agent is given, as an error result and not a protocol error', async () => {
    const bad = await call(app, a.access_token, 'warren_find_movements', { from: '2026-13-45' })
    expect(refused(bad, 'invalid')).toContain('from')
    const amount = await call(app, a.access_token, 'warren_find_movements', { amount: '3.500,00' })
    refused(amount, 'invalid')
    refused(
      await call(app, a.access_token, 'warren_find_movements', { cursor: 'not-ours' }),
      'invalid',
    )
  })

  it('a page is at most 50: more is the protocol refusing the input', async () => {
    const r = await rpc(app, a.access_token, 'tools/call', {
      name: 'warren_find_movements',
      arguments: { limit: 51 },
    })
    expect(r.body?.error ?? r.body?.result?.isError).toBeTruthy()
  })

  it('cursors are ours alone', () => {
    expect(decodeCursor(encodeCursor(77))).toBe(77)
    expect(decodeCursor('bm90LW91cnM')).toBeNull()
    expect(decodeCursor(Buffer.from('m0').toString('base64url'))).toBeNull()
    expect(decodeCursor('x'.repeat(40))).toBeNull()
  })
})

describe('warren_summarize', () => {
  const thisMonth = { period: 'this_month' }

  it('totals a month in code: the exact sum, its display, the count and the text Warren writes', async () => {
    await seed(accountA, [
      { d: 'café', a: '3500.25' },
      { d: 'café', a: '2500' },
      { d: 'sueldo', a: '800000', dir: 'in' },
      { d: 'netflix', a: '20', cur: 'USD' },
    ])
    const r = ok(
      await call(app, a.access_token, 'warren_summarize', { range: thisMonth }),
      'summarize',
    )
    const out = r.totals.find((t) => t.direction === 'out' && t.currency === 'ARS')
    expect(out).toMatchObject({ amount: '6000.25', display: '$6.000,25', count: 2 })
    expect(r.totals.find((t) => t.direction === 'in')).toMatchObject({ amount: '800000', count: 1 })
    expect(r.totals.find((t) => t.currency === 'USD')).toMatchObject({
      amount: '20',
      display: 'US$ 20',
    })
    expect(r.totals).toHaveLength(3) // directions and currencies apart, never added
    expect(r.summary).toContain('$6.000,25')
  })

  it('groups, and compares with the range before: exact differences and percentages', async () => {
    await seed(accountA, [
      { d: 'café', a: '3000', cat: 'restaurantes' },
      { d: 'súper', a: '9000', cat: 'supermercado' },
      { d: 'café', a: '2000', cat: 'restaurantes', n: 40 },
    ])
    const grouped = ok(
      await call(app, a.access_token, 'warren_summarize', {
        range: thisMonth,
        group_by: 'category',
      }),
      'summarize',
    )
    expect(grouped.groups.map((g) => [g.key, g.amount])).toEqual([
      ['supermercado', '9000'],
      ['restaurantes', '3000'],
    ])
    const compared = ok(
      await call(app, a.access_token, 'warren_summarize', {
        range: { period: 'last_month' },
        compare: 'previous',
      }),
      'summarize',
    )
    expect(compared.compared_with).not.toBeNull()
    expect(compared.changes[0]).toMatchObject({ direction: 'out', currency: 'ARS' })
  })

  it('refuses with the reason the agent is given', async () => {
    refused(
      await call(app, a.access_token, 'warren_summarize', {
        range: { period: 'dates', from: '2026-02-30' },
      }),
      'invalid',
    )
    refused(
      await call(app, a.access_token, 'warren_summarize', {
        range: thisMonth,
        description: 'tarjeta 4111111111111111',
      }),
      'invalid',
    )
  })

  it("reads today as the Argentine day, not the server's", async () => {
    await seed(accountA, [{ d: 'hoy', a: '100' }])
    const r = ok(
      await call(app, a.access_token, 'warren_summarize', { range: { period: 'today' } }),
      'summarize',
    )
    expect(r.from).toBe(TODAY)
    expect(r.totals[0]?.amount).toBe('100')
  })
})

describe('warren_list_facts and warren_list_reminders', () => {
  it("lists the person's own facts and nobody else's, not what was forgotten or replaced", async () => {
    const remember = (k: string, v: string) =>
      turn(accountA, [{ tool: 'remember_fact', input: { kind: 'alias', key: k, value: v } }])
    await remember('la visa', 'galicia')
    await remember('la visa', 'santander') // replaces
    await remember('gym', 'smartfit')
    await turn(accountA, [{ tool: 'forget_fact', input: { target: { key: 'gym' } } }])
    await turn(accountB, [
      { tool: 'remember_fact', input: { kind: 'note', key: 'de b', value: 'x' } },
    ])
    const r = ok(await call(app, a.access_token, 'warren_list_facts'), 'list_facts')
    expect(r.facts.map((f) => [f.key, f.value])).toEqual([['la visa', 'santander']])
    expect(r.total).toBe(1)
  })

  it('lists live reminders, the next first, and nobody else’s', async () => {
    await turn(accountA, [
      {
        tool: 'set_reminder',
        input: { what: 'pagar la Visa', first: { date: addDays(TODAY, 5) }, interval: 1 },
      },
      {
        tool: 'set_reminder',
        input: { what: 'llamar al médico', first: { date: addDays(TODAY, 2) }, interval: 1 },
      },
    ])
    await turn(accountB, [
      {
        tool: 'set_reminder',
        input: { what: 'de B', first: { date: addDays(TODAY, 1) }, interval: 1 },
      },
    ])
    const r = ok(await call(app, a.access_token, 'warren_list_reminders'), 'list_reminders')
    expect(r.reminders.map((x) => x.what)).toEqual(['llamar al médico', 'pagar la Visa'])
    expect(r.reminders[0]?.next_due_at).toMatch(/^\d{4}-\d\d-\d\dT/)
  })
})

describe('a tool that cannot read', () => {
  it('says so without detail, and the next call works', async () => {
    await sql`ALTER TABLE movement RENAME TO movement_away`
    try {
      const r = await call(app, a.access_token, 'warren_find_movements')
      expect(refused(r, 'unavailable')).not.toMatch(/movement|relation|sql/i)
    } finally {
      await sql`ALTER TABLE movement_away RENAME TO movement`
    }
    ok(await call(app, a.access_token, 'warren_find_movements'), 'find_movements')
  })
})

describe('listGroups', () => {
  const group = (key: string, direction: 'in' | 'out', currency: 'ARS' | 'USD') => ({
    key,
    label: null,
    direction,
    currency,
    count: 1,
    total: '1',
  })

  it('keeps the latest buckets of a grouping by time, and the biggest of any other, per direction and currency', () => {
    const days = Array.from({ length: 40 }, (_, i) => group(`d${i}`, 'out', 'ARS'))
    const byDay = listGroups(days, 'day')
    expect(byDay.listed).toHaveLength(31)
    expect(byDay.listed[0]?.key).toBe('d9') // the oldest nine are left out
    expect(byDay.omitted).toBe(9)
    // Another pair never crowds this one out.
    const mixed = [...days, group('in', 'in', 'USD')]
    expect(listGroups(mixed, 'day').listed.some((g) => g.key === 'in')).toBe(true)
    const cats = Array.from({ length: MAX_GROUPS_LISTED + 5 }, (_, i) =>
      group(`c${i}`, 'out', 'ARS'),
    )
    const byCategory = listGroups(cats, 'category')
    expect(byCategory.listed[0]?.key).toBe('c0') // the database's order: the biggest first
    expect(byCategory.omitted).toBe(5)
  })
})
