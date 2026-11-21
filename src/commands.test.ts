import { describe, expect, it } from 'vitest'
import type { Changes, Command, Movement } from './parse'
import { REPLY_GONE, REPLY_NO_CHANGES, REPLY_NO_MOVEMENTS } from './render'
import {
  movement as base,
  bodies,
  fakeModel,
  gate,
  messageBody,
  post,
  row,
  setup,
  sql,
  TODAY,
  until,
  useDatabase,
} from './test-harness'

useDatabase()

const WA = '5491100000000'
/** The harness café, with no payment unless a test gives one. */
const movement = (o: Partial<Movement> = {}) => base({ payment: null, ...o })
const NONE: Changes = {
  direction: null,
  amount: null,
  currency: null,
  date: null,
  description: null,
  category: null,
  payment: null,
}
const logOf = (...movements: Movement[]): Command => ({ type: 'log', movements })
const correct = (
  o: { target?: string; index?: number | null; changes?: Partial<Changes>; low?: boolean } = {},
): Command => ({
  type: 'correct',
  target: o.target ?? 'last',
  target_index: o.index === undefined ? 1 : o.index,
  changes: { ...NONE, ...o.changes },
  confidence: o.low ? 'low' : 'high',
})
const remove = (target = 'last', index: number | null = 1): Command => ({
  type: 'delete',
  target,
  target_index: index,
  confidence: 'high',
})
const ask = (
  period: Extract<Command, { type: 'query' }>['period'],
  o: Partial<Extract<Command, { type: 'query' }>> = {},
): Command => ({ type: 'query', period, direction: 'out', category: null, payment: null, ...o })

type App = Awaited<ReturnType<typeof setup>>

let n = 0
let lastWamid = ''
/** One message in, waits until its reply is out and recorded. Returns that reply. */
async function say(app: App, o: { at?: string } = {}): Promise<string> {
  const wamid = `wamid.CMD${++n}`
  lastWamid = wamid
  const before = app.calls.sent.length
  const extra = o.at ? { timestamp: String(Math.floor(Date.parse(o.at) / 1000)) } : {}
  await post(app.base, messageBody(wamid, WA, extra))
  await until(async () => (await row(wamid))?.status === 'done')
  return bodies(app.calls)[before] ?? ''
}

/** A model that answers each call with the next command. */
const script = (...commands: Command[]) => {
  let i = 0
  return fakeModel(() => commands[i++] as Command)
}

type Seed = {
  on: string
  amount: string
  currency?: Movement['currency']
  direction?: Movement['direction']
  category?: Movement['category']
  payment?: string | null
  description?: string
}
let seeds = 0
/** Stores movements straight in the table, as if earlier messages had logged them. */
async function seed(rows: Seed[]): Promise<void> {
  const [account] = await sql`
    INSERT INTO account (wa_id) VALUES (${WA})
    ON CONFLICT (wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id RETURNING id`
  const [inbound] = await sql`
    INSERT INTO inbound_message (wamid, wa_id, kind, body, payload)
    VALUES (${`seed.${++seeds}`}, ${WA}, 'text', 'seed', '{}'::jsonb) RETURNING id`
  const values = rows.map((r, position) => ({
    account_id: account?.id,
    inbound_message_id: inbound?.id,
    position,
    direction: r.direction ?? 'out',
    amount: r.amount,
    currency: r.currency ?? 'ARS',
    occurred_on: r.on,
    description: r.description ?? 'algo',
    category: r.category ?? 'otros',
    payment: r.payment ?? null,
    confidence: 'high',
  }))
  await sql`INSERT INTO movement ${sql(values)}`
}

const history = () =>
  sql`SELECT id::int AS id, inbound_message_id::int AS inbound, amount::text AS amount, description,
    superseded_by::int AS superseded_by, deleted_at IS NOT NULL AS deleted, deleted_by::int AS deleted_by
    FROM movement ORDER BY id`
const sum = async (where: string) =>
  (await sql.unsafe(`SELECT sum(amount)::text AS total FROM movement WHERE ${where}`))[0]?.total

