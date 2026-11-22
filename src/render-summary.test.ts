import { describe, expect, it } from 'vitest'
import type { GroupTotal, QueryTotal } from './ledger'
import type { Resolved } from './range'
import { fitReply } from './render'
import { renderSummary as lines, MAX_GROUPS, rangeLabel, spanText } from './render-summary'

/** The reply as one text: each direction and currency is a line of its own. */
const renderSummary = (...a: Parameters<typeof lines>) => lines(...a).join('\n')

const NOW = '2026-11-21' // a Saturday
const day = (from: string, to = from, o: Partial<Resolved> = {}): Resolved => ({
  from,
  to,
  kind: 'custom',
  partial: false,
  ...o,
})

describe('rangeLabel: the days in words', () => {
  const table: [string, Resolved, string][] = [
    ['today', day(NOW, NOW, { kind: 'day' }), 'Hoy (21 nov)'],
    ['yesterday', day('2026-11-20', '2026-11-20', { kind: 'day' }), 'Ayer (20 nov)'],
    ['another day', day('2026-11-05', '2026-11-05', { kind: 'day' }), 'El 5 nov'],
    [
      'this week',
      day('2026-11-16', NOW, { kind: 'week', partial: true }),
      'Esta semana (16–21 nov, en curso)',
    ],
    ['last week', day('2026-11-09', '2026-11-15', { kind: 'week' }), 'Semana pasada (9–15 nov)'],
    ['an older week', day('2026-10-26', '2026-11-01', { kind: 'week' }), 'Semana (26 oct–1 nov)'],
    [
      'a weekend',
      day('2026-11-14', '2026-11-15', { kind: 'weekend' }),
      'Fin de semana (14–15 nov)',
    ],
    [
      'this month',
      day('2026-11-01', NOW, { kind: 'month', partial: true }),
      'Noviembre (1–21, en curso)',
    ],
    ['a whole month', day('2026-10-01', '2026-10-31', { kind: 'month' }), 'Octubre (1–31)'],
    [
      'a month of last year',
      day('2025-10-01', '2025-10-31', { kind: 'month' }),
      'Octubre 2025 (1–31)',
    ],
    [
      'the year so far',
      day('2026-01-01', NOW, { kind: 'year', partial: true }),
      'Año 2026 (1 ene–21 nov, en curso)',
    ],
    [
      'last year',
      day('2025-01-01', '2025-12-31', { kind: 'year' }),
      'Año 2025 (1 ene–31 dic 2025)',
    ],
    ['days in a month', day('2026-11-01', '2026-11-15'), 'Del 1 al 15 nov'],
    ['days across months', day('2026-10-28', '2026-11-03'), 'Del 28 oct al 3 nov'],
    ['days across years', day('2025-12-28', '2026-01-03'), 'Del 28 dic 2025 al 3 ene 2026'],
    ['one day of another year', day('2024-02-29', '2024-02-29', { kind: 'day' }), 'El 29 feb 2024'],
  ]
  for (const [name, range, label] of table) {
    it(name, () => expect(rangeLabel(range, NOW)).toBe(label))
  }

  it('spans show the year only when a day is not of the current one', () => {
    expect(spanText('2026-11-09', '2026-11-15', NOW)).toBe('9–15 nov')
    expect(spanText('2025-11-09', '2025-11-15', NOW)).toBe('9–15 nov 2025')
    expect(spanText('2025-12-30', '2026-01-02', NOW)).toBe('30 dic 2025–2 ene 2026')
  })
})

const total = (
  direction: 'in' | 'out',
  currency: 'ARS' | 'USD',
  amount: string,
  count: number,
): QueryTotal => ({
  direction,
  currency,
  total: amount,
  count,
})
const group = (
  key: string,
  amount: string,
  count: number,
  o: Partial<GroupTotal> = {},
): GroupTotal => ({
  direction: 'out',
  currency: 'ARS',
  key,
  label: null,
  total: amount,
  count,
  ...o,
})
const scope = {
  direction: null,
  category: null,
  payment: null,
  description: null,
  groupBy: 'none' as const,
}
const october = day('2026-10-01', '2026-10-31', { kind: 'month' })
const november = day('2026-11-01', NOW, { kind: 'month', partial: true })

