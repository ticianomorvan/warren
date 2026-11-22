import { describe, expect, it } from 'vitest'
import {
  correct,
  lastWamid,
  range,
  remove,
  replyCall,
  say,
  script,
  seed,
  summarize,
} from './command-fixtures'
import { row, setup, sql, TODAY, useDatabase } from './test-harness'

useDatabase()

/**
 * Summaries against a ledger that went through the real pipeline: corrections, a delete that stays, a delete
 * that was undone, a correction that moved a movement to another month, two currencies and income. Every figure is
 * checked two ways: a literal worked out by hand, and an aggregation written another way (raw rows, filtered and
 * summed in code in integer cents), never the SQL the product uses. "Today" is Thursday 2025-10-09.
 */
expect(TODAY).toBe('2025-10-09')

type Raw = {
  direction: 'in' | 'out'
  currency: 'ARS' | 'USD'
  amount: string
  on: string
  category: string
  payment: string | null
  superseded_by: number | null
  deleted: boolean
}

/** Every row of the table in any state, and only then the live ones: the rule of the ledger, written out. */
async function liveRows(): Promise<Raw[]> {
  const rows = await sql<Raw[]>`
    SELECT direction, currency, amount::text AS amount, to_char(occurred_on, 'YYYY-MM-DD') AS "on",
      category, payment, superseded_by::int AS superseded_by, deleted_at IS NOT NULL AS deleted
    FROM movement ORDER BY id`
  return rows.filter((r) => r.superseded_by === null && !r.deleted)
}

