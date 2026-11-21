import { describe, expect, it } from 'vitest'
import { renderVolatile, SYSTEM_PROMPT } from './prompt'

describe('SYSTEM_PROMPT', () => {
  it('is frozen: it carries no date and nothing per request', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
    expect(SYSTEM_PROMPT).toContain('3.500')
    expect(SYSTEM_PROMPT).toContain('lucas')
    expect(SYSTEM_PROMPT).toContain('palo')
  })
})

describe('renderVolatile', () => {
  const today = '2026-11-20'

  it('renders the weekday, a 14-day calendar and the message', () => {
    const text = renderVolatile({ text: 'cafe 3500', today, recentMovements: [] })
    expect(text).toContain('Hoy es viernes 2026-11-20')
    expect(text).toContain('jueves 2026-11-19 (ayer)')
    expect(text).toContain('lunes 2026-11-16 (hace 4 días)')
    expect(text).toContain('sábado 2026-11-07 (hace 13 días)')
    expect(text).toContain('(ninguno)')
    expect(text).toContain('<mensaje>\ncafe 3500\n</mensaje>')
  })

  it('crosses month and year boundaries', () => {
    const text = renderVolatile({ text: 'x', today: '2026-01-02', recentMovements: [] })
    expect(text).toContain('jueves 2026-01-01 (ayer)')
    expect(text).toContain('miércoles 2025-12-31 (hace 2 días)')
  })

  it('lists recent movements, newest first, with the payment or a placeholder', () => {
    const text = renderVolatile({
      text: 'no, fue 3800',
      today,
      recentMovements: [
        {
          direction: 'out',
          amount: '3500',
          currency: 'ARS',
          date: '2026-11-20',
          description: 'café',
          category: 'restaurantes',
          payment: null,
        },
        {
          direction: 'in',
          amount: '50000',
          currency: 'ARS',
          date: '2026-11-19',
          description: 'pago de Juan',
          category: 'otros_ingresos',
          payment: 'transferencia',
        },
      ],
    })
    expect(text).toContain('1. out 3500 ARS 2026-11-20 café [restaurantes] (sin medio)')
    expect(text).toContain(
      '2. in 50000 ARS 2026-11-19 pago de Juan [otros_ingresos] (transferencia)',
    )
  })
})