describe('correct', () => {
  it('inserts a new row linked to the correcting message and keeps the old one, superseded', async () => {
    const app = await setup({
      model: script(
        logOf(movement({ payment: 'crédito visa' })),
        correct({ changes: { amount: '3800' } }),
      ),
    })
    await say(app)
    const reply = await say(app)
    expect(reply).toBe('✓ Corregido: Café $3.800 (crédito visa) (antes $3.500)')
    const rows = await history()
    expect(rows).toHaveLength(2)
    const [old, next] = rows
    expect(old).toMatchObject({ amount: '3500', superseded_by: next?.id, deleted: false })
    expect(next).toMatchObject({ amount: '3800', superseded_by: null, deleted: false })
    expect(next?.inbound).not.toBe(old?.inbound) // linked to the correcting message
    expect(Number((await row(lastWamid))?.id)).toBe(next?.inbound)
    expect(await sum('superseded_by IS NULL')).toBe('3800')
    app.close()
  })

  it('shows only the fields that changed', async () => {
    const app = await setup({
      model: script(
        logOf(movement({ date: '2025-10-08' })),
        correct({ changes: { date: TODAY, payment: 'efectivo' } }),
        correct({ changes: { category: 'entretenimiento' } }),
      ),
    })
    await say(app)
    expect(await say(app)).toBe(
      '✓ Corregido: Café $3.500 (efectivo) · hoy (antes ayer, sin medio de pago)',
    )
    expect(await say(app)).toBe(
      '✓ Corregido: Café $3.500 (efectivo) · Entretenimiento (antes Restaurantes)',
    )
    expect(await history()).toHaveLength(3)
    app.close()
  })

  it('reaches an older movement by its number, or by its words when the number is missing', async () => {
    const app = await setup({
      model: script(
        logOf(
          movement(),
          movement({ description: 'súper', amount: '12000', category: 'supermercado' }),
        ),
        correct({ target: 'súper', index: 2, changes: { amount: '12500' } }),
        correct({ target: 'café', index: null, changes: { amount: '3600' } }),
      ),
    })
    await say(app)
    // After the log, the list is [súper, café] (newest first)... the numbers follow it.
    expect(await say(app)).toBe('✓ Corregido: Súper $12.500 (antes $12.000)')
    expect(await say(app)).toBe('✓ Corregido: Café $3.600 (antes $3.500)')
    expect(await sum('superseded_by IS NULL')).toBe('16100')
    app.close()
  })

  it('does not follow a wrong number whose row the words do not name', async () => {
    // The model says number 1 (the café) for "nafta": the words find the one nafta instead.
    const app = await setup({
      model: script(
        logOf(
          movement({ description: 'nafta', amount: '20000', category: 'combustible' }),
          movement(),
        ),
        correct({ target: 'nafta', index: 1, changes: { amount: '21000' } }),
      ),
    })
    await say(app)
    expect(await say(app)).toBe('✓ Corregido: Nafta $21.000 (antes $20.000)')
    app.close()
  })

  it('asks and changes nothing when the words fit two movements and there is no number', async () => {
    const app = await setup({
      model: script(
        logOf(
          movement({ description: 'café', amount: '2800' }),
          movement({ description: 'café', amount: '3100' }),
        ),
        correct({ target: 'café', index: null, changes: { amount: '4000' } }),
      ),
    })
    await say(app)
    const reply = await say(app)
    expect(reply).toBe('¿Cuál? 1. Café $3.100 · 2. Café $2.800')
    expect(await history()).toHaveLength(2)
    expect((await history()).every((r) => r.superseded_by === null && !r.deleted)).toBe(true)
    expect(await row(lastWamid)).toMatchObject({ status: 'done', reply_text: reply })
    app.close()
  })

  it('asks and changes nothing when the parser is not sure, even with a number', async () => {
    const app = await setup({
      model: script(logOf(movement()), correct({ index: 1, low: true, changes: { amount: '1' } })),
    })
    await say(app)
    expect(await say(app)).toBe('¿Cuál? 1. Café $3.500')
    expect(await sum('superseded_by IS NULL')).toBe('3500')
    app.close()
  })

  it('asks which one when the target names nothing in the list', async () => {
    const app = await setup({
      model: script(
        logOf(movement(), movement({ description: 'súper', amount: '12000' })),
        correct({ target: 'alquiler', index: null, changes: { amount: '1' } }),
      ),
    })
    await say(app)
    expect(await say(app)).toBe('¿Cuál? 1. Súper $12.000 · 2. Café $3.500')
    app.close()
  })

  it('says there is nothing to change when the account has no movements', async () => {
    const app = await setup({ model: script(correct({ changes: { amount: '1' } }), remove()) })
    expect(await say(app)).toBe(REPLY_NO_MOVEMENTS)
    expect(await say(app)).toBe(REPLY_NO_MOVEMENTS)
    app.close()
  })

  it('says when a correction changes nothing, and stores no new row', async () => {
    const app = await setup({
      model: script(
        logOf(movement()),
        correct({ changes: {} }),
        correct({ changes: { amount: '3500.00' } }),
      ),
    })
    await say(app)
    expect(await say(app)).toBe(REPLY_NO_CHANGES)
    expect(await say(app)).toBe('Ya figura así: Café $3.500')
    expect(await history()).toHaveLength(1)
    app.close()
  })

  it('a correction with an unstorable value fails the message and changes nothing', async () => {
    const app = await setup({
      model: script(logOf(movement()), correct({ changes: { amount: '3.500,5' } })),
    })
    await say(app)
    await post(app.base, messageBody('wamid.BADFIX', WA))
    await until(async () => (await row('wamid.BADFIX'))?.status === 'failed')
    expect(await history()).toHaveLength(1)
    app.close()
  })

  it('shows the model the newest 10 live movements, a corrected one counting as new', async () => {
    const seen: string[] = []
    const model = script(
      correct({ target: 'vino', index: 3, changes: { amount: '9' } }),
      ask('this_month'),
    )
    const parse = model.client.messages as unknown as {
      parse: (p: { messages: { content: string }[] }) => Promise<unknown>
    }
    const original = parse.parse
    parse.parse = (p) => {
      seen.push(p.messages[0]?.content ?? '')
      return original(p)
    }
    const NAMES = [
      'pan',
      'sal',
      'luz',
      'gas',
      'cine',
      'taxi',
      'bar',
      'ron',
      'tren',
      'vino',
      'agua',
      'miel',
    ]
    await seed(
      Array.from({ length: 12 }, (_, i) => ({
        on: TODAY,
        amount: String(100 + i),
        description: NAMES[i] ?? '',
      })),
    )
    const app = await setup({ model })
    await say(app)
    expect(seen[0]).toContain('10. out 102 ARS')
    expect(seen[0]).not.toContain('11. ')
    await say(app)
    // The corrected movement (was number 3, vino) is now the newest.
    expect(seen[1]).toMatch(/1\. out 9 ARS \S+ vino /)
    expect(seen[1]).not.toMatch(/\d\. out 109 ARS/)
    app.close()
  })
})

