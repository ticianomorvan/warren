import { describe, expect, it } from 'vitest'
import type { MovementRow } from './ledger'
import type { Command } from './parse'
import { resolveTarget } from './resolve'

const row = (id: number, description: string, o: Partial<MovementRow> = {}): MovementRow => ({
  id,
  direction: 'out',
  amount: '1000',
  currency: 'ARS',
  date: '2026-11-20',
  description,
  category: 'restaurantes',
  payment: null,
  ...o,
})
const recent = [
  row(10, 'café'),
  row(9, 'súper', { category: 'supermercado', payment: 'crédito visa' }),
  row(8, 'cena'),
  row(7, 'café'),
  row(6, 'nafta', { category: 'combustible' }),
]
const del = (
  o: Partial<Extract<Command, { type: 'delete' }>>,
): Extract<Command, { type: 'delete' }> => ({
  type: 'delete',
  target: 'last',
  target_index: null,
  confidence: 'high',
  ...o,
})
const found = (command: Parameters<typeof resolveTarget>[0], list = recent) => {
  const r = resolveTarget(command, list)
  return r.kind === 'found' ? r.movement.id : r
}

describe('resolveTarget', () => {
  it('trusts the number when the words agree with that row', () => {
    expect(found(del({ target: 'súper', target_index: 2 }))).toBe(9)
    expect(found(del({ target: 'café', target_index: 4 }))).toBe(7) // two cafés: the number tells them apart
    expect(found(del({ target: 'last', target_index: 1 }))).toBe(10)
    expect(found(del({ target: 'super', target_index: 2 }))).toBe(9) // no accent; "supermercado" category
    expect(found(del({ target: 'visa', target_index: 2 }))).toBe(9)
  })

  it('does not follow a number whose row the words do not name', () => {
    // Off by one: "nafta" is number 5, the model said 4 (a café). The words find the one nafta.
    expect(found(del({ target: 'nafta', target_index: 4 }))).toBe(6)
    // "last" with a number other than 1: the words win.
    expect(found(del({ target: 'last', target_index: 3 }))).toBe(10)
  })

  it('falls back to the words when there is no usable number', () => {
    for (const target_index of [null, 0, 6, -1, 1.5, Number.NaN]) {
      expect(found(del({ target: 'nafta', target_index }))).toBe(6)
    }
    expect(found(del({ target: 'last' }))).toBe(10)
    expect(found(del({ target: 'el súper' }))).toBe(9)
  })

  it('asks, listing every movement the words fit, when they fit more than one', () => {
    const r = resolveTarget(del({ target: 'café' }), recent)
    expect(r).toMatchObject({ kind: 'ask' })
    expect(r.kind === 'ask' && r.candidates.map((c) => c.number)).toEqual([1, 4])
  })

  it('asks, listing the newest, when nothing fits', () => {
    const r = resolveTarget(del({ target: 'alquiler' }), recent)
    expect(r.kind === 'ask' && r.candidates.map((c) => c.number)).toEqual([1, 2, 3])
    expect(resolveTarget(del({ target: '' }), recent).kind).toBe('ask')
    expect(resolveTarget(del({ target: '', target_index: 3 }), recent).kind).toBe('ask') // no words, no trust
  })

  it('never acts on a low-confidence command, even with a good number', () => {
    expect(
      resolveTarget(del({ target: 'súper', target_index: 2, confidence: 'low' }), recent).kind,
    ).toBe('ask')
  })

  it('has nothing to point at when the list is empty', () => {
    expect(resolveTarget(del({ target: 'last', target_index: 1 }), [])).toEqual({
      kind: 'ask',
      candidates: [],
    })
  })
})
