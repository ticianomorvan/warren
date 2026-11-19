import { Client, fromJsonSchema, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { asUser, schema, seedAccounts } from '@warren/db'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeCursor, encodeCursor } from '../lib/mcp-ledger'
import { asOwner, callMcp, connect, mcp, RESOURCE, setup, signedInUser, t } from './harness'

const NOW = new Date('2026-11-18T15:30:00.000Z')
/** Planted in the four movement columns that must never leave. */
const MARKERS = {
  reference: 'MARK-REFERENCE-7f3a',
  reason: 'MARK-REASON-91bc',
  counterpartyAccount: 'MARK-CBU-0000003100099999999999',
  counterpartyTaxId: 'MARK-CUIT-20123456786',
}
const TOTAL = 120

let a: { id: string; token: string }
let b: { id: string; token: string }
let empty: { id: string; token: string }
/** Every body the server sent, as text. */
const bodies: string[] = []

const client = async (bearer: string) => {
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(RESOURCE), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: async (input, init) => {
        const res = await mcp(new Request(input as RequestInfo | URL, init))
        bodies.push(await res.clone().text())
        return res
      },
    }),
  )
  return c
}

async function seed(userId: string) {
  await asOwner(() =>
    asUser(t.owner, userId, async (scope) => {
      await seedAccounts(scope, [
        {
          id: 'asset:bank:main',
          kind: 'asset',
          name: 'Caja de ahorro',
          currency: 'ARS',
          institution: 'Bank',
          identifiers: [],
        },
        {
          id: 'asset:bank:usd',
          kind: 'asset',
          name: 'Cuenta USD',
          currency: 'USD',
          institution: 'Bank',
          identifiers: [],
        },
      ])
      const rows = Array.from({ length: TOTAL }, (_, i) => {
        const transfer = i % 10 === 0
        return {
          userId,
          id: crypto.randomUUID(),
          direction: i % 3 === 0 ? 'in' : 'out',
          amount: `${1000 + i}.50`,
          currency: 'ARS',
          // Several movements share a day, so the cursor must tell them apart by sequence.
          date: `2026-10-${String(1 + Math.floor(i / 5)).padStart(2, '0')}`,
          time: i % 2 ? '14:05:00' : null,
          accountId: 'asset:bank:main',
          counterAccountId: transfer ? 'asset:bank:usd' : null,
          counterpartyName: transfer ? null : `Comercio ${i}`,
          counterpartyAccount: MARKERS.counterpartyAccount,
          counterpartyTaxId: MARKERS.counterpartyTaxId,
          reference: MARKERS.reference,
          reason: MARKERS.reason,
          cardLastFour: transfer ? null : '1234',
          type: transfer ? 'own_transfer' : 'card_purchase',
          lastEventSeq: i + 1,
        }
      })
      await scope.tx.insert(schema.movement).values(rows)
    }),
  )
}

beforeAll(async () => {
  await setup(() => NOW)
  const make = async () => {
    const u = await signedInUser()
    return { id: u.id, token: (await connect(u)).access_token }
  }
  a = await make()
  b = await make()
  empty = await make()
  await seed(a.id)
  await seed(b.id)
  // B has rows too, so "sees none of A's" is not "sees nothing at all".
  await asOwner(() =>
    t.pg.query("update movement set counterparty_name = 'DE-B' where user_id = $1", [b.id]),
  )
})

type Out = {
  movements: Record<string, unknown>[]
  next_cursor: string | null
  as_of: string
}
const list = async (c: Client, args: Record<string, unknown> = {}) => {
  const res = await c.callTool({ name: 'ledger_list_movements', arguments: args })
  return res as typeof res & { structuredContent?: Out }
}

