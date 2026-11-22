import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type App, type Connected, claims, mint, WA_A, WA_B, withClaude } from './auth-test-kit'
import { decodeCursor, encodeCursor } from './mcp/tools'
import * as kit from './mcp-test-kit'
import { accountOf, type Json, ok, type Row, refusal, seed } from './mcp-test-kit'
import { sql, useDatabase } from './test-harness'

/**
 * Slice 5.2 end to end: a real token minted through the real sign-in flow (a fake claude.ai, WhatsApp, consent, PKCE) is
 * the bearer of JSON-RPC calls over HTTP to `/mcp`: the door, the three read tools, and two people who never see each other.
 * On PGlite; with PG_TEST_URL set, on a real Postgres in its own schema.
 */
useDatabase({ max: 12 })

/** 2026-11-18 12:30 in Argentina: "today" for every tool. */
const NOW = new Date('2026-11-18T15:30:00.000Z')
const WA_C = '5491100000003'

// ---- Data

/** A has 40 live movements: 30 of October, 9 of November (ARS, out) and one income in USD; B has its own. */
const A_ROWS: Row[] = [
  ...Array.from(
    { length: 30 },
    (_, i): Row => ({
      on: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`,
      amount: String(1000 + i * 10),
      description: i % 2 === 0 ? 'café' : 'súper',
      category: i % 2 === 0 ? 'restaurantes' : 'supermercado',
      payment: i % 3 === 0 ? 'crédito visa' : 'efectivo',
      at: `${String(8 + (i % 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    }),
  ),
  ...Array.from(
    { length: 9 },
    (_, i): Row => ({
      on: `2026-11-${String(1 + i).padStart(2, '0')}`,
      amount: String(2000 + i * 5),
      description: 'nafta',
      category: 'combustible',
      payment: 'efectivo',
    }),
  ),
  {
    on: '2026-10-15',
    amount: '20',
    currency: 'USD',
    direction: 'in',
    description: 'regalo',
    category: 'otros',
  },
  { on: '2026-10-20', amount: '999999', description: 'borrado', state: 'deleted' },
  { on: '2026-10-21', amount: '888888', description: 'viejo', state: 'replaced' },
]
const A_FACTS = [
  { kind: 'alias', key: 'la visa', value: 'Galicia' },
  { kind: 'category', key: 'cafe', value: 'restaurantes' },
  { kind: 'note', key: 'cobro', value: 'el 5' },
]
const B_ROWS: Row[] = Array.from(
  { length: 8 },
  (_, i): Row => ({
    on: `2026-10-${String(2 + i).padStart(2, '0')}`,
    amount: String(7000 + i),
    description: 'DE-B café',
    category: 'restaurantes',
    payment: 'DE-B visa',
  }),
)
const B_FACTS = [{ kind: 'note', key: 'solo de b', value: 'DE-B secreto' }]

/** Everything A's live rows say, worked out here in cents and not by the code under test. */
const cents = (a: string) => {
  const [w = '0', f = ''] = a.split('.')
  return BigInt(w) * 100n + BigInt(f.padEnd(2, '0'))
}
const octoberOut = A_ROWS.filter(
  (r) =>
    r.on.startsWith('2026-10') &&
    !r.state &&
    (r.direction ?? 'out') === 'out' &&
    (r.currency ?? 'ARS') === 'ARS',
)
const sum = (rows: Row[]) => rows.reduce((t, r) => t + cents(r.amount), 0n)
const asAmount = (c: bigint) =>
  c % 100n === 0n ? `${c / 100n}` : `${c / 100n}.${String(c % 100n).padStart(2, '0')}`
const LIVE_A = A_ROWS.filter((r) => !r.state)

let app: App
const rpc = (
  bearer: string | null,
  method: string,
  params: unknown = {},
  extra: Record<string, string> = {},
) => kit.rpc(app, bearer, method, params, extra)
const call = (bearer: string, name: string, args: Record<string, unknown> = {}) =>
  kit.call(app, bearer, name, args)
let a: Connected
let b: Connected
const forge = (over: Parameters<typeof kit.forge>[2] = {}) => kit.forge(app, a.userId, over)
/** The allow-list, one array shared by WhatsApp and the door: a test may take someone off it. */
let allowed: string[]

beforeEach(async () => {
  allowed = [WA_A, WA_B, WA_C]
  ;({ app } = await withClaude({ allowed, now: () => NOW }))
  a = await mint(app, WA_A)
  b = await mint(app, WA_B)
  await seed(WA_A, A_ROWS, A_FACTS)
  await seed(WA_B, B_ROWS, B_FACTS)
})
afterEach(() => app.close())

// ---- The door

describe('the door', () => {
  it('a real token passes; a forged one signed with the same key and the same claims passes too (so the variants below test one thing each)', async () => {
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
    expect(claims(a.access_token).sub).toBe(a.userId)
    expect((await rpc(await forge(), 'tools/list')).status).toBe(200)
  })

  it('no token: 401 with the RFC 9728 challenge naming the metadata and the scopes', async () => {
    const r = await rpc(null, 'tools/list')
    expect(r.status).toBe(401)
    const challenge = r.headers.get('www-authenticate') ?? ''
    expect(challenge).toContain(
      `resource_metadata="${app.base}/.well-known/oauth-protected-resource/mcp"`,
    )
    expect(challenge).toContain('scope="ledger:read')
    expect(JSON.stringify(r.body)).not.toContain('Bearer')
  })

  const refused: [string, () => Promise<string>][] = [
    [
      'an audience that is not the MCP URL',
      () => forge({ claims: { aud: 'https://evil.example/mcp' } }),
    ],
    ['no audience', () => forge({ dropClaims: ['aud'] })],
    [
      'a token type that is not at+jwt (a session or ID token)',
      () => forge({ header: { typ: 'JWT' } }),
    ],
    ['no token type', () => forge({ header: { typ: undefined } })],
    ['no azp', () => forge({ dropClaims: ['azp'] })],
    ['another issuer', () => forge({ claims: { iss: 'https://evil.example' } })],
    ['an expired token', () => forge({ claims: { iat: 1_000, exp: 1_900 } })],
    ['a subject that is no user', () => forge({ sub: '00000000-0000-4000-8000-000000000000' })],
    ['a subject that is not a uuid', () => forge({ sub: "x'; drop table account; --" })],
    ['no subject', () => forge({ dropClaims: ['sub'] })],
    ['a bad signature', async () => `${(await forge()).slice(0, -6)}AAAAAA`],
    [
      'an unsigned token',
      async () =>
        `${Buffer.from('{"alg":"none"}').toString('base64url')}.${(await forge()).split('.')[1]}.`,
    ],
    ['garbage', async () => 'not-a-token'],
  ]
  it.each(refused)('401 with the challenge for %s', async (_name, make) => {
    const r = await rpc(await make(), 'tools/list')
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=')
    // Always the same answer: a token teaches nothing about which check it failed.
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: expect.any(String) },
      id: null,
    })
  })

  it('the session JWT of the person is not an access token', async () => {
    const session = await (app.auth as NonNullable<typeof app.auth>).api.getToken({
      headers: new Headers({ cookie: [...a.b.jar].map(([k, v]) => `${k}=${v}`).join('; ') }),
    })
    expect(session.token.split('.')).toHaveLength(3)
    expect((await rpc(session.token, 'tools/list')).status).toBe(401)
  })

  it("the door only authenticates: scope is each tool's, answered 403 insufficient_scope with the challenge naming the scope", async () => {
    const writeOnly = await forge({ claims: { scope: 'ledger:write' } })
    // Discovery needs no scope.
    expect((await rpc(writeOnly, 'tools/list')).status).toBe(200)
    for (const name of ['warren_find_movements', 'warren_summarize', 'warren_list_facts']) {
      const r = await rpc(writeOnly, 'tools/call', { name, arguments: {} })
      expect(r.status, name).toBe(403)
      const challenge = r.headers.get('www-authenticate') ?? ''
      expect(challenge, name).toContain('error="insufficient_scope"')
      expect(challenge, name).toContain('scope="ledger:read"')
      expect(r.body).toMatchObject({ error: 'insufficient_scope' })
    }
    // Read alone is enough for the read tools.
    const readOnly = await forge({ claims: { scope: 'ledger:read' } })
    expect(ok(await call(readOnly, 'warren_list_facts'), 'facts').total).toBe(A_FACTS.length)
  })

  it('an account whose WhatsApp id is no longer allowed is refused, the others are not', async () => {
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
    allowed.splice(0, allowed.length, WA_B) // A was taken off the list
    const r = await rpc(a.access_token, 'tools/list')
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=')
    expect((await rpc(b.access_token, 'tools/list')).status).toBe(200)
    allowed.splice(0, allowed.length, '*')
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
  })

  it('a user whose account mapping is gone is refused', async () => {
    await sql`UPDATE auth_user SET warren_account_id = NULL WHERE id = ${a.userId}`
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(401)
  })

  it('a token of one person is never the other: the account comes from the token alone', async () => {
    const tokenOfB = await forge({ sub: b.userId })
    const mine = await call(a.access_token, 'warren_find_movements', { text: 'DE-B' })
    expect(ok(mine, 'find').movements).toHaveLength(0)
    const theirs = await call(tokenOfB, 'warren_find_movements', { text: 'DE-B' })
    expect(ok(theirs, 'find').movements).toHaveLength(B_ROWS.length)
  })

  it('a database that cannot answer is a 503, not a reason to sign in again', async () => {
    await sql`ALTER TABLE auth_user RENAME TO auth_user_away`
    try {
      const r = await rpc(a.access_token, 'tools/list')
      expect(r.status).toBe(503)
      expect(r.headers.get('www-authenticate')).toBeNull()
    } finally {
      await sql`ALTER TABLE auth_user_away RENAME TO auth_user`
    }
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
  })

  it('the signing keys unreadable (auth_jwks) is a 503 too, not a 500 and not a 401', async () => {
    await sql`ALTER TABLE auth_jwks RENAME TO auth_jwks_away`
    try {
      const r = await rpc(a.access_token, 'tools/list')
      expect(r.status).toBe(503)
      expect(r.headers.get('retry-after')).toBe('5')
      expect(r.headers.get('www-authenticate')).toBeNull()
    } finally {
      await sql`ALTER TABLE auth_jwks_away RENAME TO auth_jwks`
    }
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
  })

  it('a browser page of another site cannot call it, even with a token; ours and claude.ai/claude.com can', async () => {
    const withOrigin = (origin: string) => rpc(a.access_token, 'tools/list', {}, { origin })
    expect((await withOrigin('https://evil.example')).status).toBe(403)
    expect((await withOrigin('null')).status).toBe(403)
    expect((await withOrigin('http://localhost:3000')).status).toBe(403)
    for (const ok of [app.base, 'https://claude.ai', 'https://claude.com']) {
      expect((await withOrigin(ok)).status, ok).toBe(200)
    }
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200) // no Origin: not a browser
  })

  it('a malformed body is an answer, not a crash', async () => {
    const res = await fetch(`${app.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${a.access_token}`,
      },
      body: '{"jsonrpc":"2.0","id":1,"method":',
    })
    expect(res.status).toBeLessThan(500)
    expect((await rpc(a.access_token, 'tools/list')).status).toBe(200)
  })
})