describe('concurrent and replayed messages', () => {
  it('corrects a target that a message in flight already corrected only once', async () => {
    const hold = gate()
    let calls = 0
    const first = correct({ changes: { amount: '3800' } })
    const second = correct({ changes: { amount: '4200' } })
    const model = fakeModel(async (): Promise<Command> => {
      const k = ++calls
      if (k === 1) return logOf(movement())
      await hold.promise // both corrections have read the same list before either commits
      return k === 2 ? first : second
    })
    const app = await setup({ model })
    await say(app)
    await post(app.base, messageBody('wamid.RACE1', WA))
    await post(app.base, messageBody('wamid.RACE2', WA))
    await until(() => app.model.n === 3)
    hold.open()
    await until(async () => {
      const [a, b] = await Promise.all([row('wamid.RACE1'), row('wamid.RACE2')])
      return a?.status === 'done' && b?.status === 'done'
    })
    const replies = new Set(bodies(app.calls).slice(1))
    expect(replies.size).toBe(2)
    expect(replies).toContain(REPLY_GONE)
    expect([...replies].some((r) => r.startsWith('✓ Corregido: '))).toBe(true)
    const rows = await history()
    expect(rows).toHaveLength(2) // the café and one correction, not two
    expect(await sum('superseded_by IS NULL')).toMatch(/^(3800|4200)$/)
    app.close()
  })

  it('a delete racing a correction leaves one outcome, never both', async () => {
    const hold = gate()
    let calls = 0
    const model = fakeModel(async (): Promise<Command> => {
      const k = ++calls
      if (k === 1) return logOf(movement())
      await hold.promise
      return k === 2 ? correct({ changes: { amount: '3800' } }) : remove()
    })
    const app = await setup({ model })
    await say(app)
    await post(app.base, messageBody('wamid.RACE3', WA))
    await post(app.base, messageBody('wamid.RACE4', WA))
    await until(() => app.model.n === 3)
    hold.open()
    await until(
      async () => (await sql`SELECT 1 FROM inbound_message WHERE status = 'done'`).length === 3,
    )
    expect(bodies(app.calls)).toContain(REPLY_GONE)
    const rows = await history()
    // The café ended one way only: replaced by a correction, or deleted, not both.
    const ended = rows.filter((r) => r.deleted || r.superseded_by !== null)
    expect(ended).toHaveLength(1)
    expect(rows.length).toBe(ended[0]?.deleted ? 1 : 2)
    app.close()
  })

  it('a replayed correction or delete applies once: webhook retry, then the sweep re-claiming it', async () => {
    const app = await setup({
      model: script(
        logOf(movement(), movement({ description: 'súper', amount: '12000' })),
        correct({ target: 'súper', index: 1, changes: { amount: '12500' } }),
        remove('café', 2),
      ),
    })
    await say(app)
    const body = messageBody('wamid.FIX', WA)
    await post(app.base, body)
    await until(async () => (await row('wamid.FIX'))?.status === 'done')
    await post(app.base, body) // Meta delivers it again
    await post(app.base, body)
    await new Promise((r) => setTimeout(r, 150))
    expect(await history()).toHaveLength(3)

    await post(app.base, messageBody('wamid.DEL', WA))
    await until(async () => (await row('wamid.DEL'))?.status === 'done')
    const sentBefore = app.calls.sent.length
    // The worker died after the commit and before the reply was recorded: the row is due again.
    await sql`UPDATE inbound_message SET status = 'pending', send_started_at = NULL, reply_sent_at = NULL
      WHERE wamid IN ('wamid.FIX', 'wamid.DEL')`
    await app.processor.sweep()
    expect(app.model.n).toBe(3) // no model call: the stored replies go out
    expect(app.calls.sent.length).toBe(sentBefore + 2)
    const rows = await history()
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.superseded_by !== null)).toHaveLength(1)
    expect(rows.filter((r) => r.deleted)).toHaveLength(1)
    app.close()
  })

  it('a second commit for a message that already has its reply never runs the command', async () => {
    const app = await setup({
      model: script(logOf(movement()), correct({ changes: { amount: '3800' } })),
    })
    await say(app)
    await say(app)
    const [claim] = await sql`
      UPDATE inbound_message SET status = 'processing', attempts = attempts + 1
      WHERE wamid = ${lastWamid} RETURNING id, attempts`
    let ran = false
    const committed = await app.store.commit(
      { id: Number(claim?.id), attempts: Number(claim?.attempts) } as never,
      {
        command: { type: 'help' },
        modelMs: 1,
        execute: async () => {
          ran = true
          return 'x'
        },
      },
    )
    expect(committed).toBeNull()
    expect(ran).toBe(false)
    expect(await history()).toHaveLength(2)
    app.close()
  })
})