describe('ledger_list_movements', () => {
  it('is listed with its annotations and an output schema', async () => {
    const { tools } = await (await client(a.token)).listTools()
    expect(tools.map((x) => x.name)).toEqual([
      'ledger_list_movements',
      'ledger_summarize',
      'knowledge_list_principles',
      'knowledge_list_facts',
    ])
    const tool = tools.find((x) => x.name === 'ledger_list_movements')
    expect(tool?.title).toBeTruthy()
    expect(tool?.description).toMatch(/^Lists the user's ledger movements, newest first/)
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true,
    })
    expect(tool?.outputSchema).toBeTruthy()
    expect(tool?.inputSchema?.properties?.limit).toMatchObject({
      default: 50,
      minimum: 1,
      maximum: 200,
    })
    expect(tool?.inputSchema?.properties).toMatchObject({
      limit: expect.anything(),
      cursor: expect.anything(),
    })
  })

  it('reads a page, then follows next_cursor to the end without gaps or repeats', async () => {
    const c = await client(a.token)
    const ids: string[] = []
    const keys: string[] = []
    const amounts: number[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const res = await list(c, cursor ? { cursor } : {})
      expect(res.isError).toBeFalsy()
      const out = res.structuredContent as Out
      // The text block is the same JSON.
      expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual(out)
      expect(out.as_of).toBe(NOW.toISOString())
      expect(out.movements.length).toBeLessThanOrEqual(50)
      for (const m of out.movements) {
        ids.push(m.id as string)
        keys.push(`${m.date}`)
        amounts.push(Number.parseFloat(m.amount as string))
      }
      cursor = out.next_cursor ?? undefined
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(ids).toHaveLength(TOTAL)
    expect(new Set(ids).size).toBe(TOTAL)
    expect(keys).toEqual([...keys].sort().reverse())
    // Within a day, newest first by seq: the amount is 1000 + seq, so it must fall.
    for (let i = 1; i < keys.length; i++)
      if (keys[i] === keys[i - 1]) expect(amounts[i]).toBeLessThan(amounts[i - 1] as number)
  })

  it('builds each movement field by field, amount as stored, display formatted', async () => {
    const out = (await list(await client(a.token), { limit: 2 })).structuredContent as Out
    const first = out.movements[0]
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [
        'account',
        'amount',
        'card_last_four',
        'counter_account',
        'counterparty',
        'currency',
        'date',
        'direction',
        'display',
        'id',
        'time',
        'type',
      ].sort(),
    )
    // lastEventSeq 120 is the newest: i = 119, a card purchase.
    expect(first).toMatchObject({
      date: '2026-10-24',
      type: 'card_purchase',
      direction: 'out',
      amount: '1119.50000000',
      currency: 'ARS',
      display: '$ 1.119,50',
      counterparty: 'Comercio 119',
      account: 'Caja de ahorro',
      counter_account: null,
      card_last_four: '1234',
    })
    expect(out.movements).toHaveLength(2)
    expect(out.next_cursor).not.toBeNull()
  })

  it("shows B none of A's rows, and a user with no movements an empty list", async () => {
    const aIds = new Set<string>()
    const ca = await client(a.token)
    for (let cursor: string | undefined; ; ) {
      const out = (await list(ca, { limit: 200, ...(cursor ? { cursor } : {}) }))
        .structuredContent as Out
      for (const m of out.movements) aIds.add(m.id as string)
      cursor = out.next_cursor ?? undefined
      if (!cursor) break
    }
    const outB = (await list(await client(b.token), { limit: 200 })).structuredContent as Out
    expect(outB.movements).toHaveLength(TOTAL)
    expect(outB.movements.every((m) => !aIds.has(m.id as string))).toBe(true)
    expect(outB.movements.every((m) => m.counterparty === 'DE-B' || m.counterparty === null)).toBe(
      true,
    )

    const none = (await list(await client(empty.token))).structuredContent as Out
    expect(none).toEqual({ movements: [], next_cursor: null, as_of: NOW.toISOString() })
  })

  it('validates against the declared output schema', async () => {
    const c = await client(a.token)
    const { tools } = await c.listTools()
    const schema = fromJsonSchema<Out>(
      tools.find((x) => x.name === 'ledger_list_movements')?.outputSchema as never,
    )
    const valid = (value: unknown) => {
      const r = schema['~standard'].validate(value) as { issues?: unknown[] }
      return !r.issues
    }
    for (const args of [{}, { limit: 7 }, { limit: 200 }]) {
      const res = await list(c, args)
      expect(valid(res.structuredContent)).toBe(true)
    }
    // And the schema is not vacuous: a wrong type or a missing field fails it.
    expect(valid({ movements: [{ id: 1 }], next_cursor: null, as_of: 'x' })).toBe(false)
    expect(valid({ movements: [], as_of: 'x' })).toBe(false)
  })

  it('never lets a planted reference, reason or account out, in any body', async () => {
    bodies.length = 0
    const c = await client(a.token)
    await c.listTools()
    let cursor: string | undefined
    do {
      const out = (await list(c, { limit: 100, ...(cursor ? { cursor } : {}) }))
        .structuredContent as Out
      cursor = out.next_cursor ?? undefined
    } while (cursor)
    await list(c, { cursor: 'not-a-cursor' })
    expect(bodies.join('\n')).toContain('ledger_list_movements')
    expect(bodies.join('\n')).toContain('Comercio')
    for (const marker of Object.values(MARKERS)) expect(bodies.join('\n')).not.toContain(marker)
    for (const word of [
      'reference',
      'reason',
      'counterparty_account',
      'counterparty_tax_id',
      'MARK-',
    ])
      expect(bodies.join('\n')).not.toContain(word)
  })

  it.each([
    ['not base64url', '!!!'],
    ['base64url of something else', Buffer.from('hello').toString('base64url')],
    ['a keyset with an impossible date', encodeCursor('2026-13-45_3')],
    [
      'a keyset with SQL in it',
      Buffer.from("2026-10-01_1'; drop table movement; --").toString('base64url'),
    ],
    ['padded base64', `${encodeCursor('2026-10-01_3')}==`],
    ['too long', 'A'.repeat(500)],
  ])('answers a bad cursor (%s) with a short hint', async (_, cursor) => {
    const res = await list(await client(a.token), { cursor })
    expect(res.isError).toBe(true)
    const text = (res.content[0] as { text: string }).text
    expect(text).toMatch(/^Invalid cursor/)
    expect(text).not.toMatch(/\bat\s.*\(.*:\d+/)
  })

  it.each([0, 201, -1, 1.5, '10'])(
    'answers limit %j with a clean error and no rows',
    async (limit) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const raw = await callMcp(a.token, {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'ledger_list_movements', arguments: { limit } },
        })
        const text = await raw.text()
        expect(text).not.toMatch(/node_modules|\.ts:\d+|\n\s+at /)
        expect(text).not.toContain('"movements"')
        expect(text).toMatch(/limit/i)
      } finally {
        spy.mockRestore()
      }
    },
  )

  it('round-trips cursors it made, and refuses ones it did not', () => {
    expect(decodeCursor(encodeCursor('2026-10-05_17'))).toBe('2026-10-05_17')
    expect(decodeCursor('2026-10-05_17')).toBeNull()
  })

  it('takes no user id from its arguments', async () => {
    const out = (await list(await client(b.token), { limit: 200, user_id: a.id }))
      .structuredContent as Out
    expect(out.movements.every((m) => m.counterparty === 'DE-B' || m.counterparty === null)).toBe(
      true,
    )
  })
})
