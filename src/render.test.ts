import { describe, expect, it } from 'vitest'
import { changedFields } from './movement'
import type { Movement, RecentMovement } from './parse'
import {
  formatMoney,
  renderCorrection,
  renderDeletion,
  renderQuery,
  renderQuestion,
  renderReply,
  renderUnchanged,
  type SimpleCommand,
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
const log = (...movements: Movement[]): SimpleCommand => ({ type: 'log', movements })

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

describe('renderReply', () => {
  it('renders one movement with its payment', () => {
    expect(renderReply(log(mv({ payment: 'Visa' })), TODAY)).toBe('✓ Café $3.500 (Visa)')
  })

  it('shows income with a plus and capitalizes the description', () => {
    const m = mv({ direction: 'in', amount: '850000', description: 'sueldo' })
    expect(renderReply(log(m), TODAY)).toBe('✓ Sueldo +$850.000')
    expect(renderReply(log(mv({ currency: 'USD', amount: '20' })), TODAY)).toBe('✓ Café US$ 20')
  })

  it('marks a date that is not today: ayer, then dd/mm', () => {
    expect(renderReply(log(mv({ date: '2026-11-20' })), TODAY)).toBe('✓ Café $3.500 · ayer')
    expect(renderReply(log(mv({ date: '2026-11-05' })), TODAY)).toBe('✓ Café $3.500 · 05/11')
    // Across a month boundary, yesterday is still yesterday.
    expect(renderReply(log(mv({ date: '2026-10-31' })), '2026-11-01')).toBe('✓ Café $3.500 · ayer')
    // A date in another year shows the year, so a wrong year cannot pass for the right day.
    expect(renderReply(log(mv({ date: '2025-11-05' })), TODAY)).toBe('✓ Café $3.500 · 05/11/25')
    expect(renderReply(log(mv({ date: '2025-12-31' })), '2026-01-01')).toBe('✓ Café $3.500 · ayer')
  })

  it('marks low confidence last', () => {
    const m = mv({ confidence: 'low', payment: 'Visa', date: '2026-11-20' })
    expect(renderReply(log(m), TODAY)).toBe('✓ Café $3.500 (Visa) · ayer (?)')
  })

  it('lists several movements, one bullet each', () => {
    const reply = renderReply(
      log(
        mv({ payment: 'Visa' }),
        mv({ description: 'súper', amount: '12000' }),
        mv({ description: 'nafta', amount: '20000', date: '2026-11-20', confidence: 'low' }),
      ),
      TODAY,
    )
    expect(reply).toBe(
      '✓ Anoté 3:\n• Café $3.500 (Visa)\n• Súper $12.000\n• Nafta $20.000 · ayer (?)',
    )
  })

  it('answers off_topic with canned text', () => {
    expect(renderReply({ type: 'off_topic' }, TODAY)).toBe(
      'Solo puedo ayudarte con tus gastos e ingresos.',
    )
  })

  it('adds the help contact only when one is configured', () => {
    const plain = renderReply({ type: 'help' }, TODAY)
    expect(plain).not.toContain('persona')
    const withContact = renderReply({ type: 'help' }, TODAY, { helpContact: 'ayuda@heywarren.app' })
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
})

describe('renderQuestion', () => {
  it('lists the candidates with their numbers in the list the parser sees', () => {
    const asked = renderQuestion(
      [
        { number: 1, movement: { id: 1, ...row() } },
        {
          number: 3,
          movement: { id: 3, ...row({ description: 'súper', amount: '12000', payment: 'Visa' }) },
        },
        { number: 4, movement: { id: 4, ...row({ date: '2026-11-18' }) } },
      ],
      TODAY,
    )
    expect(asked).toBe(
      '¿Cuál? 1. Café $3.500 · 3. Súper $12.000 (Visa) · 4. Café $3.500 del 18/11\nRespondé con el número, por ejemplo "el 1 fue 4100" o "borrá el 1".',
    )
  })

  it('says there is nothing to pick when the list is empty', () => {
    expect(renderQuestion([], TODAY)).toBe('Todavía no tenés movimientos anotados.')
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
