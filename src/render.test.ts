import { describe, expect, it } from 'vitest'
import type { Movement } from './agent'
import {
  fitReply,
  formatMoney,
  MAX_HEARD_CHARS,
  MAX_REPLY_CHARS,
  renderHeard,
  renderHelp,
  renderLog,
  renderStale,
  renderUndo,
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

describe('renderHelp', () => {
  it('adds the help contact only when one is configured', () => {
    const plain = renderHelp()
    expect(plain).toContain('Mandame un gasto')
    expect(plain).not.toContain('persona')
    const withContact = renderHelp({ helpContact: 'ayuda@heywarren.app' })
    expect(withContact).toBe(`${plain}\nSi necesitás hablar con una persona: ayuda@heywarren.app`)
  })
})

describe('fitReply', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, k) => ({
      ...mv(),
      description: `café número ${k + 1} con un nombre largo`,
      amount: String(1000 + k),
    }))
  const log = (n: number) => renderLog(many(n), TODAY)

  it('is the heard line, the record and the texts, unchanged, when they fit', () => {
    expect(fitReply({ heard: 'café 3500', lines: ['✓ Café $3.500'], notes: ['Ojo.'] })).toBe(
      '🎙️ "café 3500"\n✓ Café $3.500\nOjo.',
    )
    expect(fitReply({ lines: ['✓ Café $3.500'], notes: [] })).toBe('✓ Café $3.500')
  })

  it('shows at most 80 characters of what was heard, ending in "…", and keeps the record and the texts', () => {
    const heard = 'palabra '.repeat(400).trim() // 3,199 characters
    const reply = fitReply({ heard, lines: [log(40)], notes: ['Un texto.'] })
    const first = reply.split('\n')[0] ?? ''
    expect(first).toMatch(/^🎙️ "palabra .*…"$/)
    expect(first.length).toBe('🎙️ ""'.length + MAX_HEARD_CHARS)
    expect(renderHeard('café 3500')).toBe('🎙️ "café 3500"') // short enough: whole
    expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(reply).toContain('✓ Anoté 40:')
    expect(reply.endsWith('Un texto.')).toBe(true)
  })

  it('drops the model texts, not the record, when they do not fit', () => {
    const reply = fitReply({ heard: 'x'.repeat(3000), lines: [log(110)], notes: ['Un texto.'] })
    expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(reply).not.toContain('Un texto.')
    expect(reply).toContain('✓ Anoté 110:')
  })

  it('collapses a long list of movements to its first items and says how many more', () => {
    const reply = fitReply({ heard: 'x'.repeat(3000), lines: [log(120)], notes: [] })
    expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(reply).toContain('✓ Anoté 120:')
    expect(reply).toContain('• Café número 1 con')
    expect(reply).toMatch(/\n• … y \d+ más$/)
    const shown = reply.split('\n').filter((l) => l.startsWith('• ') && !l.includes('…')).length
    const hidden = Number(/y (\d+) más/.exec(reply)?.[1])
    expect(shown + hidden).toBe(120) // every movement is either listed or counted
  })

  it('keeps the first lines and counts the rest when there is no list to collapse (typed text too)', () => {
    const lines = Array.from({ length: 300 }, (_, k) => `✓ Borré: Café número ${k} $1.000 · 10:00`)
    const reply = fitReply({ lines, notes: [] })
    expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(reply.startsWith(lines[0] ?? '')).toBe(true)
    expect(reply).toMatch(/\n… y \d+ más$/)
  })

  it('cuts one line that is alone too long, never past the limit', () => {
    const reply = fitReply({ lines: ['y'.repeat(9000)], notes: [] })
    expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(reply.endsWith('…')).toBe(true)
  })

  it('does not split an emoji when it cuts', () => {
    const reply = fitReply({ heard: '😀'.repeat(3000), lines: ['✓ Café $3.500'], notes: [] }, 500)
    expect(reply.length).toBeLessThanOrEqual(500)
    expect(reply).not.toMatch(/[\ud800-\udbff]"|[\ud800-\udbff]…/)
  })
})

describe('renderUndo', () => {
  const line = (o: Partial<Movement>) => mv(o)
  it('writes an undone log on one line, with the day when it is not today', () => {
    expect(
      renderUndo(
        [
          { kind: 'logged', movement: line({ description: 'súper', amount: '5000' }) },
          {
            kind: 'logged',
            movement: line({ description: 'panadería', amount: '3000', date: '2026-11-20' }),
          },
        ],
        TODAY,
      ),
    ).toBe('↩︎ Deshice: Súper $5.000 · Panadería $3.000 · ayer')
  })

  it('lists a correction, a delete and a log undone, each as what happened to it', () => {
    expect(
      renderUndo(
        [
          {
            kind: 'corrected',
            movement: line({ amount: '3500' }),
            from: line({ amount: '3800' }),
            changed: ['money'],
          },
          { kind: 'logged', movement: line({ description: 'subte', amount: '1200' }) },
          {
            kind: 'deleted',
            movement: line({ description: 'súper', amount: '12000', payment: 'crédito visa' }),
          },
        ],
        TODAY,
      ),
    ).toBe(
      '↩︎ Deshice:\n• Café $3.500 (estaba $3.800)\n• Quité Subte $1.200\n• Volvió Súper $12.000 (crédito visa)',
    )
  })

  it('is held by fitReply like any other record: a long list collapses and says how many are left out', () => {
    const bullets = Array.from({ length: 400 }, (_, k) => ({
      kind: 'deleted' as const,
      movement: line({ description: `cosa ${k}`, amount: String(1000 + k) }),
    }))
    const reply = fitReply({ lines: [renderUndo(bullets, TODAY)], notes: [] })
    expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(reply.startsWith('↩︎ Deshice:\n• Volvió Cosa 0 $1.000')).toBe(true)
    expect(reply).toMatch(/• … y \d+ más$/)
  })
})

describe('renderStale', () => {
  it('names the movements that changed, one or several', () => {
    expect(renderStale([mv()], TODAY)).toBe(
      'No deshice nada: Café $3.500 cambió después. Decime qué querés cambiar.',
    )
    expect(renderStale([mv(), mv({ description: 'súper', amount: '5000' })], TODAY)).toBe(
      'No deshice nada: Café $3.500 · Súper $5.000 cambiaron después. Decime qué querés cambiar.',
    )
  })
})
