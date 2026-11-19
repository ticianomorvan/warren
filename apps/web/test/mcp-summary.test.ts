import { Client, fromJsonSchema, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { policyViolations } from '@warren/core'
import { asUser, schema, seedAccounts } from '@warren/db'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createMcpRoute } from '../lib/mcp'
import { decodeCursor, encodeCursor, rangeError } from '../lib/mcp-ledger'
import { asOwner, auth, callMcp, connect, mcp, RESOURCE, setup, signedInUser, t } from './harness'

const NOW = new Date('2026-11-19T15:30:00.000Z')
const OCT = { from: '2026-10-01', to: '2026-10-31' }

let a: { id: string; token: string }
let b: { id: string; token: string }
let empty: { id: string; token: string }

const client = async (bearer: string, route: (r: Request) => Promise<Response> = mcp) => {
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(RESOURCE), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: async (input, init) => route(new Request(input as RequestInfo | URL, init)),
    }),
  )
  return c
}

type Money = { amount: string; display: string }
type Totals = { count: number; in: Money; out: Money; net: Money }
type Summary = {
  from: string
  to: string
  currencies: (Totals & {
    currency: string
    by_type: (Totals & { type: string })[]
    by_account: (Totals & { account: string | null })[]
  })[]
  own_transfers: { currency: string; count: number; in: Money; out: Money }[]
  as_of: string
}
const summarize = async (c: Client, args: Record<string, unknown>) => {
  const res = await c.callTool({ name: 'ledger_summarize', arguments: args })
  return res as typeof res & { structuredContent?: Summary }
}

type Row = {
  direction: 'in' | 'out'
  amount: string
  currency: 'ARS' | 'USD'
  date: string
  type: 'card_purchase' | 'unclassified' | 'own_transfer'
  accountId: string | null
  counterAccountId?: string
}
const OWN = 'asset:bank:main'
const USD = 'asset:bank:usd'

async function seed(userId: string, rows: Row[]) {
  await asOwner(() =>
    asUser(t.owner, userId, async (scope) => {
      await seedAccounts(scope, [
        {
          id: OWN,
          kind: 'asset',
          name: 'Caja de ahorro',
          currency: 'ARS',
          institution: 'Bank',
          identifiers: [],
        },
        {
          id: USD,
          kind: 'asset',
          name: 'Cuenta USD',
          currency: 'USD',
          institution: 'Bank',
          identifiers: [],
        },
      ])
      await scope.tx.insert(schema.movement).values(
        rows.map((r, i) => ({
          userId,
          id: crypto.randomUUID(),
          time: null,
          counterAccountId: null,
          counterpartyName: null,
          lastEventSeq: i + 1,
          ...r,
        })),
      )
    }),
  )
}

// Every amount below is written by hand, and so is every total the tests expect.
const A_ROWS: Row[] = [
  // 0.10 + 0.20 on one day: floats give 0.30000000000000004.
  {
    direction: 'out',
    amount: '0.10',
    currency: 'ARS',
    date: '2026-10-03',
    type: 'card_purchase',
    accountId: OWN,
  },
  {
    direction: 'out',
    amount: '0.20',
    currency: 'ARS',
    date: '2026-10-03',
    type: 'card_purchase',
    accountId: OWN,
  },
  {
    direction: 'out',
    amount: '1000.50',
    currency: 'ARS',
    date: '2026-10-05',
    type: 'card_purchase',
    accountId: OWN,
  },
  // Past 2^53, which a float cannot hold exactly.
  {
    direction: 'out',
    amount: '12345678901234.56',
    currency: 'ARS',
    date: '2026-10-06',
    type: 'card_purchase',
    accountId: OWN,
  },
  {
    direction: 'out',
    amount: '1.00',
    currency: 'ARS',
    date: '2026-10-07',
    type: 'card_purchase',
    accountId: null,
  },
  {
    direction: 'out',
    amount: '50.00',
    currency: 'ARS',
    date: '2026-10-08',
    type: 'unclassified',
    accountId: OWN,
  },
  {
    direction: 'in',
    amount: '5000.25',
    currency: 'ARS',
    date: '2026-10-09',
    type: 'unclassified',
    accountId: OWN,
  },
  {
    direction: 'in',
    amount: '100.10',
    currency: 'USD',
    date: '2026-10-10',
    type: 'unclassified',
    accountId: USD,
  },
  {
    direction: 'out',
    amount: '20.20',
    currency: 'USD',
    date: '2026-10-11',
    type: 'card_purchase',
    accountId: USD,
  },
  // The two sides of a move between the person's own accounts.
  {
    direction: 'out',
    amount: '3000.00',
    currency: 'ARS',
    date: '2026-10-12',
    type: 'own_transfer',
    accountId: OWN,
    counterAccountId: USD,
  },
  {
    direction: 'in',
    amount: '2.00',
    currency: 'USD',
    date: '2026-10-12',
    type: 'own_transfer',
    accountId: USD,
    counterAccountId: OWN,
  },
  // Outside October.
  {
    direction: 'out',
    amount: '777.00',
    currency: 'ARS',
    date: '2026-11-01',
    type: 'card_purchase',
    accountId: OWN,
  },
  {
    direction: 'out',
    amount: '888.00',
    currency: 'ARS',
    date: '2026-09-30',
    type: 'card_purchase',
    accountId: OWN,
  },
]
const B_ROWS: Row[] = [
  {
    direction: 'out',
    amount: '42.00',
    currency: 'ARS',
    date: '2026-10-04',
    type: 'card_purchase',
    accountId: OWN,
  },
]