const cents = (a: string) => {
  const [whole = '0', fraction = ''] = a.split('.')
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
}
/** "$40.800", "$1.234,50", "US$ 50": the Argentine form, written here on its own. */
const money = (c: bigint, currency: 'ARS' | 'USD' = 'ARS') => {
  const whole = String(c / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const cs = c % 100n
  const text = cs === 0n ? whole : `${whole},${String(cs).padStart(2, '0')}`
  return currency === 'USD' ? `US$ ${text}` : `$${text}`
}
const plural = (n: number) => `${n} ${n === 1 ? 'movimiento' : 'movimientos'}`

type Want = {
  from: string
  to: string
  direction?: 'in' | 'out'
  currency?: 'ARS' | 'USD'
  category?: string
}
/** The sum and the count of the live rows that match, from the raw rows. */
async function expected(w: Want) {
  const rows = (await liveRows()).filter(
    (r) =>
      r.on >= w.from &&
      r.on <= w.to &&
      r.direction === (w.direction ?? 'out') &&
      r.currency === (w.currency ?? 'ARS') &&
      (w.category === undefined || r.category === w.category),
  )
  return { total: rows.reduce((s, r) => s + cents(r.amount), 0n), n: rows.length }
}
const line = async (w: Want) => {
  const e = await expected(w)
  return `${money(e.total, w.currency)} (${plural(e.n)})`
}

/** The ledger, then the messages that change it: everything a summary has to leave out or count once. */
async function ledger() {
  const ids = await seed([
    { on: '2024-02-28', amount: '300', description: 'panadería' }, // 1
    { on: '2024-02-29', amount: '700', description: 'panadería' }, // 2: a leap day
    { on: '2024-03-01', amount: '200', description: 'panadería' }, // 3
    { on: '2025-08-31', amount: '900', category: 'supermercado' }, // 4
    { on: '2025-09-01', amount: '10000', category: 'supermercado', payment: 'visa' }, // 5
    { on: '2025-09-15', amount: '2000', category: 'restaurantes', payment: 'efectivo' }, // 6
    { on: '2025-09-20', amount: '500000', direction: 'in', category: 'sueldo' }, // 7
    { on: '2025-09-10', amount: '100', currency: 'USD', category: 'viajes' }, // 8
    { on: '2025-10-01', amount: '12000', category: 'supermercado', payment: 'visa' }, // 9
    { on: '2025-10-04', amount: '4000', category: 'entretenimiento', payment: 'efectivo' }, // 10: Saturday
    { on: '2025-10-03', amount: '600000', direction: 'in', category: 'sueldo' }, // 11
    { on: '2025-10-07', amount: '50', currency: 'USD', category: 'viajes' }, // 12
    {
      on: '2025-10-07',
      amount: '20',
      currency: 'USD',
      direction: 'in',
      category: 'otros_ingresos',
    }, // 13
    { on: '2025-10-09', amount: '6000', category: 'restaurantes', payment: 'débito' }, // 14
    { on: '2025-10-02', amount: '3000', category: 'restaurantes', payment: 'visa' }, // 15: -> 3300
    { on: '2025-10-06', amount: '1500', category: 'transporte', description: 'taxi' }, // 16: deleted, then undone
    { on: '2025-10-05', amount: '8000', category: 'supermercado', payment: 'Visa' }, // 17: -> 9000 (Sunday)
    { on: '2025-10-08', amount: '2500', category: 'restaurantes' }, // 18: deleted for good
    { on: '2025-09-30', amount: '5000', category: 'combustible', payment: 'débito' }, // 19: -> October 1st
  ])
  expect(ids).toEqual(Array.from({ length: 19 }, (_, k) => k + 1))
  return [
    correct(15, { amount: '3300' }),
    remove(16),
    // "deshacer" is answered by code: no turn of the model
    correct(17, { amount: '9000' }),
    remove(18),
    correct(19, { date: '2025-10-01' }),
  ]
}

/** Builds the ledger, runs its messages, and leaves an app whose model plays `then`. */
async function app(...then: Parameters<typeof script>) {
  const steps = await ledger()
  const [c15, d16, c17, d18, c19] = steps
  const turns = [c15, d16, c17, d18, c19].map((s) => s as NonNullable<typeof s>)
  const a = await setup({ model: script(...turns, ...then) })
  await say(a) // 15: 3000 -> 3300
  await say(a) // 16: deleted
  expect(await say(a, { text: 'deshacer' })).toContain('Volvió Taxi $1.500')
  await say(a) // 17: 8000 -> 9000
  await say(a) // 18: deleted
  await say(a) // 19: nafta moved to October 1st
  return a
}

describe('the ledger the summaries read', () => {
  it('after corrections, deletes and an undo, holds exactly what the hand count says', async () => {
    const a = await app()
    const oct = await expected({ from: '2025-10-01', to: '2025-10-31' })
    expect(oct).toEqual({ total: 4080000n, n: 7 }) // 12000 + 5000 + 3300 + 4000 + 9000 + 1500 + 6000
    expect(await expected({ from: '2025-09-01', to: '2025-09-30' })).toEqual({
      total: 1200000n,
      n: 2,
    })
    a.close()
  })
})

describe('a total', () => {
  it('is the independent sum, ARS and USD apart, for the month so far', async () => {
    const a = await app(summarize('this_month'), summarize('this_month', { direction: null }))
    const reply = await say(a, { text: 'cuanto gasté este mes' })
    const w = { from: '2025-10-01', to: '2025-10-09' }
    expect(reply).toBe(
      `Octubre (1–9, en curso) gastaste ${await line(w)}.\nY ${await line({ ...w, currency: 'USD' })}.`,
    )
    expect(reply).toBe(
      'Octubre (1–9, en curso) gastaste $40.800 (7 movimientos).\nY US$ 50 (1 movimiento).',
    )
    expect(await say(a)).toBe(
      [
        'Octubre (1–9, en curso) gastaste $40.800 (7 movimientos).',
        'Y US$ 50 (1 movimiento).',
        'Octubre (1–9, en curso) cobraste $600.000 (1 movimiento).',
        'Y US$ 20 (1 movimiento).',
      ].join('\n'),
    )
    a.close()
  })

  it('answers any month, a year, explicit days and what the weekend held', async () => {
    const a = await app(
      summarize('month', { range: range('month', { month: 9 }) }),
      summarize('month', { range: range('month', { month: 8 }) }),
      summarize('year', { range: range('year', { year: 2025 }), direction: 'in' }),
      summarize('dates', { range: range('dates', { from: '10-02', to: '10-04' }) }),
      summarize('weekend', { range: range('weekend') }),
      summarize('last_week'),
      summarize('this_week'),
    )
    expect(await say(a)).toBe(
      `Septiembre (1–30) gastaste ${await line({ from: '2025-09-01', to: '2025-09-30' })}.\nY ${await line({ from: '2025-09-01', to: '2025-09-30', currency: 'USD' })}.`,
    )
    expect(await say(a)).toBe('Agosto (1–31) gastaste $900 (1 movimiento).')
    expect(await say(a)).toBe(
      `Año 2025 (1 ene–9 oct, en curso) cobraste ${await line({ from: '2025-01-01', to: '2025-10-09', direction: 'in' })}.\nY ${await line({ from: '2025-01-01', to: '2025-10-09', direction: 'in', currency: 'USD' })}.`,
    )
    // the 2nd to the 4th of October: café 3.300 (2nd), the cine 4.000 (Saturday 4th); the sueldo of the 3rd is income
    expect(await say(a)).toBe('Del 2 al 4 oct gastaste $7.300 (2 movimientos).')
    expect(await line({ from: '2025-10-02', to: '2025-10-04' })).toBe('$7.300 (2 movimientos)')
    // Saturday and Sunday: the cine (4.000) and the súper of Sunday (9.000, corrected from 8.000)
    expect(await say(a)).toBe('Fin de semana (4–5 oct) gastaste $13.000 (2 movimientos).')
    expect(await line({ from: '2025-10-04', to: '2025-10-05' })).toBe('$13.000 (2 movimientos)')
    // last week: Mon 29 Sep to Sun 5 Oct: nafta (moved to the 1st), súper, café, cine, súper = 33.300; and the 30th of Sept has nothing now
    expect(await say(a)).toBe('Semana pasada (29 sep–5 oct) gastaste $33.300 (5 movimientos).')
    expect(await line({ from: '2025-09-29', to: '2025-10-05' })).toBe('$33.300 (5 movimientos)')
    // this week: the taxi (restored) on Monday and the almuerzo today; the café of the 8th was deleted
    expect(await say(a)).toBe(
      'Esta semana (6–9 oct, en curso) gastaste $7.500 (2 movimientos).\nY US$ 50 (1 movimiento).',
    )
    a.close()
  })

  it('counts the nafta that was corrected from the 30th of September into October, and not in September', async () => {
    const a = await app(
      summarize('month', { range: range('month', { month: 9 }), category: 'combustible' }),
      summarize('this_month', { category: 'combustible' }),
    )
    expect(await say(a)).toBe('Septiembre (1–30): no encontré gastos en Combustible.')
    expect(await say(a)).toBe(
      'Octubre (1–9, en curso) gastaste $5.000 en Combustible (1 movimiento).',
    )
    a.close()
  })

  it('an empty range says so, with the days it looked at', async () => {
    const a = await app(
      summarize('month', { range: range('month', { month: 12, year: 2024 }) }),
      summarize('month', { range: range('month', { month: 12, year: 2024 }), direction: 'in' }),
    )
    expect(await say(a)).toBe('Diciembre 2024 (1–31): no encontré gastos.')
    expect(await say(a)).toBe('Diciembre 2024 (1–31): no encontré ingresos.')
    a.close()
  })
})

describe('Argentine midnight and month boundaries', () => {
  it('23:59 on the 30th is still September, and one minute later the 1st of October', async () => {
    const a = await app(summarize('this_month'), summarize('this_month'), summarize('today'))
    // 02:59 UTC on Oct 1 = 23:59 on Sep 30 in Buenos Aires
    expect(await say(a, { at: '2025-10-01T02:59:00Z' })).toBe(
      `Septiembre (1–30) gastaste ${await line({ from: '2025-09-01', to: '2025-09-30' })}.\nY ${await line({ from: '2025-09-01', to: '2025-09-30', currency: 'USD' })}.`,
    )
    expect(await say(a, { at: '2025-10-01T03:00:00Z' })).toBe(
      `Octubre (1–1, en curso) gastaste ${await line({ from: '2025-10-01', to: '2025-10-01' })}.`,
    )
    expect(await say(a, { at: '2025-10-01T03:00:00Z' })).toBe(
      'Hoy (1 oct) gastaste $17.000 (2 movimientos).',
    ) // the súper and the nafta moved here
    a.close()
  })

  it('a month and the one after it split at the boundary, nothing counted twice', async () => {
    const a = await app(
      summarize('month', { range: range('month', { month: 9 }) }),
      summarize('month', { range: range('month', { month: 10 }) }),
    )
    const sept = await expected({ from: '2025-09-01', to: '2025-09-30' })
    const oct = await expected({ from: '2025-10-01', to: '2025-10-31' })
    const both = await expected({ from: '2025-09-01', to: '2025-10-31' })
    expect(sept.total + oct.total).toBe(both.total)
    expect(sept.n + oct.n).toBe(both.n)
    expect(await say(a)).toContain(`gastaste ${money(sept.total)} (${plural(sept.n)})`)
    expect(await say(a)).toContain(`gastaste ${money(oct.total)} (${plural(oct.n)})`)
    a.close()
  })

  it('the leap day is a day of its own, and a leap February has its 29th', async () => {
    const a = await app(
      summarize('dates', { range: range('dates', { from: '02-29' }) }),
      summarize('month', { range: range('month', { month: 2, year: 2024 }) }),
      summarize('dates', { range: range('dates', { from: '2024-02-29' }), compare_to: 'previous' }),
    )
    expect(await say(a)).toBe('El 29 feb 2024 gastaste $700 (1 movimiento).')
    expect(await say(a)).toBe('Febrero 2024 (1–29) gastaste $1.000 (2 movimientos).')
    expect(await say(a)).toBe(
      [
        'El 29 feb 2024 gastaste $700 (1 movimiento).',
        'El 28 feb 2024 gastaste $300 (1 movimiento).',
        'Diferencia: $400 más (+133,3%).', // 400 / 300 = 133,33...
      ].join('\n'),
    )
    a.close()
  })
})

describe('a comparison is two sums and code does the rest', () => {
  it('this month so far against the same days of the one before: both totals, the difference and the percentage, per currency', async () => {
    const a = await app(
      summarize('this_month', { compare_to: 'previous' }),
      summarize('last_month', { compare_to: 'previous' }),
    )
    const reply = await say(a, { text: 'gasté más que el mes pasado?' })
    // 1–9 October against 1–9 September, not against all of September
    const now = await expected({ from: '2025-10-01', to: '2025-10-09' })
    const before = await expected({ from: '2025-09-01', to: '2025-09-09' })
    expect(before).toEqual({ total: 1000000n, n: 1 }) // only the súper of the 1st: the café of the 15th and the USD of the 10th are later
    const delta = now.total - before.total
    const pct = (Number(delta) / Number(before.total)) * 100 // 30800 / 10000: 308, no tie
    expect(Number.isInteger(pct)).toBe(true)
    expect(reply).toBe(
      [
        `Octubre (1–9, en curso) gastaste ${money(now.total)} (${plural(now.n)}).`,
        `Septiembre (1–9) gastaste ${money(before.total)} (${plural(before.n)}).`,
        `Diferencia: ${money(delta)} más (+${pct}%).`,
        'Octubre (1–9, en curso) gastaste US$ 50 (1 movimiento).',
        'Septiembre (1–9): no hay gastos.',
        'No hay gastos en Septiembre (1–9) para comparar.',
      ].join('\n'),
    )
    expect(reply).toContain('Diferencia: $30.800 más (+308%).')
    // a month that is over is compared whole: September against August
    expect(await say(a)).toBe(
      [
        'Septiembre (1–30) gastaste $12.000 (2 movimientos).',
        'Agosto (1–31) gastaste $900 (1 movimiento).',
        'Diferencia: $11.100 más (+1233,3%).', // 11.100 / 900
        'Septiembre (1–30) gastaste US$ 100 (1 movimiento).',
        'Agosto (1–31): no hay gastos.',
        'No hay gastos en Agosto (1–31) para comparar.',
      ].join('\n'),
    )
    a.close()
  })

  it('"noviembre vs octubre" style: a second range the person named, and a filter that applies to both', async () => {
    const a = await app(
      summarize('this_month', {
        category: 'supermercado',
        compare_to: 'range',
        other: 'month:9',
      }),
    )
    // súper: October 12.000 + 9.000 = 21.000 against September 10.000: 11.000 more, 110%
    expect(await say(a, { text: 'cuánto más en súper que en septiembre' })).toBe(
      [
        'Octubre (1–9, en curso) gastaste $21.000 en Súper (2 movimientos).',
        'Septiembre (1–30) gastaste $10.000 en Súper (1 movimiento).',
        'Diferencia: $11.000 más (+110%).',
      ].join('\n'),
    )
    expect(await line({ from: '2025-10-01', to: '2025-10-09', category: 'supermercado' })).toBe(
      '$21.000 (2 movimientos)',
    )
    expect(await line({ from: '2025-09-01', to: '2025-09-30', category: 'supermercado' })).toBe(
      '$10.000 (1 movimiento)',
    )
    a.close()
  })

  it('income compares like spending', async () => {
    const a = await app(
      summarize('this_month', { direction: 'in', compare_to: 'range', other: 'last_month' }),
    )
    expect(await say(a)).toBe(
      [
        'Octubre (1–9, en curso) cobraste $600.000 (1 movimiento).',
        'Septiembre (1–30) cobraste $500.000 (1 movimiento).',
        'Diferencia: $100.000 más (+20%).',
        'Octubre (1–9, en curso) cobraste US$ 20 (1 movimiento).',
        'Septiembre (1–30): no hay ingresos.',
        'No hay ingresos en Septiembre (1–30) para comparar.',
      ].join('\n'),
    )
    a.close()
  })

  it('never divides by zero: a period with nothing before it is said, not computed', async () => {
    const a = await app(
      summarize('this_month', {
        compare_to: 'range',
        other: 'month:12:2024',
      }),
      summarize('month', {
        range: range('month', { month: 12, year: 2024 }),
        compare_to: 'range',
        other: 'this_month',
      }),
      summarize('month', {
        range: range('month', { month: 12, year: 2024 }),
        compare_to: 'range',
        other: 'month:11:2024',
      }),
    )
    expect(await say(a)).toBe(
      [
        'Octubre (1–9, en curso) gastaste $40.800 (7 movimientos).',
        'Diciembre 2024 (1–31): no hay gastos.',
        'No hay gastos en Diciembre 2024 (1–31) para comparar.',
        'Octubre (1–9, en curso) gastaste US$ 50 (1 movimiento).',
        'Diciembre 2024 (1–31): no hay gastos.',
        'No hay gastos en Diciembre 2024 (1–31) para comparar.',
      ].join('\n'),
    )
    // the reverse: something before and nothing now is a 100% drop, which is a real number
    expect(await say(a)).toContain('Diferencia: $40.800 menos (-100%).')
    expect(await say(a)).toBe(
      'No encontré gastos en Diciembre 2024 (1–31) ni en Noviembre 2024 (1–30).',
    )
    a.close()
  })

  it('a leap February against the January before it, and a year against the year before', async () => {
    const a = await app(
      summarize('month', {
        range: range('month', { month: 3, year: 2024 }),
        compare_to: 'previous',
      }),
      summarize('year', { range: range('year', { year: 2025 }), compare_to: 'previous' }),
    )
    // March 2024: 200. February 2024 (29 days, 1.000) is the month before: 800 less, -80%
    expect(await say(a)).toBe(
      [
        'Marzo 2024 (1–31) gastaste $200 (1 movimiento).',
        'Febrero 2024 (1–29) gastaste $1.000 (2 movimientos).',
        'Diferencia: $800 menos (-80%).',
      ].join('\n'),
    )
    const y25 = await expected({ from: '2025-01-01', to: '2025-12-31' })
    expect(await say(a)).toContain(`Año 2025 (1 ene–9 oct, en curso) gastaste ${money(y25.total)}`)
    a.close()
  })

  it('by category and by payment, the groups of the two ranges side by side', async () => {
    const a = await app(
      summarize('this_month', { group_by: 'category', compare_to: 'previous', direction: 'out' }),
    )
    expect(await say(a)).toBe(
      [
        'Octubre (1–9, en curso) gastaste $40.800 (7 movimientos).',
        'Septiembre (1–9) gastaste $10.000 (1 movimiento).',
        'Diferencia: $30.800 más (+308%).',
        'Por categoría:',
        '• Súper $21.000 vs $10.000 (+110%)',
        '• Restaurantes $9.300 vs $0',
        '• Combustible $5.000 vs $0',
        '• Entretenimiento $4.000 vs $0',
        '• Transporte $1.500 vs $0',
        'Octubre (1–9, en curso) gastaste US$ 50 (1 movimiento).',
        'Septiembre (1–9): no hay gastos.',
        'No hay gastos en Septiembre (1–9) para comparar.',
        'Por categoría:',
        '• Viajes US$ 50 vs US$ 0',
      ].join('\n'),
    )
    a.close()
  })
})

describe('a period in progress is compared with the same stretch of the one before', () => {
  const seedMarch = () =>
    seed([
      { on: '2025-03-30', amount: '120' },
      { on: '2025-03-31', amount: '999' }, // a day later than the stretch: left out
      { on: '2025-12-01', amount: '777' }, // later in the year: left out
      { on: '2026-02-01', amount: '100' },
      { on: '2026-02-28', amount: '200' },
      { on: '2026-03-01', amount: '50' },
      { on: '2026-03-05', amount: '300' },
      { on: '2026-03-17', amount: '20' }, // Tuesday of the week before
      { on: '2026-03-19', amount: '500' }, // Thursday of the week before: after the stretch
      { on: '2026-03-24', amount: '10' }, // Tuesday of the week asked about
      { on: '2026-03-30', amount: '1000' },
      { on: '2026-03-31', amount: '400' },
    ])

  it('a month: 1–30 March against 1–28 February, and the whole of March against the whole of February on the 31st', async () => {
    await seedMarch()
    const a = await setup({
      model: script(
        summarize('this_month', { compare_to: 'previous' }),
        summarize('this_month', { compare_to: 'previous' }),
      ),
    })
    // every March movement up to the 30th: 50 + 300 + 20 + 500 + 10 + 1.000, against 100 + 200 of February
    const march30 = await expected({ from: '2026-03-01', to: '2026-03-30' })
    expect(march30).toEqual({ total: 188000n, n: 6 })
    expect(await say(a, { at: '2026-03-30T15:00:00Z' })).toBe(
      [
        'Marzo (1–30, en curso) gastaste $1.880 (6 movimientos).',
        'Febrero (1–28) gastaste $300 (2 movimientos).',
        'Diferencia: $1.580 más (+526,7%).', // 1.580 / 300
      ].join('\n'),
    )
    const march31 = await expected({ from: '2026-03-01', to: '2026-03-31' })
    expect(await say(a, { at: '2026-03-31T15:00:00Z' })).toContain(
      `Marzo (1–31) gastaste ${money(march31.total)} (${plural(march31.n)}).\nFebrero (1–28) gastaste $300 (2 movimientos).`,
    )
    a.close()
  })

  it('the year so far against the same days of last year, and a week so far against the same weekdays', async () => {
    await seedMarch()
    const a = await setup({
      model: script(
        summarize('this_year', { compare_to: 'previous' }),
        summarize('this_week', { compare_to: 'previous' }),
      ),
    })
    const now = await expected({ from: '2026-01-01', to: '2026-03-30' })
    const before = await expected({ from: '2025-01-01', to: '2025-03-30' })
    expect([now, before]).toEqual([
      { total: 218000n, n: 8 },
      { total: 12000n, n: 1 },
    ])
    expect(await say(a, { at: '2026-03-30T15:00:00Z' })).toBe(
      [
        'Año 2026 (1 ene–30 mar, en curso) gastaste $2.180 (8 movimientos).',
        'Año 2025 (1 ene–30 mar 2025) gastaste $120 (1 movimiento).',
        'Diferencia: $2.060 más (+1716,7%).', // 2.060 / 120
      ].join('\n'),
    )
    // Wednesday 25 March: Monday to Wednesday against Monday to Wednesday of the week before (the 500 of Thursday is not in it)
    expect(await say(a, { at: '2026-03-25T15:00:00Z' })).toBe(
      [
        'Esta semana (23–25 mar, en curso) gastaste $10 (1 movimiento).',
        'Semana pasada (16–18 mar) gastaste $20 (1 movimiento).',
        'Diferencia: $10 menos (-50%).',
      ].join('\n'),
    )
    a.close()
  })
})

describe('groups', () => {
  it('by category: biggest first, each the independent sum, the currencies in their own lists', async () => {
    const a = await app(summarize('this_month', { group_by: 'category' }))
    const reply = await say(a, { text: 'en qué gasté más este mes' })
    const w = { from: '2025-10-01', to: '2025-10-09' }
    for (const [label, category] of [
      ['Súper', 'supermercado'],
      ['Restaurantes', 'restaurantes'],
      ['Combustible', 'combustible'],
      ['Entretenimiento', 'entretenimiento'],
      ['Transporte', 'transporte'],
    ] as const) {
      expect(reply).toContain(`• ${label} ${await line({ ...w, category })}`)
    }
    expect(reply.split('\n').slice(0, 7)).toEqual([
      'Octubre (1–9, en curso) gastaste $40.800 (7 movimientos).',
      'Por categoría:',
      '• Súper $21.000 (2 movimientos)',
      '• Restaurantes $9.300 (2 movimientos)',
      '• Combustible $5.000 (1 movimiento)',
      '• Entretenimiento $4.000 (1 movimiento)',
      '• Transporte $1.500 (1 movimiento)',
    ])
    expect(reply.split('\n').slice(7)).toEqual([
      'Y US$ 50 (1 movimiento).',
      'Por categoría:',
      '• Viajes US$ 50 (1 movimiento)',
    ])
    a.close()
  })

  it('by payment: the same card written two ways is one group, and no payment is its own', async () => {
    const a = await app(summarize('this_month', { group_by: 'payment', direction: 'out' }))
    const reply = await say(a)
    // visa 12.000 + Visa 9.000 + visa 3.300; débito 6.000 + 5.000; efectivo 4.000; the taxi has none
    expect(reply.split('\n').slice(0, 6)).toEqual([
      'Octubre (1–9, en curso) gastaste $40.800 (7 movimientos).',
      'Por medio de pago:',
      '• Visa $24.300 (3 movimientos)',
      '• Débito $11.000 (2 movimientos)',
      '• Efectivo $4.000 (1 movimiento)',
      '• Sin medio de pago $1.500 (1 movimiento)',
    ])
    a.close()
  })

  it('by day, week and month: in time order, only the days that have movements', async () => {
    const a = await app(
      summarize('this_week', { group_by: 'day' }),
      summarize('this_month', { group_by: 'week' }),
      summarize('this_year', { group_by: 'month' }),
    )
    expect((await say(a)).split('\n').slice(0, 4)).toEqual([
      'Esta semana (6–9 oct, en curso) gastaste $7.500 (2 movimientos).',
      'Por día:',
      '• lun 06/10 $1.500 (1 movimiento)',
      '• jue 09/10 $6.000 (1 movimiento)',
    ])
    expect((await say(a)).split('\n').slice(0, 5)).toEqual([
      'Octubre (1–9, en curso) gastaste $40.800 (7 movimientos).',
      'Por semana:',
      '• Semana del 29/09 $33.300 (5 movimientos)', // the Monday of the week of the 1st
      '• Semana del 06/10 $7.500 (2 movimientos)',
      'Y US$ 50 (1 movimiento).',
    ])
    expect((await say(a)).split('\n').slice(0, 5)).toEqual([
      expect.stringContaining('Año 2025'),
      'Por mes:',
      '• Agosto $900 (1 movimiento)',
      '• Septiembre $12.000 (2 movimientos)',
      '• Octubre $40.800 (7 movimientos)',
    ])
    a.close()
  })

  it('a long list is cut: the biggest groups then how many more, the newest days then how many before', async () => {
    const categories = [
      'supermercado',
      'restaurantes',
      'transporte',
      'combustible',
      'vivienda',
      'servicios',
      'salud',
      'educacion',
      'entretenimiento',
      'ropa',
    ] as const
    // ten categories on one day, amounts 1.000 to 10.000: eight are listed, two are counted
    await seed(
      categories.map((category, k) => ({
        on: '2025-06-10',
        amount: String(1000 * (k + 1)),
        category,
      })),
    )
    // and a movement on each of 45 days (1 May to 14 June)
    await seed(
      Array.from({ length: 45 }, (_, k) => ({
        on: new Date(Date.UTC(2025, 4, 1 + k)).toISOString().slice(0, 10),
        amount: '100',
        description: 'chico',
      })),
    )
    const a = await setup({
      model: script(
        summarize('dates', {
          range: range('dates', { from: '2025-06-10' }),
          group_by: 'category',
        }),
        summarize('dates', {
          range: range('dates', { from: '2025-05-01', to: '2025-06-14' }),
          group_by: 'day',
        }),
      ),
    })
    const groups = (await say(a)).split('\n')
    expect(groups).toHaveLength(2 + 8 + 1) // the total, the title, 8 groups, "y 3 más": 11 categories (the 45th day too)
    expect(groups.slice(2, 4)).toEqual([
      '• Ropa $10.000 (1 movimiento)',
      '• Entretenimiento $9.000 (1 movimiento)',
    ])
    expect(groups.at(-1)).toBe('… y 3 más') // eleven groups: the ten and the 100 of "otros", eight shown
    const days = (await say(a)).split('\n')
    expect(days).toHaveLength(2 + 1 + 31) // the total, the title, "y 14 anteriores" and 31 days
    expect(days[2]).toBe('… y 14 anteriores')
    expect(days[3]).toBe('• jue 15/05 $100 (1 movimiento)')
    expect(days.at(-1)).toBe('• sáb 14/06 $100 (1 movimiento)')
    a.close()
  })
})

describe('what is refused is told to the model, with the reason', () => {
  const seenBy = (a: Awaited<ReturnType<typeof setup>>) =>
    JSON.stringify(a.requests.at(-1)?.messages.at(-1))

  it('a range that has not happened', async () => {
    const a = await app(
      summarize('month', { range: range('month', { month: 12, year: 2025 }) }),
      replyCall('Eso todavía no pasó.'),
    )
    expect(await say(a, { text: 'cuánto gasté en diciembre de 2025' })).toBe('Eso todavía no pasó.')
    expect(seenBy(a)).toContain('has not started yet: today is 2025-10-09')
    expect((await row(lastWamid))?.model_turns).toBe(2)
    a.close()
  })

  it('a reversed range', async () => {
    const a = await app(
      summarize('dates', { range: range('dates', { from: '2025-10-08', to: '2025-10-02' }) }),
      replyCall('Las fechas están al revés, ¿cuál es el rango?'),
    )
    await say(a)
    expect(seenBy(a)).toContain('is reversed: it starts on 2025-10-08 and ends on 2025-10-02')
    a.close()
  })

  it('a range of more than two years, and a comparison grouped by time', async () => {
    const a = await app(
      summarize('dates', { range: range('dates', { from: '2020-01-01', to: '2025-10-01' }) }),
      replyCall('Es mucho tiempo, ¿lo acotamos?'),
      summarize('this_month', { compare_to: 'previous', group_by: 'day' }),
      replyCall('No puedo comparar día por día.'),
      summarize('this_month', { other: 'last_month' }),
      replyCall('Dime qué comparar.'),
      summarize('this_month', { compare_to: 'range' }),
      replyCall('¿Con qué lo comparo?'),
      summarize('this_month', { compare_to: 'range', other: 'octubre' }),
      replyCall('¿Con qué mes?'),
      summarize('this_month', { compare_to: 'range', other: 'month:12:2026' }),
      replyCall('Ese mes no llegó.'),
    )
    await say(a)
    expect(seenBy(a)).toContain('the most is 731')
    await say(a)
    expect(seenBy(a)).toContain('cannot be grouped by day')
    await say(a)
    expect(seenBy(a)).toContain('other is only for compare_to \\"range\\"')
    await say(a)
    expect(seenBy(a)).toContain('needs other: the second range to compare with')
    await say(a)
    expect(seenBy(a)).toContain('other \\"octubre\\" is not understood')
    await say(a)
    expect(seenBy(a)).toContain('other: The month 2026-12 has not started yet')
    a.close()
  })

  it('a stray field is a misread question, and nothing is run', async () => {
    const a = await app(
      summarize('this_month', { range: range('this_month', { month: 10 }) }),
      replyCall('Perdón, ¿qué mes?'),
    )
    await say(a)
    expect(seenBy(a)).toContain('takes no month')
    a.close()
  })
})

describe('the record', () => {
  it('keeps the days that were summed in the audit of the message', async () => {
    const a = await app(summarize('this_month', { compare_to: 'previous', group_by: 'category' }))
    await say(a)
    const stored = await row(lastWamid)
    expect(((stored?.tool_calls ?? []) as { detail?: string }[])[0]?.detail).toBe(
      '2025-10-01..2025-10-09 vs 2025-09-01..2025-09-09 by category',
    )
    expect(stored?.action).toBe('summarize')
    a.close()
  })

  it('writes nothing: a summary leaves every row as it was', async () => {
    const a = await app(summarize('this_month', { group_by: 'category', compare_to: 'previous' }))
    const before = await sql`SELECT count(*)::int AS n, max(id)::int AS top FROM movement`
    await say(a)
    expect(await sql`SELECT count(*)::int AS n, max(id)::int AS top FROM movement`).toEqual(before)
    a.close()
  })
})