describe('delete', () => {
  it('soft-deletes: the row stays, stamped with when and by which message', async () => {
    const app = await setup({ model: script(logOf(movement()), remove()) })
    await say(app)
    expect(await say(app)).toBe('✓ Borré: Café $3.500')
    const rows = await history()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ deleted: true, superseded_by: null })
    expect(rows[0]?.deleted_by).toBe(Number((await row(lastWamid))?.id))
    app.close()
  })

  it('the next "last" is the movement before it, and a deleted one cannot be deleted again', async () => {
    const app = await setup({
      model: script(
        logOf(movement({ description: 'súper', amount: '12000' }), movement()),
        remove(),
        remove(),
        remove(),
        remove(),
      ),
    })
    await say(app)
    expect(await say(app)).toBe('✓ Borré: Café $3.500')
    expect(await say(app)).toBe('✓ Borré: Súper $12.000')
    expect(await say(app)).toBe(REPLY_NO_MOVEMENTS)
    expect(await history()).toHaveLength(2)
    app.close()
  })

  it('asks, and deletes nothing, when the target is ambiguous', async () => {
    const app = await setup({
      model: script(logOf(movement(), movement({ amount: '2800' })), remove('café', null)),
    })
    await say(app)
    expect(await say(app)).toBe('¿Cuál? 1. Café $2.800 · 2. Café $3.500')
    expect((await history()).some((r) => r.deleted)).toBe(false)
    app.close()
  })
})