beforeAll(async () => {
  await setup(() => NOW)
  const make = async () => {
    const u = await signedInUser()
    return { id: u.id, token: (await connect(u)).access_token }
  }
  a = await make()
  b = await make()
  empty = await make()
  await seed(a.id, A_ROWS)
  await seed(b.id, B_ROWS)
})

const zero = { amount: '0.00000000', display: '$ 0,00' }

describe('ledger_summarize', () => {
  it('sums exactly, per currency, by type and by account, with own transfers apart', async () => {
    const res = await summarize(await client(a.token), OCT)
    expect(res.isError).toBeFalsy()
    const out = res.structuredContent as Summary
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual(out)
    expect(out.from).toBe('2026-10-01')
    expect(out.to).toBe('2026-10-31')
    expect(out.as_of).toBe(NOW.toISOString())
    expect(out.currencies.map((c) => c.currency)).toEqual(['ARS', 'USD'])

    expect(out.currencies[0]).toEqual({
      currency: 'ARS',
      count: 7,
      in: { amount: '5000.25000000', display: '$ 5.000,25' },
      out: { amount: '12345678902286.36000000', display: '$ 12.345.678.902.286,36' },
      net: { amount: '-12345678897286.11000000', display: '-$ 12.345.678.897.286,11' },
      by_type: [
        {
          type: 'card_purchase',
          count: 5,
          in: zero,
          out: { amount: '12345678902236.36000000', display: '$ 12.345.678.902.236,36' },
          net: { amount: '-12345678902236.36000000', display: '-$ 12.345.678.902.236,36' },
        },
        {
          type: 'unclassified',
          count: 2,
          in: { amount: '5000.25000000', display: '$ 5.000,25' },
          out: { amount: '50.00000000', display: '$ 50,00' },
          net: { amount: '4950.25000000', display: '$ 4.950,25' },
        },
      ],
      by_account: [
        {
          account: 'Caja de ahorro',
          count: 6,
          in: { amount: '5000.25000000', display: '$ 5.000,25' },
          out: { amount: '12345678902285.36000000', display: '$ 12.345.678.902.285,36' },
          net: { amount: '-12345678897285.11000000', display: '-$ 12.345.678.897.285,11' },
        },
        {
          account: null,
          count: 1,
          in: zero,
          out: { amount: '1.00000000', display: '$ 1,00' },
          net: { amount: '-1.00000000', display: '-$ 1,00' },
        },
      ],
    })
    expect(out.currencies[1]).toMatchObject({
      currency: 'USD',
      count: 2,
      in: { amount: '100.10000000', display: 'US$ 100,10' },
      out: { amount: '20.20000000', display: 'US$ 20,20' },
      net: { amount: '79.90000000', display: 'US$ 79,90' },
    })
    expect(out.currencies[1]?.by_account).toHaveLength(1)
    // 3000 ARS and 2 USD moved between own accounts are in no total above.
    expect(out.own_transfers).toEqual([
      {
        currency: 'ARS',
        count: 1,
        in: zero,
        out: { amount: '3000.00000000', display: '$ 3.000,00' },
      },
      {
        currency: 'USD',
        count: 1,
        in: { amount: '2.00000000', display: 'US$ 2,00' },
        out: { amount: '0.00000000', display: 'US$ 0,00' },
      },
    ])
  })

  it('adds 0.10 and 0.20 to exactly 0.30, and counts both ends of the range', async () => {
    const c = await client(a.token)
    const day = (await summarize(c, { from: '2026-10-03', to: '2026-10-03' })).structuredContent
    expect(day?.currencies).toHaveLength(1)
    expect(day?.currencies[0]?.out).toEqual({ amount: '0.30000000', display: '$ 0,30' })
    expect(day?.currencies[0]?.count).toBe(2)
    expect(day?.own_transfers).toEqual([])
    // Nov 1 and Sep 30 sit just outside; widening the range by a day each way brings them in.
    const wide = (await summarize(c, { from: '2026-09-30', to: '2026-11-01' })).structuredContent
    expect(wide?.currencies[0]?.out.amount).toBe('12345678903951.36000000')
  })

  it('returns an empty list for a range with nothing, and for a user with nothing', async () => {
    const quiet = await summarize(await client(a.token), { from: '2026-01-01', to: '2026-01-31' })
    expect(quiet.structuredContent).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      currencies: [],
      own_transfers: [],
      as_of: NOW.toISOString(),
    })
    const none = await summarize(await client(empty.token), OCT)
    expect(none.structuredContent?.currencies).toEqual([])
    expect(none.structuredContent?.own_transfers).toEqual([])
  })

  it("shows B none of A's totals", async () => {
    const out = (await summarize(await client(b.token), OCT)).structuredContent as Summary
    expect(out.currencies).toHaveLength(1)
    expect(out.currencies[0]).toMatchObject({
      currency: 'ARS',
      count: 1,
      in: zero,
      out: { amount: '42.00000000', display: '$ 42,00' },
    })
    expect(out.own_transfers).toEqual([])
    expect(JSON.stringify(out)).not.toContain('12345678')
    // And it takes no user id from its arguments.
    const forged = (await summarize(await client(b.token), { ...OCT, user_id: a.id }))
      .structuredContent as Summary
    expect(forged.currencies[0]?.out.amount).toBe('42.00000000')
  })

  it('has exactly the declared fields at every level', async () => {
    const out = (await summarize(await client(a.token), OCT)).structuredContent as Summary
    const totals = ['count', 'in', 'net', 'out']
    expect(Object.keys(out).sort()).toEqual(['as_of', 'currencies', 'from', 'own_transfers', 'to'])
    const c = out.currencies[0]
    expect(Object.keys(c ?? {}).sort()).toEqual(
      ['by_account', 'by_type', 'currency', ...totals].sort(),
    )
    expect(Object.keys(c?.by_type[0] ?? {}).sort()).toEqual(['type', ...totals].sort())
    expect(Object.keys(c?.by_account[0] ?? {}).sort()).toEqual(['account', ...totals].sort())
    expect(Object.keys(c?.in ?? {}).sort()).toEqual(['amount', 'display'])
    expect(Object.keys(out.own_transfers[0] ?? {}).sort()).toEqual([
      'count',
      'currency',
      'in',
      'out',
    ])
  })

  it('validates against the declared output schema, which is not vacuous', async () => {
    const c = await client(a.token)
    const { tools } = await c.listTools()
    const declared = fromJsonSchema<Summary>(
      tools.find((x) => x.name === 'ledger_summarize')?.outputSchema as never,
    )
    const valid = (value: unknown) =>
      !(declared['~standard'].validate(value) as { issues?: unknown[] }).issues
    for (const args of [OCT, { from: '2026-01-01', to: '2026-01-02' }])
      expect(valid((await summarize(c, args)).structuredContent)).toBe(true)
    expect(
      valid({
        from: 'x',
        to: 'y',
        currencies: [{ currency: 'ARS' }],
        own_transfers: [],
        as_of: 'z',
      }),
    ).toBe(false)
    expect(valid({ from: 'x' })).toBe(false)
  })

  it.each([
    ['from after to', { from: '2026-10-31', to: '2026-10-01' }, /not be after/],
    ['impossible date', { from: '2026-02-30', to: '2026-03-01' }, /real days/],
    ['367 days', { from: '2026-01-01', to: '2027-01-02' }, /at most 366/],
  ])('answers a bad range (%s) with a short hint and no data', async (_, args, hint) => {
    const res = await summarize(await client(a.token), args)
    expect(res.isError).toBe(true)
    const text = (res.content[0] as { text: string }).text
    expect(text).toMatch(/^Invalid range/)
    expect(text).toMatch(hint)
    expect(text).not.toMatch(/node_modules|\.ts:\d+|\n\s+at /)
  })

  it('refuses a from that is not written yyyy-mm-dd, before it reaches the ledger', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const raw = await callMcp(a.token, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'ledger_summarize', arguments: { from: 'last month', to: '2026-10-31' } },
      })
      const text = await raw.text()
      expect(text).toMatch(/from/)
      expect(text).not.toMatch(/node_modules|\.ts:\d+|\n\s+at /)
      expect(text).not.toContain('"currencies"')
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses days before 2000, in a range and in a cursor', () => {
    expect(rangeError('1999-12-31', '2000-01-02')).toMatch(/real days/)
    expect(rangeError('0001-01-01', '0001-01-02')).toMatch(/real days/)
    expect(rangeError('2000-01-01', '2000-01-02')).toBeNull()
    expect(decodeCursor(encodeCursor('1999-12-31_5'))).toBeNull()
    expect(decodeCursor(encodeCursor('2000-01-01_5'))).toBe('2000-01-01_5')
  })

  it('accepts 366 days and a one-day range', () => {
    expect(rangeError('2026-01-01', '2027-01-01')).toBeNull()
    expect(rangeError('2028-01-01', '2028-12-31')).toBeNull()
    expect(rangeError('2026-10-05', '2026-10-05')).toBeNull()
  })

  it.each([undefined, 5, null])(
    'answers a missing or mistyped argument (%j) cleanly',
    async (bad) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const raw = await callMcp(a.token, {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'ledger_summarize', arguments: { from: bad, to: '2026-10-31' } },
        })
        const text = await raw.text()
        expect(text).not.toMatch(/node_modules|\.ts:\d+|\n\s+at /)
        expect(text).not.toContain('"currencies"')
      } finally {
        spy.mockRestore()
      }
    },
  )
})

