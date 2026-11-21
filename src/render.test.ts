import { describe, expect, it } from 'vitest'
import type { Movement, RecentMovement } from './agent'
import { changedFields } from './movement'
import {
  formatMoney,
  renderAsk,
  renderCanned,
  renderCorrection,
  renderDeletion,
  renderLog,
  renderQuery,
  renderUnchanged,
} from './render'

const TODAY = '2026-11-21'

const mv = (o: Partial<Movement> = {}): Movement => ({
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: TODAY,
  description: 'café',
  category: 'restaurantes',
  payment: null,
  confidence: 'high',
  ...o,
})

describe('formatMoney', () => {
  it('groups thousands with dots and shows decimals only when not zero', () => {
    expect(formatMoney('3500', 'ARS')).toBe('$3.500')
    expect(formatMoney('999', 'ARS')).toBe('$999')
    expect(formatMoney('1234.50', 'ARS')).toBe('$1.234,50')
    expect(formatMoney('1234.5', 'ARS')).toBe('$1.234,50')
    expect(formatMoney('1234.05', 'ARS')).toBe('$1.234,05')
    expect(formatMoney('1234.00', 'ARS')).toBe('$1.234')
    expect(formatMoney('1500000', 'ARS')).toBe('$1.500.000')
    expect(formatMoney('03500', 'ARS')).toBe('$3.500')
    expect(formatMoney('0.50', 'ARS')).toBe('$0,50')
    expect(formatMoney('20', 'USD')).toBe('US$ 20')
    expect(formatMoney('1234.5', 'USD')).toBe('US$ 1.234,50')
  })
})

describe('renderLog', () => {
  it('renders one movement with its payment', () => {
    expect(renderLog([mv({ payment: 'Visa' })], TODAY)).toBe('✓ Café $3.500 (Visa)')
  })

  it('shows income with a plus and capitalizes the description', () => {
    const m = mv({ direction: 'in', amount: '850000', description: 'sueldo' })
    expect(renderLog([m], TODAY)).toBe('✓ Sueldo +$850.000')
    expect(renderLog([mv({ currency: 'USD', amount: '20' })], TODAY)).toBe('✓ Café US$ 20')
  })

  it('marks a date that is not today: ayer, then dd/mm', () => {
    expect(renderLog([mv({ date: '2026-11-20' })], TODAY)).toBe('✓ Café $3.500 · ayer')
    expect(renderLog([mv({ date: '2026-11-05' })], TODAY)).toBe('✓ Café $3.500 · 05/11')
    // Across a month boundary, yesterday is still yesterday.
    expect(renderLog([mv({ date: '2026-10-31' })], '2026-11-01')).toBe('✓ Café $3.500 · ayer')
    // A date in another year shows the year, so a wrong year cannot pass for the right day.
    expect(renderLog([mv({ date: '2025-11-05' })], TODAY)).toBe('✓ Café $3.500 · 05/11/25')
    expect(renderLog([mv({ date: '2025-12-31' })], '2026-01-01')).toBe('✓ Café $3.500 · ayer')
  })

  it('marks low confidence last', () => {
    const m = mv({ confidence: 'low', payment: 'Visa', date: '2026-11-20' })
    expect(renderLog([m], TODAY)).toBe('✓ Café $3.500 (Visa) · ayer (?)')
  })

  it('lists several movements, one bullet each', () => {
    const reply = renderLog(
      [
        mv({ payment: 'Visa' }),
        mv({ description: 'súper', amount: '12000' }),
        mv({ description: 'nafta', amount: '20000', date: '2026-11-20', confidence: 'low' }),
      ],
      TODAY,
    )
    expect(reply).toBe(
      '✓ Anoté 3:\n• Café $3.500 (Visa)\n• Súper $12.000\n• Nafta $20.000 · ayer (?)',
    )
  })
})