describe('renderSummary', () => {
  it('keeps directions and currencies in blocks of their own, out before in, ARS before USD', () => {
    const side = {
      range: october,
      totals: [
        total('in', 'ARS', '600000', 1),
        total('out', 'USD', '50', 1),
        total('out', 'ARS', '40800.50', 7),
      ],
      groups: [],
    }
    expect(renderSummary(scope, NOW, side, null)).toBe(
      [
        'Octubre (1–31) gastaste $40.800,50 (7 movimientos).',
        'Y US$ 50 (1 movimiento).',
        'Octubre (1–31) cobraste $600.000 (1 movimiento).',
      ].join('\n'),
    )
  })

  it('says what it looked for when nothing is there', () => {
    const empty = { range: october, totals: [], groups: [] }
    expect(
      renderSummary(
        { ...scope, direction: 'out', category: 'supermercado', description: 'Café' },
        NOW,
        empty,
        null,
      ),
    ).toBe('Octubre (1–31): no encontré gastos en Súper, café.')
    expect(renderSummary({ ...scope, direction: 'in', payment: 'visa' }, NOW, empty, null)).toBe(
      'Octubre (1–31): no encontré ingresos con visa.',
    )
    expect(renderSummary(scope, NOW, empty, { range: november, totals: [], groups: [] })).toBe(
      'No encontré movimientos en Octubre (1–31) ni en Noviembre (1–21, en curso).',
    )
  })

  it('compares two ranges with the difference by code, and says when there is nothing to compare with', () => {
    const now = { range: november, totals: [total('out', 'ARS', '120000', 14)], groups: [] }
    const before = { range: october, totals: [total('out', 'ARS', '100000', 20)], groups: [] }
    expect(renderSummary({ ...scope, direction: 'out' }, NOW, now, before)).toBe(
      [
        'Noviembre (1–21, en curso) gastaste $120.000 (14 movimientos).',
        'Octubre (1–31) gastaste $100.000 (20 movimientos).',
        'Diferencia: $20.000 más (+20%).',
      ].join('\n'),
    )
    expect(renderSummary({ ...scope, direction: 'out' }, NOW, before, now)).toContain(
      'Diferencia: $20.000 menos (-16,7%).',
    )
    expect(
      renderSummary({ ...scope, direction: 'out' }, NOW, now, {
        range: october,
        totals: [],
        groups: [],
      }),
    ).toBe(
      [
        'Noviembre (1–21, en curso) gastaste $120.000 (14 movimientos).',
        'Octubre (1–31): no hay gastos.',
        'No hay gastos en Octubre (1–31) para comparar.',
      ].join('\n'),
    )
    expect(
      renderSummary({ ...scope, direction: 'out' }, NOW, now, {
        range: october,
        totals: [total('out', 'ARS', '120000', 3)],
        groups: [],
      }),
    ).toContain('Diferencia: ninguna.')
  })

  it('lists the biggest groups and counts the rest', () => {
    const groups = Array.from({ length: MAX_GROUPS + 3 }, (_, k) =>
      group(
        [
          'supermercado',
          'restaurantes',
          'transporte',
          'combustible',
          'vivienda',
          'servicios',
          'salud',
          'educacion',
          'ropa',
          'regalos',
          'otros',
        ][k] ?? '',
        String(1000 * (11 - k)),
        1,
      ),
    )
    const side = { range: october, totals: [total('out', 'ARS', '66000', 11)], groups }
    const lines = renderSummary({ ...scope, groupBy: 'category' }, NOW, side, null).split('\n')
    expect(lines).toHaveLength(2 + MAX_GROUPS + 1)
    expect(lines[1]).toBe('Por categoría:')
    expect(lines[2]).toBe('• Súper $11.000 (1 movimiento)')
    expect(lines.at(-1)).toBe('… y 3 más')
  })

  it('a group that only one of the two ranges has is shown against $0', () => {
    const now = {
      range: november,
      totals: [total('out', 'ARS', '300', 2)],
      groups: [group('supermercado', '300', 2)],
    }
    const before = {
      range: october,
      totals: [total('out', 'ARS', '400', 2)],
      groups: [group('supermercado', '100', 1), group('ropa', '300', 1)],
    }
    expect(
      renderSummary({ ...scope, direction: 'out', groupBy: 'category' }, NOW, now, before)
        .split('\n')
        .slice(3),
    ).toEqual(['Por categoría:', '• Súper $300 vs $100 (+200%)', '• Ropa $0 vs $300 (-100%)'])
  })
})

describe('a summary that is too long for one message (review of slice D)', () => {
  it('is cut list by list, and each "… y N más" counts what its own list lost', () => {
    const pairs = [
      ['out', 'ARS'],
      ['out', 'USD'],
      ['in', 'ARS'],
      ['in', 'USD'],
    ] as const
    const days = Array.from({ length: 31 }, (_, k) => `2026-10-${String(k + 1).padStart(2, '0')}`)
    const side = {
      range: day('2026-10-01', '2026-10-31', { kind: 'month' }),
      totals: pairs.map(([direction, currency]) => total(direction, currency, '31000', 31)),
      groups: pairs.flatMap(([direction, currency]) =>
        days.map((key) => group(key, '1000', 1, { direction, currency })),
      ),
    }
    const blocks = lines({ ...scope, groupBy: 'day' }, NOW, side, null)
    expect(blocks).toHaveLength(4)
    expect(blocks.join('\n').length).toBeGreaterThan(4000)
    const reply = fitReply({ lines: blocks, notes: [] }).split('\n')
    expect(reply.join('\n').length).toBeLessThanOrEqual(4000)
    // split the reply back into its four lists by their header line
    const headers = reply.flatMap((row, k) =>
      / (gastaste|cobraste) |^Y US\$/.test(row) ? [k] : [],
    )
    expect(headers).toHaveLength(4)
    headers.forEach((start, k) => {
      const list = reply.slice(start, headers[k + 1] ?? reply.length)
      const shown = list.filter((row) => /^• (lun|mar|mié|jue|vie|sáb|dom) /.test(row)).length
      const more = list.find((row) => /^• … y \d+ más$/.test(row))
      expect(shown, `list ${k}`).toBeGreaterThan(0)
      expect(shown + Number(more?.match(/\d+/)?.[0] ?? 0), `list ${k}`).toBe(31)
    })
  })
})
