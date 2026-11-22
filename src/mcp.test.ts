import { createPrivateKey, sign } from 'node:crypto'
import { symmetricDecrypt } from 'better-auth/crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { mcpUrl } from './auth/config'
import {
  type App,
  CLIENT_ID,
  type Connected,
  claims,
  mint,
  WA_A,
  WA_B,
  withClaude,
} from './auth-test-kit'
import { decodeCursor, encodeCursor, outputSchemas, registerReadTools } from './mcp/tools'
import { sql, useDatabase } from './test-harness'

/**
 * Slice 5.2 end to end: a real token minted through the real sign-in flow (a fake claude.ai, WhatsApp, consent, PKCE) is
 * the bearer of JSON-RPC calls over HTTP to `/mcp`: the door, the three read tools, and two people who never see each other.
 * On PGlite; with PG_TEST_URL set, on a real Postgres in its own schema.
 */
const url = process.env.PG_TEST_URL
useDatabase(url ? { url, max: 12, schema: 'mcp_test' } : undefined)

/** 2026-11-18 12:30 in Argentina: "today" for every tool. */
const NOW = new Date('2026-11-18T15:30:00.000Z')
const WA_C = '5491100000003'

// ---- JSON-RPC over HTTP

// biome-ignore lint/suspicious/noExplicitAny: a test reads JSON-RPC answers loosely
type Json = any

type Rpc = { status: number; headers: Headers; body: Record<string, Json> | null }

/** The answer is JSON or, for a legacy client, one SSE `message` event: both read the same. */
async function readBody(res: Response): Promise<Record<string, Json> | null> {
  const text = await res.text()
  if (!text) return null
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .at(-1)
    return data ? JSON.parse(data) : null
  }
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

let app: App
let id = 0