describe('query', () => {
  const OCT = { on: '2025-10-03' }

  it('equals an independent SQL sum, with every filter applied', async () => {
    await seed([
      { ...OCT, amount: '12000', category: 'supermercado', payment: 'crédito visa' },
      { ...OCT, amount: '4500.50', category: 'supermercado', payment: 'Débito' },
      { on: TODAY, amount: '8000', category: 'supermercado', payment: null },
      { ...OCT, amount: '999', category: 'restaurantes' },
      { on: '2025-09-30', amount: '777', category: 'supermercado' }, // last month
      { ...OCT, amount: '555', category: 'supermercado', direction: 'in' },
      { ...OCT, amount: '33', category: 'supermercado', currency: 'USD' },
    ])
    const app = await setup({
      model: script(
        ask('this_month', { category: 'supermercado' }),
        ask('this_month', { category: 'supermercado', payment: 'CREDITO' }),
      ),
    })
    const reply = await say(app)
    const expected = await sum(
      `direction = 'out' AND currency = 'ARS' AND category = 'supermercado' AND occurred_on BETWEEN '2025-10-01' AND '2025-10-31'`,
    )
    expect(expected).toBe('24500.50')
    expect(reply).toBe(
      'Este mes gastaste $24.500,50 en Súper (3 movimientos).\nY US$ 33 (1 movimiento).',
    )
    // Loose payment: case- and accent-insensitive contains.
    expect(await say(app)).toBe('Este mes gastaste $12.000 en Súper con CREDITO (1 movimiento).')
    app.close()
  })

  it('matches the payment without caring for case or accents', async () => {
    await seed([
      { ...OCT, amount: '100', payment: 'Crédito Visa' },
      { ...OCT, amount: '200', payment: 'credito visa' },
      { ...OCT, amount: '400', payment: 'crédito amex' },
      { ...OCT, amount: '800', payment: null },
    ])
    const app = await setup({
      model: script(
        ask('this_month', { payment: 'crédito VISA' }),
        ask('this_month', { payment: 'CRÉDITO' }),
        ask('this_month', { payment: 'visa' }),
        ask('this_month', { payment: 'mp' }),
      ),
    })
    expect(await say(app)).toBe('Este mes gastaste $300 con crédito VISA (2 movimientos).')
    expect(await say(app)).toBe('Este mes gastaste $700 con CRÉDITO (3 movimientos).')
    expect(await say(app)).toBe('Este mes gastaste $300 con visa (2 movimientos).')
    expect(await say(app)).toBe('No encontré gastos este mes con mp.')
    app.close()
  })

  it('keeps USD apart from ARS and never converts', async () => {
    await seed([
      { ...OCT, amount: '1000' },
      { ...OCT, amount: '2000.5' },
      { ...OCT, amount: '50', currency: 'USD' },
      { ...OCT, amount: '25.25', currency: 'USD' },
    ])
    const app = await setup({
      model: script(ask('this_month'), ask('this_month', { direction: null })),
    })
    expect(await say(app)).toBe(
      'Este mes gastaste $3.000,50 (2 movimientos).\nY US$ 75,25 (2 movimientos).',
    )
    expect(await sum(`currency = 'USD'`)).toBe('75.25')
    expect(await sum(`currency = 'ARS'`)).toBe('3000.5')
    // Only USD exists for income: no pesos line at all.
    await seed([{ ...OCT, amount: '100', currency: 'USD', direction: 'in' }])
    expect(await say(app)).toBe(
      'Este mes gastaste $3.000,50 (2 movimientos).\nY US$ 75,25 (2 movimientos).\nEste mes cobraste US$ 100 (1 movimiento).',
    )
    app.close()
  })

  it('leaves a deleted movement out of the totals, and a superseded one for its replacement', async () => {
    const app = await setup({
      model: script(
        logOf(movement({ amount: '1000' }), movement({ amount: '2000', description: 'súper' })),
        ask('this_month'),
        correct({ changes: { amount: '2500' } }),
        ask('this_month'),
        remove(),
        ask('this_month'),
      ),
    })
    await say(app)
    expect(await say(app)).toBe('Este mes gastaste $3.000 (2 movimientos).')
    await say(app) // súper 2000 -> 2500
    expect(await say(app)).toBe('Este mes gastaste $3.500 (2 movimientos).')
    await say(app) // delete the corrected súper
    expect(await say(app)).toBe('Este mes gastaste $1.000 (1 movimiento).')
    expect(await sum('superseded_by IS NULL AND deleted_at IS NULL')).toBe('1000')
    expect(await history()).toHaveLength(3) // nothing was removed
    app.close()
  })

  it('words income, no filters and no results', async () => {
    await seed([{ ...OCT, amount: '850000', direction: 'in', category: 'sueldo' }])
    const app = await setup({
      model: script(
        ask('this_year', { direction: 'in' }),
        ask('this_month', { direction: null }),
        ask('last_month', { direction: 'out', category: 'salud' }),
        ask('today', { direction: 'in' }),
      ),
    })
    expect(await say(app)).toBe('Este año cobraste $850.000 (1 movimiento).')
    expect(await say(app)).toBe('Este mes cobraste $850.000 (1 movimiento).')
    expect(await say(app)).toBe('No encontré gastos el mes pasado en Salud.')
    expect(await say(app)).toBe('No encontré ingresos hoy.')
    app.close()
  })

  it('counts only the asking account', async () => {
    await seed([{ ...OCT, amount: '1000' }])
    const [other] = await sql`INSERT INTO account (wa_id) VALUES ('5491199999999') RETURNING id`
    const [inbound] =
      await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload) VALUES ('seed.other', '5491199999999', 'text', 'x', '{}'::jsonb) RETURNING id`
    await sql`INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency, occurred_on, description, category, confidence)
      VALUES (${other?.id}, ${inbound?.id}, 0, 'out', 77, 'ARS', '2025-10-03', 'ajeno', 'otros', 'high')`
    const app = await setup({ model: script(ask('this_month')) })
    expect(await say(app)).toBe('Este mes gastaste $1.000 (1 movimiento).')
    app.close()
  })
})

describe('periods in Argentine time', () => {
  // One movement per boundary day, each amount a power of two, so a total names exactly its set.
  const days: [string, string][] = [
    ['2025-12-31', '1'],
    ['2026-01-01', '2'],
    ['2026-10-31', '4'],
    ['2026-11-22', '8'], // Sunday
    ['2026-11-23', '16'], // Monday
    ['2026-11-29', '32'], // Sunday
    ['2026-11-30', '64'], // Monday
    ['2026-12-01', '128'],
    ['2026-12-06', '256'], // Sunday
  ]
  // 23:30 on Nov 30 in Buenos Aires is already Dec 1 in UTC; 00:30 on Dec 1 is the next Argentine day.
  const cases: [string, string, Record<string, string | null>][] = [
    [
      'the last evening of November (02:30 UTC on Dec 1)',
      '2026-12-01T02:30:00Z',
      {
        today: '$64',
        yesterday: '$32',
        this_week: '$448',
        last_week: '$48',
        this_month: '$120',
        last_month: '$4',
        this_year: '$510',
      },
    ],
    [
      'the first night of December (03:30 UTC on Dec 1)',
      '2026-12-01T03:30:00Z',
      {
        today: '$128',
        yesterday: '$64',
        this_week: '$448',
        last_week: '$48',
        this_month: '$384',
        last_month: '$120',
        this_year: '$510',
      },
    ],
  ]

  for (const [label, at, expected] of cases) {
    it(`${label}: every period counts its own days`, async () => {
      await seed(days.map(([on, amount]) => ({ on, amount })))
      const periods = Object.keys(expected) as (keyof typeof expected)[]
      const app = await setup({
        model: script(
          ...periods.map((p) => ask(p as Extract<Command, { type: 'query' }>['period'])),
        ),
      })
      for (const period of periods) {
        const reply = await say(app, { at })
        expect(reply, `${period} ${label}`).toContain(` gastaste ${expected[period]} (`)
      }
      app.close()
    })
  }

  it('the independent SQL sums agree with the literals above', async () => {
    await seed(days.map(([on, amount]) => ({ on, amount })))
    expect(await sum(`occurred_on BETWEEN '2026-11-01' AND '2026-11-30'`)).toBe('120')
    expect(await sum(`occurred_on BETWEEN '2026-11-30' AND '2026-12-06'`)).toBe('448')
    expect(await sum(`occurred_on BETWEEN '2026-01-01' AND '2026-12-31'`)).toBe('510')
  })
})