describe('renderCanned', () => {
  it('answers each kind with canned text', () => {
    expect(renderCanned('off_topic')).toBe('Solo puedo ayudarte con tus gastos e ingresos.')
    expect(renderCanned('smalltalk')).toContain('Mandame un gasto')
    expect(renderCanned('nothing_logged')).toBe('Todavía no tenés movimientos anotados.')
  })

  it('adds the help contact only when one is configured', () => {
    const plain = renderCanned('help')
    expect(plain).not.toContain('persona')
    const withContact = renderCanned('help', { helpContact: 'ayuda@heywarren.app' })
    expect(withContact).toBe(`${plain}\nSi necesitás hablar con una persona: ayuda@heywarren.app`)
  })
})

const row = (o: Partial<RecentMovement> = {}): RecentMovement => ({
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: TODAY,
  description: 'café',
  category: 'restaurantes',
  payment: null,
  ...o,
})

describe('renderCorrection', () => {
  const fix = (before: RecentMovement, after: RecentMovement) =>
    renderCorrection(before, after, changedFields(before, after), TODAY)

  it('shows the new movement and only what changed, as it was', () => {
    expect(fix(row(), row({ amount: '3800' }))).toBe('✓ Corregido: Café $3.800 (antes $3.500)')
    expect(fix(row({ payment: 'efectivo' }), row({ payment: 'crédito amex' }))).toBe(
      '✓ Corregido: Café $3.500 (crédito amex) (antes efectivo)',
    )
    expect(fix(row(), row({ payment: 'débito' }))).toBe(
      '✓ Corregido: Café $3.500 (débito) (antes sin medio de pago)',
    )
  })

  it('spells out a date or category the movement line would not show', () => {
    expect(fix(row({ date: '2026-11-20' }), row({ date: TODAY }))).toBe(
      '✓ Corregido: Café $3.500 · hoy (antes ayer)',
    )
    expect(fix(row(), row({ date: '2026-11-16' }))).toBe(
      '✓ Corregido: Café $3.500 · 16/11 (antes hoy)',
    )
    expect(fix(row(), row({ category: 'entretenimiento' }))).toBe(
      '✓ Corregido: Café $3.500 · Entretenimiento (antes Restaurantes)',
    )
  })

  it('adds the time the movement was logged when it is not the newest', () => {
    const before = row({ time: '10:10' })
    const after = row({ amount: '2500', time: '10:10' })
    expect(renderCorrection(before, after, changedFields(before, after), TODAY, false)).toBe(
      '✓ Corregido: Café $2.500 (antes $3.500) · 10:10',
    )
    expect(renderCorrection(before, after, changedFields(before, after), TODAY, true)).toBe(
      '✓ Corregido: Café $2.500 (antes $3.500)',
    )
  })

  it('lists every changed field, and a changed currency or direction as money', () => {
    expect(fix(row(), row({ amount: '25.5', currency: 'USD', description: 'brunch' }))).toBe(
      '✓ Corregido: Brunch US$ 25,50 (antes $3.500, café)',
    )
    expect(fix(row(), row({ direction: 'in' }))).toBe('✓ Corregido: Café +$3.500 (antes $3.500)')
  })
})

describe('renderUnchanged', () => {
  it('says the movement already is that way', () => {
    expect(renderUnchanged(row({ payment: 'visa' }), TODAY)).toBe(
      'Ya figura así: Café $3.500 (visa)',
    )
  })
})

describe('renderDeletion', () => {
  it('names what was deleted', () => {
    expect(renderDeletion(row(), TODAY)).toBe('✓ Borré: Café $3.500')
    expect(renderDeletion(row({ date: '2026-11-20', payment: 'visa' }), TODAY)).toBe(
      '✓ Borré: Café $3.500 (visa) · ayer',
    )
  })

  it('adds the time it was logged when it is not the newest movement', () => {
    expect(renderDeletion(row({ time: '10:10' }), TODAY, false)).toBe(
      '✓ Borré: Café $3.500 · 10:10',
    )
    expect(renderDeletion(row({ time: '10:10' }), TODAY, true)).toBe('✓ Borré: Café $3.500')
  })
})