async function rpc(
  bearer: string | null,
  method: string,
  params: unknown = {},
  extra: Record<string, string> = {},
) {
  const res = await fetch(`${app.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  return { status: res.status, headers: res.headers, body: await readBody(res) } satisfies Rpc
}

type ToolResult = {
  isError?: boolean
  structuredContent?: Json
  content: { type: string; text: string }[]
}
const call = async (
  bearer: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> => {
  const r = await rpc(bearer, 'tools/call', { name, arguments: args })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body?.error, JSON.stringify(r.body)).toBeUndefined()
  return r.body?.result as ToolResult
}

const closed = outputSchemas(true)
/** A good result: held to the closed copy of its schema, and its text is the same data as its structured content. */
function ok<K extends keyof typeof closed>(
  result: ToolResult,
  schema: K,
): z.infer<(typeof closed)[K]> {
  expect(result.isError, JSON.stringify(result)).toBeFalsy()
  const parsed = closed[schema].parse(result.structuredContent)
  expect(JSON.parse(result.content[0]?.text ?? 'null')).toEqual(parsed)
  return parsed as z.infer<(typeof closed)[K]>
}
const refusal = (result: ToolResult) => {
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toBeUndefined()
  return result.content[0]?.text ?? ''
}

// ---- Data

async function accountOf(wa: string): Promise<number> {
  const [row] = await sql`SELECT id::int AS id FROM account WHERE wa_id = ${wa}`
  return Number(row?.id)
}

interface Row {
  on: string
  amount: string
  currency?: 'ARS' | 'USD'
  direction?: 'in' | 'out'
  description: string
  category?: string
  payment?: string | null
  at?: string
  state?: 'live' | 'deleted' | 'replaced'
}

async function seed(
  wa: string,
  rows: Row[],
  facts: { kind: string; key: string; value: string }[] = [],
) {
  const account = await accountOf(wa)
  const [inbound] = await sql`
    INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status)
    VALUES (${`seed.${wa}`}, ${wa}, 'text', 'seed', '{}'::jsonb, 'done') RETURNING id`
  const ids: number[] = []
  for (const [position, r] of rows.entries()) {
    const [m] = await sql`
      INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency, occurred_on,
        description, category, payment, confidence, created_at, deleted_at, deleted_by)
      VALUES (${account}, ${inbound?.id}, ${position}, ${r.direction ?? 'out'}, ${r.amount}, ${r.currency ?? 'ARS'},
        ${r.on}, ${r.description}, ${r.category ?? 'otros'}, ${r.payment ?? null}, 'high',
        ${new Date(`${r.on}T${r.at ?? '10:00'}:00-03:00`)},
        ${r.state === 'deleted' ? new Date() : null}, ${r.state === 'deleted' ? inbound?.id : null})
      RETURNING id::int AS id`
    ids.push(Number(m?.id))
    if (r.state === 'replaced') {
      const [next] = await sql`
        INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency, occurred_on,
          description, category, payment, confidence)
        VALUES (${account}, ${inbound?.id}, ${rows.length + position}, 'out', '1', 'ARS', ${r.on}, 'corrected', 'otros', null, 'high')
        RETURNING id::int AS id`
      await sql`UPDATE movement SET superseded_by = ${next?.id} WHERE id = ${m?.id}`
      await sql`UPDATE movement SET deleted_at = now(), deleted_by = ${inbound?.id} WHERE id = ${next?.id}`
    }
  }
  if (facts.length > 0) {
    await sql`INSERT INTO fact ${sql(facts.map((f) => ({ ...f, account_id: account, inbound_message_id: inbound?.id })))}`
  }
  return ids
}

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

let a: Connected
let b: Connected
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

/** A token as better-auth signs it, with any claim or header changed: the real signing key, taken out of the table. */
async function forge(
  over: {
    claims?: Record<string, unknown>
    header?: Record<string, unknown>
    sub?: string
    dropClaims?: string[]
  } = {},
) {
  const [key] =
    await sql`SELECT id, "privateKey" AS private FROM auth_jwks ORDER BY "createdAt" DESC LIMIT 1`
  const secret = (await (app.auth as NonNullable<typeof app.auth>).$context).secretConfig
  const jwk = JSON.parse(await symmetricDecrypt({ key: secret, data: JSON.parse(key?.private) }))
  const now = Math.floor(NOW.getTime() / 1000)
  const now2 = Math.floor(Date.now() / 1000)
  void now
  const payload: Record<string, unknown> = {
    iss: app.base,
    aud: mcpUrl(app.base),
    sub: over.sub ?? a.userId,
    azp: CLIENT_ID,
    scope: 'ledger:read ledger:write',
    iat: now2,
    exp: now2 + 900,
    ...over.claims,
  }
  for (const k of over.dropClaims ?? []) delete payload[k]
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const input = `${b64({ alg: 'EdDSA', typ: 'at+jwt', kid: key?.id, ...over.header })}.${b64(payload)}`
  const signature = sign(null, Buffer.from(input), createPrivateKey({ key: jwk, format: 'jwk' }))
  return `${input}.${signature.toString('base64url')}`
}

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

  it('a token that was not given ledger:read is told insufficient_scope with the challenge: 403', async () => {
    const r = await rpc(await forge({ claims: { scope: 'ledger:write' } }), 'tools/list')
    expect(r.status).toBe(403)
    const challenge = r.headers.get('www-authenticate') ?? ''
    expect(challenge).toContain('insufficient_scope')
    expect(challenge).toContain('ledger:read')
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

  it('tools/list: exactly the three read tools, read-only, closed to the world, with an output schema and words a client reads', async () => {
    const r = await rpc(a.access_token, 'tools/list')
    const tools = r.body?.result.tools as Json[]
    expect(tools.map((t) => t.name).sort()).toEqual([
      'warren_find_movements',
      'warren_list_facts',
      'warren_summarize',
    ])
    for (const t of tools) {
      expect(t.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      })
      expect(t.outputSchema, t.name).toBeTruthy()
      expect(t.outputSchema.additionalProperties, t.name).not.toBe(false) // open, for a field added later
      expect(t.description.length, t.name).toBeGreaterThan(80)
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
      name: 'warren_log_movements',
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
    expect(await bad({ from: '2026-13-01' })).toContain('dates are yyyy-mm-dd')
    expect(await bad({ amount: 'mucho' })).toContain('amount is not a decimal string')
    expect(await bad({ cursor: 'AAAA' })).toContain('Invalid cursor')
    const r = await rpc(a.access_token, 'tools/call', {
      name: 'warren_find_movements',
      arguments: { limit: 500 },
    })
    expect(r.body?.error ?? r.body?.result?.isError).toBeTruthy() // over the page cap: refused by the schema
  })

  it('a page of 50 is far under what a client takes', async () => {
    const out = await call(a.access_token, 'warren_find_movements', { limit: 50 })
    // About 5k tokens against Claude Code's 25k: far under, so a page of 50 never needs trimming.
    expect(JSON.stringify(out).length).toBeLessThan(25_000) // a tenth of the 25k-token limit, in characters
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

describe("the tools' own scope check", () => {
  it('each read tool refuses a caller without ledger:read, whatever the door let through', async () => {
    const handlers = new Map<string, (input: unknown) => Promise<ToolResult>>()
    registerReadTools(
      {
        registerTool: (name: string, _config: unknown, handler: never) =>
          handlers.set(name, handler),
      } as never,
      { sql, accountId: await accountOf(WA_A), scopes: new Set(['ledger:write']), now: () => NOW },
    )
    expect([...handlers.keys()].sort()).toEqual([
      'warren_find_movements',
      'warren_list_facts',
      'warren_summarize',
    ])
    for (const [name, handler] of handlers) {
      expect(refusal(await handler({ limit: 5 })), name).toContain('"ledger:read" scope')
    }
  })
})

// ---- Two people

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
