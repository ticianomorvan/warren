import { describe, expect, it } from 'vitest'
import { finalize, normalizeNumber, numbersIn, unknownNumbers } from './finalize'

describe('numbers', () => {
  it('reads Argentine and database forms as one', () => {
    expect(normalizeNumber('3.500')).toBe('3500')
    expect(normalizeNumber('1.500,50')).toBe('1500.5')
    expect(normalizeNumber('1500.50')).toBe('1500.5')
    expect(normalizeNumber('3500')).toBe('3500')
    expect(numbersIn('Café $3.500 y súper $12.000,50 el 21/11')).toEqual([
      '3500',
      '12000.5',
      '21',
      '11',
    ])
  })

  it('flags a figure no fact has, and not a list label', () => {
    const facts = ['out 3500 ARS 2026-11-21 10:00 café']
    expect(unknownNumbers('El café fue de $3.500', facts)).toEqual([])
    expect(unknownNumbers('Son $7.000 entre los dos', facts)).toEqual(['7000'])
    expect(unknownNumbers('1. Café $3.500\n2. Café $3.500', facts)).toEqual([])
  })
})

describe('finalize', () => {
  const lines = ['✓ Corregido: Café $4.200 (antes $3.500)']
  it('appends the line the model left out', () => {
    expect(finalize({ modelText: 'Listo.', lines, facts: [] }).text).toBe(`${lines[0]}\nListo.`)
  })
  it('does not repeat a line the model copied', () => {
    expect(finalize({ modelText: `Hecho: ${lines[0]}`, lines, facts: [] }).text).toBe(
      `Hecho: ${lines[0]}`,
    )
  })
  it('keeps only the lines when the text has an invented number', () => {
    const r = finalize({ modelText: 'Sumando todo son $9.999', lines, facts: [] })
    expect(r).toEqual({ text: lines[0], replaced: true, unknown: ['9999'] })
  })
  it('falls back when there are no lines to show', () => {
    expect(finalize({ modelText: 'Gastaste $9.999', lines: [], facts: [] }).text).toContain(
      'No pude armar',
    )
  })
  it('lets a number from a fact through', () => {
    const r = finalize({ modelText: 'Sí, borré el súper de $12.000', lines: [], facts: ['12000'] })
    expect(r.replaced).toBe(false)
  })
})
