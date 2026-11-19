import { describe, expect, it } from 'vitest'
import {
  FACTS,
  factsFor,
  PRINCIPLES,
  PROFESSIONALS,
  policyViolations,
  principlesFor,
  TOPICS,
  TRAPS,
} from '../src/advice'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const topics: readonly string[] = TOPICS

const texts = (): string[] => [
  ...PRINCIPLES.flatMap((p) => [p.title, p.body]),
  ...TRAPS.flatMap((t) => [t.title, ...t.signs, t.what_to_do]),
  ...FACTS.flatMap((f) => [f.statement, f.source_name]),
]

describe('knowledge lint', () => {
  it('gives every fact an https source, valid dates and a known topic', () => {
    for (const f of FACTS) {
      expect(f.source_url, f.id).toMatch(/^https:\/\//)
      expect(() => new URL(f.source_url), f.id).not.toThrow()
      expect(f.source_name.length, f.id).toBeGreaterThan(0)
      expect(f.as_of, f.id).toMatch(DATE)
      expect(f.review_by, f.id).toMatch(DATE)
      expect(f.review_by >= f.as_of, `${f.id}: review_by before as_of`).toBe(true)
      expect(topics, f.id).toContain(f.topic)
      if (f.needs_professional) expect(PROFESSIONALS, f.id).toContain(f.needs_professional)
      expect(['slow', 'moving'], f.id).toContain(f.volatility)
      if (f.value !== undefined) expect(f.value, f.id).toMatch(/^\d+(\.\d+)?$/)
    }
  })

  it('keeps moving facts on a short review and ids unique', () => {
    const ids = [
      ...FACTS.map((f) => f.id),
      ...PRINCIPLES.map((p) => p.id),
      ...TRAPS.map((t) => t.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
    for (const f of FACTS.filter((x) => x.volatility === 'moving')) {
      const days = (Date.parse(f.review_by) - Date.parse(f.as_of)) / 86_400_000
      expect(days, f.id).toBeLessThanOrEqual(36)
    }
  })

  it('files every principle under known topics and gives traps signs and a next step', () => {
    for (const p of PRINCIPLES) {
      expect(p.applies_to.length, p.id).toBeGreaterThan(0)
      for (const t of p.applies_to) expect(topics, p.id).toContain(t)
    }
    for (const t of TRAPS) {
      expect(t.signs.length, t.id).toBeGreaterThan(0)
      expect(t.what_to_do.length, t.id).toBeGreaterThan(0)
    }
  })

  it('names no security, token or issuer and gives no buy or sell order', () => {
    expect(policyViolations(texts())).toEqual([])
  })

  it('catches what the denylist is for', () => {
    for (const bad of [
      'Consider $AAPL for growth',
      'Buy a CEDEAR de Apple',
      'Hold USDT for the yield',
      'Comprá bonos ahora',
      'You should buy AL30',
      'Vendé todo',
      'Sell GD30 before Friday',
      'BUY NOW',
      'Buy now',
      'You should buy more',
      'You should hold on to the shares',
      'Comprar ya',
      'Send it through Mercado Pago',
      'AL30 pays more',
    ])
      expect(policyViolations([bad]), bad).not.toEqual([])
    for (const fine of [
      'Dólar oficial, compra 1.000 y venta 1.020',
      'El banco vende dólares',
      'You must hold the receipt for a year',
      'Buy it in cuotas only at the cash price',
      'Hold the card statement until it is paid',
    ])
      expect(policyViolations([fine]), fine).toEqual([])
    expect(
      policyViolations(['Pay the full balance; compare the cash price with the price in cuotas.']),
    ).toEqual([])
  })
})

describe('factsFor and principlesFor', () => {
  const fact = FACTS.find((f) => f.id === 'fx-official-wholesale')
  const stale = (iso: string) => factsFor(new Date(iso)).find((f) => f.id === fact?.id)?.stale

  it('marks a fact stale from the day after its review_by, by the Argentine date', () => {
    expect(fact?.review_by).toBe('2026-11-25')
    expect(stale('2026-11-25T00:00:00-03:00')).toBe(false)
    expect(stale('2026-11-25T23:59:59-03:00')).toBe(false)
    // 02:59 UTC on the 26th is still the 25th in Buenos Aires; 03:00 is the 26th.
    expect(stale('2026-11-26T02:59:59Z')).toBe(false)
    expect(stale('2026-11-26T03:00:00Z')).toBe(true)
  })

  it('filters by topic', () => {
    const now = new Date('2026-11-19T12:00:00Z')
    expect(factsFor(now, 'fx').map((f) => f.id)).toEqual([
      'fx-official-wholesale',
      'fx-official-retail',
    ])
    expect(principlesFor('cards').every((p) => p.applies_to.includes('cards'))).toBe(true)
    expect(principlesFor().length).toBe(PRINCIPLES.length)
    expect(factsFor(now, 'scams')).toEqual([])
  })
})

// Decimal math on strings: no float touches an index level.
const scaled = (level: string) => {
  const [whole = '', fraction = ''] = level.split('.')
  return BigInt(whole + fraction.padEnd(4, '0'))
}
/** (a - b) / b as a percentage, rounded half up to two decimals, as a string. */
const percentChange = (a: string, b: string) => {
  const [x, y] = [scaled(a), scaled(b)]
  const hundredths = ((x - y) * 20000n + y) / (2n * y)
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`
}

describe('the CPI fact', () => {
  const fact = FACTS.find((f) => f.id === 'cpi-monthly-2026-10')
  const levels = /September 2026 ([\d.]+), October 2026 ([\d.]+), October 2025 ([\d.]+)/.exec(
    fact?.statement ?? '',
  )

  it('states percentages that follow from the index levels it quotes', () => {
    const [, sep, oct, octLastYear] = levels ?? []
    expect(levels).not.toBeNull()
    expect(percentChange(oct ?? '', sep ?? '')).toBe('2.17')
    expect(percentChange(oct ?? '', octLastYear ?? '')).toBe('33.13')
    expect(fact?.value).toBe('2.17')
    expect(fact?.statement).toContain('33.13%')
  })

  it('computes exactly', () => {
    expect(percentChange('110.0000', '100.0000')).toBe('10.00')
    expect(percentChange('100.0050', '100.0000')).toBe('0.01')
    expect(percentChange('100.0049', '100.0000')).toBe('0.00')
  })
})