describe('renderAsk', () => {
  const opt = (id: number, o: Partial<RecentMovement> = {}) => ({ id, ...row(o) })

  it('numbers the options in the order given and says how to answer', () => {
    const asked = renderAsk(
      'Cuál',
      [
        opt(9),
        opt(7, { description: 'súper', amount: '12000', payment: 'Visa' }),
        opt(5, { date: '2026-11-18' }),
      ],
      'delete',
      TODAY,
    )
    expect(asked).toBe(
      '¿Cuál? 1. Café $3.500 · 2. Súper $12.000 (Visa) · 3. Café $3.500 del 18/11\nRespondé con el número, por ejemplo "el 1".',
    )
  })

  it('adds the time logged to options that would otherwise look alike', () => {
    const asked = renderAsk(
      'Cuál',
      [
        opt(9, { time: '11:52' }),
        opt(7, { time: '10:10' }),
        opt(5, { description: 'súper', time: '09:00' }),
      ],
      'none',
      TODAY,
    )
    expect(asked).toContain('1. Café $3.500 · 11:52 · 2. Café $3.500 · 10:10 · 3. Súper $3.500\n')
    expect(asked).toContain('Respondé con el número y el cambio, por ejemplo "el 1 fue 4100".')
  })

  it('shows one option as it is, and a question alone when there is none', () => {
    expect(renderAsk('Qué querés cambiar', [opt(9, { date: '2026-11-20' })], 'none', TODAY)).toBe(
      '¿Qué querés cambiar? Café $3.500 · ayer',
    )
    expect(renderAsk('Cuál', [], 'none', TODAY)).toBe('¿Cuál?')
  })
})

describe('renderQuery', () => {
  const total = (o: object) => ({
    direction: 'out' as const,
    currency: 'ARS' as const,
    total: '123456',
    count: 12,
    ...o,
  })
  const scope = {
    period: 'this_month' as const,
    direction: 'out' as const,
    category: null,
    payment: null,
  }

  it('answers a filtered total', () => {
    expect(renderQuery({ ...scope, category: 'supermercado' }, [total({})])).toBe(
      'Este mes gastaste $123.456 en Súper (12 movimientos).',
    )
    expect(renderQuery({ ...scope, payment: 'visa' }, [total({ count: 1 })])).toBe(
      'Este mes gastaste $123.456 con visa (1 movimiento).',
    )
  })

  it('puts USD on its own line and never adds it to pesos', () => {
    expect(
      renderQuery(scope, [
        total({ total: '1234.5' }),
        total({ currency: 'USD', total: '50', count: 2 }),
      ]),
    ).toBe('Este mes gastaste $1.234,50 (12 movimientos).\nY US$ 50 (2 movimientos).')
    expect(renderQuery(scope, [total({ currency: 'USD', total: '50', count: 1 })])).toBe(
      'Este mes gastaste US$ 50 (1 movimiento).',
    )
  })

  it('words income, and both directions when none is asked', () => {
    expect(
      renderQuery({ ...scope, period: 'this_year', direction: 'in' }, [
        total({ direction: 'in', total: '1850000', count: 1 }),
      ]),
    ).toBe('Este año cobraste $1.850.000 (1 movimiento).')
    expect(
      renderQuery({ ...scope, period: 'last_week', direction: null }, [
        total({ total: '5000', count: 2 }),
        total({ direction: 'in', total: '9000', count: 1 }),
      ]),
    ).toBe(
      'La semana pasada gastaste $5.000 (2 movimientos).\nLa semana pasada cobraste $9.000 (1 movimiento).',
    )
  })

  it('says so when nothing matches', () => {
    expect(renderQuery({ ...scope, category: 'supermercado' }, [])).toBe(
      'No encontré gastos este mes en Súper.',
    )
    expect(renderQuery({ ...scope, period: 'today', direction: 'in' }, [])).toBe(
      'No encontré ingresos hoy.',
    )
    expect(
      renderQuery({ ...scope, period: 'last_month', direction: null, payment: 'amex' }, []),
    ).toBe('No encontré movimientos el mes pasado con amex.')
  })
})
