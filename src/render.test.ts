import { describe, expect, it } from 'vitest'
import type { Command, Movement } from './parse'
import { formatMoney, renderReply } from './render'

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
const log = (...movements: Movement[]): Command => ({ type: 'log', movements })

describe('formatMoney', () => {
  it('groups thousands with dots and shows decimals only when not zero', () => {
    expect(formatMoney('3500', 'ARS')).toBe('$3.500')
    expect(formatMoney('999', 'ARS')).toBe('$999')
    expect(formatMoney('1234.50', 'ARS')).toBe('$1.234,50')
    expect(formatMoney('1234.5', 'ARS')).toBe('$1.234,50')
    expect(formatMoney('1234.05', 'ARS')).toBe('$1.234,05')
    expect(formatMoney('1234.00', 'ARS')).toBe('$1.234')
    expect(formatMoney('1500000', 'ARS')).toBe('$1.500.000')
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

  it('answers the commands that are not logging with canned text', () => {
    const changes = {
      direction: null,
      amount: '3800',
      currency: null,
      date: null,
      description: null,
      category: null,
      payment: null,
    }
    const notYet = 'Todavía no puedo corregir, borrar ni responder consultas. Llega pronto.'
    const commands: Command[] = [
      { type: 'correct', target: 'el café', changes, confidence: 'high' },
      { type: 'delete', target: 'el último', confidence: 'high' },
      { type: 'query', period: 'today', direction: null, category: null, payment: null },
    ]
    for (const c of commands) expect(renderReply(c, TODAY)).toBe(notYet)
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