describe('knowledge tools', () => {
  type Facts = { facts: Record<string, unknown>[]; checked_at: string }
  type Principles = { principles: Record<string, unknown>[]; traps: Record<string, unknown>[] }
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
    (await c.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: { text: string }[]
      structuredContent?: unknown
    }
  const at = (now: string) =>
    createMcpRoute({
      auth,
      authDatabase: t.auth,
      database: t.app,
      resource: RESOURCE,
      now: () => new Date(now),
    })

  it('lists all four tools with their annotations, titles and output schemas', async () => {
    const { tools } = await (await client(a.token)).listTools()
    expect(tools.map((x) => x.name)).toEqual([
      'ledger_list_movements',
      'ledger_summarize',
      'knowledge_list_principles',
      'knowledge_list_facts',
    ])
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy()
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      })
      expect(tool.outputSchema, tool.name).toBeTruthy()
      // Descriptions say what comes back; they do not instruct.
      expect(tool.description, tool.name).toMatch(/^(Lists|Returns)/)
      expect(policyViolations([tool.description ?? '', tool.title ?? '']), tool.name).toEqual([])
      expect(tool.description, tool.name).not.toMatch(
        /\b(you must|you should|always call|ask the user)\b/i,
      )
    }
    const summarizeTool = tools.find((x) => x.name === 'ledger_summarize')
    expect(summarizeTool?.inputSchema?.required).toEqual(['from', 'to'])
  })

  it('marks a fact stale only the day after its review_by, with a fixed clock', async () => {
    const stale = async (now: string) => {
      const out = (
        await call(await client(a.token, at(now)), 'knowledge_list_facts', { topic: 'fx' })
      ).structuredContent as Facts
      expect(out.checked_at).toBe(new Date(now).toISOString())
      return Object.fromEntries(out.facts.map((f) => [f.id, f.stale]))
    }
    // fx-official-wholesale: review_by 2026-11-25, a day that ends at 03:00Z in Buenos Aires.
    expect(await stale('2026-11-19T12:00:00Z')).toEqual({
      'fx-official-wholesale': false,
      'fx-official-retail': false,
    })
    expect((await stale('2026-11-26T02:30:00Z'))['fx-official-wholesale']).toBe(false)
    expect((await stale('2026-11-26T03:00:00Z'))['fx-official-wholesale']).toBe(true)
    expect(await stale('2027-06-01T00:00:00Z')).toEqual({
      'fx-official-wholesale': true,
      'fx-official-retail': true,
    })
  })

  it('returns facts with exactly the declared fields, source and dates', async () => {
    const res = await call(await client(a.token), 'knowledge_list_facts')
    const out = res.structuredContent as Facts
    expect(JSON.parse(res.content[0]?.text ?? '')).toEqual(out)
    expect(out.facts.length).toBeGreaterThan(0)
    for (const f of out.facts) {
      const required = [
        'as_of',
        'id',
        'review_by',
        'source_name',
        'source_url',
        'stale',
        'statement',
        'topic',
        'volatility',
      ]
      const optional = ['display', 'needs_professional', 'parts', 'unit', 'value']
      const keys = Object.keys(f)
      for (const key of required) expect(keys, `${f.id} ${key}`).toContain(key)
      for (const key of keys) expect([...required, ...optional], `${f.id} ${key}`).toContain(key)
      expect(f.source_url).toMatch(/^https:\/\//)
      expect(typeof f.stale).toBe('boolean')
      if (f.value !== undefined) expect(typeof f.display, String(f.id)).toBe('string')
    }
    const scale = out.facts.find((f) => f.id === 'monotributo-scale') as
      | { parts: { label: string; value: string; unit: string; display: string }[] }
      | undefined
    expect(scale?.parts[0]).toEqual({
      label: 'Category A',
      value: '12009410.45',
      unit: 'ARS',
      display: '$ 12.009.410,45',
    })
    const filtered = (await call(await client(a.token), 'knowledge_list_facts', { topic: 'taxes' }))
      .structuredContent as Facts
    expect(filtered.facts.length).toBeGreaterThan(0)
    expect(filtered.facts.every((f) => f.topic === 'taxes')).toBe(true)
  })

  it('returns principles filtered by topic, and every trap', async () => {
    const c = await client(a.token)
    const all = (await call(c, 'knowledge_list_principles')).structuredContent as Principles
    const cards = (await call(c, 'knowledge_list_principles', { topic: 'cards' }))
      .structuredContent as Principles
    expect(all.principles.length).toBeGreaterThan(0)
    expect(cards.principles.length).toBeGreaterThan(0)
    expect(cards.principles.length).toBeLessThan(all.principles.length)
    expect(cards.principles.every((p) => (p.applies_to as string[]).includes('cards'))).toBe(true)
    expect(cards.traps).toEqual(all.traps)
    expect(all.traps.length).toBeGreaterThan(0)
    expect(Object.keys(all.principles[0] ?? {}).sort()).toEqual([
      'applies_to',
      'body',
      'id',
      'title',
    ])
    expect(Object.keys(all.traps[0] ?? {}).sort()).toEqual(['id', 'signs', 'title', 'what_to_do'])
  })

  it('validates both outputs against their declared schemas', async () => {
    const c = await client(a.token)
    const { tools } = await c.listTools()
    for (const [name, args] of [
      ['knowledge_list_facts', {}],
      ['knowledge_list_facts', { topic: 'rates' }],
      ['knowledge_list_principles', {}],
    ] as const) {
      const declared = fromJsonSchema<unknown>(
        tools.find((x) => x.name === name)?.outputSchema as never,
      )
      const res = await call(c, name, args)
      expect(res.isError).toBeFalsy()
      expect(
        (declared['~standard'].validate(res.structuredContent) as { issues?: unknown[] }).issues,
      ).toBeUndefined()
      expect(
        (declared['~standard'].validate({ nope: 1 }) as { issues?: unknown[] }).issues,
      ).toBeTruthy()
    }
  })

  it('refuses an unknown topic without data', async () => {
    const raw = await callMcp(a.token, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'knowledge_list_facts', arguments: { topic: 'memecoins' } },
    })
    const text = await raw.text()
    expect(text).not.toContain('"facts"')
    expect(text).not.toMatch(/node_modules|\.ts:\d+/)
  })

  it('needs a token, like the rest of /api/mcp', async () => {
    const res = await callMcp(null, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'knowledge_list_facts', arguments: {} },
    })
    expect(res.status).toBe(401)
  })
})