// ---- The protocol

describe('the protocol', () => {
  it('initialize: Warren, its tools, how to use them', async () => {
    const r = await rpc(a.access_token, 'initialize', {
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

  const READS = ['warren_find_movements', 'warren_list_facts', 'warren_summarize']
  // destructive: true for what takes something out of the live record, false for what only adds.
  const WRITES: Record<string, boolean> = {
    warren_log_movements: false,
    warren_correct_movement: true,
    warren_delete_movement: true,
    warren_undo_last: true,
    warren_remember_fact: false,
    warren_forget_fact: true,
  }

  it('tools/list: three read tools and six write tools, annotated, closed to the world, each with an output schema and words a client reads', async () => {
    const r = await rpc(a.access_token, 'tools/list')
    const tools = r.body?.result.tools as Json[]
    expect(tools.map((t) => t.name).sort()).toEqual([...READS, ...Object.keys(WRITES)].sort())
    // Not offered: forgetting everything (the person's own "sí" on WhatsApp), and anything else of the agent's.
    expect(tools.some((t) => /forget_all|reply|help|ask/.test(t.name))).toBe(false)
    for (const t of tools) {
      const write = t.name in WRITES
      expect(t.annotations, t.name).toMatchObject(
        write
          ? {
              readOnlyHint: false,
              destructiveHint: WRITES[t.name],
              idempotentHint: false,
              openWorldHint: false,
            }
          : { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      )
      expect(t.outputSchema, t.name).toBeTruthy()
      expect(t.outputSchema.additionalProperties, t.name).not.toBe(false) // open, for a field added later
      expect(t.description.length, t.name).toBeGreaterThan(80)
      if (write) expect(Object.keys(t.inputSchema.properties), t.name).toContain('request_id')
    }
    const find = tools.find((t) => t.name === 'warren_find_movements')
    expect(find.description).toContain('quote the amounts')
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
    // The agent's own input schemas, without what is WhatsApp's: no `text` for the model's own words, no account.
    const summarize = tools.find((t) => t.name === 'warren_summarize')
    expect(Object.keys(summarize.inputSchema.properties).sort()).toEqual([
      'category',
      'compare_to',
      'description',
      'direction',
      'group_by',
      'other',
      'payment',
      'range',
    ])
    for (const t of tools) expect(JSON.stringify(t.inputSchema)).not.toMatch(/account|user_id/i)
  })

  it('a tool that does not exist is a protocol error', async () => {
    const r = await rpc(a.access_token, 'tools/call', {
      name: 'warren_forget_everything',
      arguments: {},
    })
    expect(r.body?.error ?? r.body?.result?.isError).toBeTruthy()
  })
})

// ---- warren_find_movements

describe('warren_find_movements', () => {
  it('pages through everything the person has, newest first, by cursor, each row once', async () => {
    const seen: number[] = []
    let cursor: string | null | undefined
    let pages = 0
    do {
      const out = ok(
        await call(a.access_token, 'warren_find_movements', {
          limit: 17,
          ...(cursor ? { cursor } : {}),
        }),
        'find',
      )
      pages++
      expect(out.movements.length).toBeLessThanOrEqual(17)
      seen.push(...out.movements.map((m) => m.id))
      cursor = out.next_cursor
    } while (cursor)
    expect(pages).toBe(Math.ceil(LIVE_A.length / 17))
    expect(seen).toHaveLength(LIVE_A.length) // the deleted and the replaced are not there
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort((x, y) => y - x)).toEqual(seen)
    const liveIds =
      await sql`SELECT id::int AS id FROM movement WHERE account_id = ${await accountOf(WA_A)} AND superseded_by IS NULL AND deleted_at IS NULL`
    expect(new Set(liveIds.map((r) => r.id))).toEqual(new Set(seen))
  })

  it('shows each movement with its exact amount and the amount as Warren writes it', async () => {
    const out = ok(await call(a.access_token, 'warren_find_movements', { text: 'regalo' }), 'find')
    expect(out.movements).toEqual([
      {
        id: expect.any(Number),
        date: '2026-10-15',
        time: '10:00',
        direction: 'in',
        amount: '20',
        display: 'US$ 20',
        currency: 'USD',
        description: 'regalo',
        category: 'otros',
        payment: null,
      },
    ])
    const cafe = ok(
      await call(a.access_token, 'warren_find_movements', { text: 'café', amount: '1000' }),
      'find',
    )
    expect(cafe.movements.map((m) => [m.amount, m.display])).toEqual([['1000', '$1.000']])
  })

  it('filters by words, dates, category, payment and amount, as the agent does', async () => {
    const find = async (args: Record<string, unknown>) =>
      ok(await call(a.access_token, 'warren_find_movements', { limit: 50, ...args }), 'find')
        .movements
    expect((await find({ text: 'nafta' })).length).toBe(9)
    expect((await find({ category: 'combustible' })).length).toBe(9)
    expect(
      (await find({ from: '2026-11-03', to: '2026-11-05' })).map((m) => m.date).sort(),
    ).toEqual(['2026-11-03', '2026-11-04', '2026-11-05'])
    expect((await find({ payment: 'VISA' })).every((m) => m.payment === 'crédito visa')).toBe(true)
    expect(
      (await find({ text: 'cafe', payment: 'visa' })).every((m) => m.description === 'café'),
    ).toBe(true)
    expect(await find({ text: 'nada de esto' })).toEqual([])
  })

  it('refuses with the reason the agent is given, as an error result and not a protocol error', async () => {
    const bad = async (args: Record<string, unknown>) =>
      refusal(await call(a.access_token, 'warren_find_movements', args))
    expect(await bad({ from: '2026-13-01' })).toContain('date does not exist')
    expect(await bad({ to: '2026-02-30' })).toContain('to "2026-02-30": date does not exist')
    expect(await bad({ from: 'ayer' })).toContain('date is not yyyy-mm-dd')
    expect(await bad({ amount: 'mucho' })).toContain('amount is not a decimal string')
    expect(await bad({ cursor: 'AAAA' })).toContain('Invalid cursor')
    for (const arguments_ of [
      { limit: 500 },
      { text: 'x'.repeat(201) },
      { payment: 'x'.repeat(201) },
    ]) {
      const r = await rpc(a.access_token, 'tools/call', {
        name: 'warren_find_movements',
        arguments: arguments_,
      })
      expect(
        r.body?.error ?? r.body?.result?.isError,
        JSON.stringify(arguments_).slice(0, 40),
      ).toBeTruthy() // over a cap: refused by the schema
    }
  })

  it('a page of 50 is far under what a client takes', async () => {
    const out = await call(a.access_token, 'warren_find_movements', { limit: 50 })
    // The result carries the data twice (structuredContent and its text), and `out` is both: about 16k characters, 4 to 5k
    // tokens against Claude Code's 25k, so a page of 50 never needs trimming.
    expect(JSON.stringify(out).length).toBeLessThan(25_000)
  })

  it('cursors are ours alone', () => {
    expect(decodeCursor(encodeCursor(123))).toBe(123)
    for (const c of [
      '',
      'AAAA',
      'bTEyMw==',
      Buffer.from('m0').toString('base64url'),
      Buffer.from('m1;drop').toString('base64url'),
      'x'.repeat(40),
    ]) {
      expect(decodeCursor(c), c).toBeNull()
    }
  })
})

// ---- warren_summarize

describe('warren_summarize', () => {
  const summarize = (args: Record<string, unknown>) =>
    call(a.access_token, 'warren_summarize', args)
  const period = (p: string, extra: Record<string, unknown> = {}) => ({
    range: { period: p, month: 0, year: 0, from: '', to: '' },
    group_by: 'none',
    compare_to: 'none',
    other: '',
    direction: null,
    category: null,
    payment: null,
    description: null,
    ...extra,
  })

  it('totals a month in code: the exact sum, its display, the count and the text Warren writes', async () => {
    const out = ok(await summarize(period('last_month', { direction: 'out' })), 'summarize')
    expect(out.from).toBe('2026-10-01')
    expect(out.to).toBe('2026-10-31')
    expect(out.totals).toEqual([
      {
        direction: 'out',
        currency: 'ARS',
        count: octoberOut.length,
        amount: asAmount(sum(octoberOut)),
        display: expect.stringMatching(/^\$[\d.]+(,\d\d)?$/),
      },
    ])
    expect(out.summary).toContain('Octubre')
    expect(out.summary).toContain(out.totals[0]?.display)
    expect(out.compared_with).toBeNull()
    expect(out.changes).toEqual([])
  })

  it('keeps directions and currencies apart', async () => {
    const out = ok(await summarize(period('last_month')), 'summarize')
    expect(out.totals.map((t) => `${t.direction} ${t.currency} ${t.count}`).sort()).toEqual([
      `in USD 1`,
      `out ARS ${octoberOut.length}`,
    ])
    expect(out.totals.find((t) => t.currency === 'USD')?.display).toBe('US$ 20')
  })

  it('groups, and compares with the range before: exact differences and percentages from summary.ts', async () => {
    const out = ok(
      await summarize(
        period('last_month', {
          direction: 'out',
          group_by: 'category',
          compare_to: 'range',
          other: 'this_month',
        }),
      ),
      'summarize',
    )
    expect(out.groups.map((g) => g.label).sort()).toEqual(['Restaurantes', 'Súper'].sort())
    expect(out.groups.reduce((t, g) => t + cents(g.amount), 0n)).toBe(sum(octoberOut))
    const november = A_ROWS.filter((r) => r.on.startsWith('2026-11'))
    expect(out.compared_with?.totals[0]?.amount).toBe(asAmount(sum(november)))
    // October (asked) against November (compared): 16.170 more, 88,9% of November's.
    const delta = sum(octoberOut) - sum(november)
    expect(out.changes).toEqual([
      {
        direction: 'out',
        currency: 'ARS',
        way: 'more',
        amount: asAmount(delta),
        display: '$16.170',
        percent: '+88,9%',
      },
    ])
    expect(out.summary).toContain('Octubre')
  })

  it('compare_to previous, grouped by payment', async () => {
    const out = ok(
      await summarize(
        period('this_month', { direction: 'out', group_by: 'payment', compare_to: 'previous' }),
      ),
      'summarize',
    )
    expect(out.compared_with?.from).toBe('2026-10-01') // the same stretch of the month before
    expect(out.groups.length).toBeGreaterThan(0)
  })

  it('refuses with the reason the agent is given', async () => {
    const bad = async (args: Record<string, unknown>) => refusal(await summarize(args))
    expect(
      await bad(
        period('month', { range: { period: 'month', month: 13, year: 0, from: '', to: '' } }),
      ),
    ).toMatch(/range/)
    expect(await bad(period('last_month', { compare_to: 'none', other: 'this_month' }))).toContain(
      'other is only for compare_to',
    )
    expect(await bad(period('this_month', { group_by: 'day', compare_to: 'previous' }))).toContain(
      'cannot be grouped by',
    )
    expect(await bad(period('last_month', { description: 'cuenta 123456' }))).toContain(
      '4 or more digits',
    )
    expect(
      await bad(
        period('dates', {
          range: { period: 'dates', month: 0, year: 0, from: '2026-12-25', to: '2026-12-30' },
        }),
      ),
    ).toMatch(/range/)
  })

  it('keeps the latest buckets of each direction and currency, as the text does: a year by day', async () => {
    // Every day of the year so far: spending (ARS) and, on five of them, income (ARS), and one in dollars.
    const days: string[] = []
    for (
      let d = new Date('2026-01-01T00:00:00Z');
      d <= new Date('2026-11-18T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      days.push(d.toISOString().slice(0, 10))
    }
    expect(days).toHaveLength(322)
    const incomeDays = [0, 40, 80, 120, 160].map((i) => days[i] ?? '')
    await seed(WA_A, [
      ...days.map((on): Row => ({ on, amount: '100', description: 'diario', category: 'otros' })),
      ...incomeDays.map(
        (on): Row => ({ on, amount: '5000', direction: 'in', description: 'ingreso' }),
      ),
      { on: '2026-03-03', amount: '50', currency: 'USD', description: 'dolares' },
    ])
    const out = ok(await summarize(period('this_year', { group_by: 'day' })), 'summarize')
    const groups = (direction: string, currency: string) =>
      out.groups.filter((g) => g.direction === direction && g.currency === currency)
    // Spending in pesos is on 322 days: the latest 31 are kept, oldest first, and the rest are counted.
    const spent = groups('out', 'ARS')
    expect(spent.map((g) => g.key)).toEqual(days.slice(-31))
    expect(out.groups_omitted).toBe(days.length - 31)
    // Income and dollars are not crowded out by them.
    expect(groups('in', 'ARS').map((g) => g.key)).toEqual(incomeDays)
    expect(groups('out', 'USD').map((g) => g.key)).toEqual(['2026-03-03'])
    expect(groups('in', 'USD').map((g) => g.key)).toEqual(['2026-10-15'])
    // The two halves agree: every bucket listed is in the text, and the first day of the year is in neither.
    for (const g of spent) expect(out.summary, g.label).toContain(g.label)
    expect(out.summary).toContain('… y 291 anteriores')
    expect(out.groups.some((g) => g.key === '2026-01-01' && g.direction === 'out')).toBe(false)
    // The totals are over everything, whatever is listed.
    expect(
      out.totals.find((t) => t.direction === 'out' && t.currency === 'ARS')?.count,
    ).toBeGreaterThan(322)
  })

  it('a grouping that is not by time keeps the biggest, per direction and currency', async () => {
    const payments = Array.from(
      { length: 130 },
      (_, i): Row => ({
        on: '2026-11-10',
        amount: String(1000 + i),
        description: 'pago',
        payment: `medio ${String(i).padStart(3, '0')}`,
      }),
    )
    await seed(WA_A, [
      ...payments,
      { on: '2026-11-11', amount: '10', direction: 'in', description: 'ingreso', payment: 'banco' },
    ])
    const out = ok(await summarize(period('this_month', { group_by: 'payment' })), 'summarize')
    const spent = out.groups.filter((g) => g.direction === 'out')
    expect(spent).toHaveLength(100)
    expect(out.groups.filter((g) => g.direction === 'in')).toHaveLength(1)
    expect(out.groups_omitted).toBeGreaterThan(29)
    // Biggest first: the first group is the dearest payment.
    expect(cents(spent[0]?.amount ?? '0') >= cents(spent[99]?.amount ?? '0')).toBe(true)
    // (November's cash spending is the dearest: 18180.)
    expect(spent[0]?.amount).toBe('18180')
    expect(spent[1]?.amount).toBe('1129')
  })

  it("reads today as the Argentine day, not the server's", async () => {
    const out = ok(await summarize(period('today')), 'summarize')
    expect(out.from).toBe('2026-11-18')
    expect(out.to).toBe('2026-11-18')
    expect(out.totals).toEqual([])
  })
})

// ---- warren_list_facts

describe('warren_list_facts', () => {
  it("lists the person's own facts and nobody else's", async () => {
    const mine = ok(await call(a.access_token, 'warren_list_facts'), 'facts')
    expect(mine.total).toBe(A_FACTS.length)
    expect(mine.facts.map((f) => `${f.kind}:${f.key}=${f.value}`).sort()).toEqual(
      A_FACTS.map((f) => `${f.kind}:${f.key}=${f.value}`).sort(),
    )
    const theirs = ok(await call(b.access_token, 'warren_list_facts'), 'facts')
    expect(theirs.facts.map((f) => f.key)).toEqual(['solo de b'])
    expect(JSON.stringify(mine)).not.toContain('DE-B')
  })

  it('does not list what was forgotten or replaced', async () => {
    const account = await accountOf(WA_A)
    const [m] = await sql`SELECT id FROM inbound_message WHERE wa_id = ${WA_A} LIMIT 1`
    await sql`UPDATE fact SET forgotten_at = now(), forgotten_by = ${m?.id} WHERE account_id = ${account} AND key = 'cobro'`
    expect(ok(await call(a.access_token, 'warren_list_facts'), 'facts').total).toBe(
      A_FACTS.length - 1,
    )
  })
})

describe('two people who share a server', () => {
  it("B sees only B's movements, summaries and facts; A only A's", async () => {
    const mineB = ok(await call(b.access_token, 'warren_find_movements', { limit: 50 }), 'find')
    expect(mineB.movements).toHaveLength(B_ROWS.length)
    expect(mineB.movements.every((m) => m.description === 'DE-B café')).toBe(true)
    const mineA = ok(await call(a.access_token, 'warren_find_movements', { limit: 50 }), 'find')
    expect(JSON.stringify(mineA)).not.toContain('DE-B')
    const sb = ok(
      await call(b.access_token, 'warren_summarize', {
        range: { period: 'last_month', month: 0, year: 0, from: '', to: '' },
        group_by: 'payment',
        compare_to: 'none',
        other: '',
        direction: 'out',
        category: null,
        payment: null,
        description: null,
      }),
      'summarize',
    )
    expect(sb.totals[0]?.amount).toBe(asAmount(sum(B_ROWS)))
    expect(sb.totals[0]?.count).toBe(B_ROWS.length)
    expect(sb.groups.map((g) => g.label)).toEqual(['DE-B visa'])
    // A cursor of A's cannot be turned into a way to B's rows: the filter by account is in every query.
    const page = ok(await call(a.access_token, 'warren_find_movements', { limit: 3 }), 'find')
    const next = ok(
      await call(b.access_token, 'warren_find_movements', { limit: 50, cursor: page.next_cursor }),
      'find',
    )
    expect(next.movements.every((m) => m.description === 'DE-B café')).toBe(true)
  })

  it('a tool that cannot read says so without detail, and the next call works', async () => {
    await sql`ALTER TABLE fact RENAME TO fact_away`
    try {
      const text = refusal(await call(a.access_token, 'warren_list_facts'))
      expect(text).toContain('could not read your data')
      expect(text).not.toMatch(/fact_away|relation|SELECT/i)
    } finally {
      await sql`ALTER TABLE fact_away RENAME TO fact`
    }
    expect(ok(await call(a.access_token, 'warren_list_facts'), 'facts').total).toBe(A_FACTS.length)
  })
})
