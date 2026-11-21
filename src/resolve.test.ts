import { describe, expect, it } from 'vitest'
import type { MovementRow } from './ledger'
import type { Command } from './parse'
import { resolveTarget } from './resolve'

const TODAY = '2026-11-20'
const row = (id: number, description: string, o: Partial<MovementRow> = {}): MovementRow => ({
  id,
  direction: 'out',
  amount: '1000',
  currency: 'ARS',
  date: TODAY,
  description,
  category: 'restaurantes',
  payment: null,
  ...o,
})
const recent = [
  row(10, 'café', { amount: '2800' }),
  row(9, 'súper', { category: 'supermercado', payment: 'crédito visa' }),
  row(8, 'cena'),
  row(7, 'café', { amount: '3100', payment: 'efectivo', date: '2026-11-19' }),
  row(6, 'nafta', { category: 'combustible' }),
]
type Del = Extract<Command, { type: 'delete' }>
const del = (o: Partial<Del>): Del => ({
  type: 'delete',
  target: 'last',
  target_index: null,
  confidence: 'high',
  ...o,
})
const found = (command: Del, text = '', list = recent) => {
  const r = resolveTarget(command, list, { text, today: TODAY })
  return r.kind === 'found' ? r.movement.id : r
}
const asked = (command: Del, text = '', list = recent) => {
  const r = resolveTarget(command, list, { text, today: TODAY })
  return r.kind === 'ask' ? r.candidates.map((c) => c.number) : r
}

describe('resolveTarget: the number', () => {
  it('trusts the number when the words name that row and no other', () => {
    expect(found(del({ target: 'súper', target_index: 2 }))).toBe(9)
    expect(found(del({ target: 'super', target_index: 2 }))).toBe(9) // no accent
    expect(found(del({ target: 'supermercado', target_index: 2 }))).toBe(9) // its whole category name
  })

  it('does not follow a number whose row the words do not name', () => {
    // Off by one: "nafta" is number 5, the model said 4 (a café). The words find the one nafta.
    expect(found(del({ target: 'nafta', target_index: 4 }))).toBe(6)
  })

  it('falls back to the words when there is no usable number', () => {
    for (const target_index of [null, 0, 6, -1, 1.5, Number.NaN]) {
      expect(found(del({ target: 'nafta', target_index }))).toBe(6)
    }
    expect(found(del({ target: 'el súper' }))).toBe(9)
  })

  it('asks, listing every movement the words fit, when they fit more than one and the model gave no number', () => {
    expect(asked(del({ target: 'café' }))).toEqual([1, 4])
  })

  it('asks when the words name nothing, listing the newest', () => {
    expect(asked(del({ target: 'alquiler' }))).toEqual([1, 2, 3])
    expect(asked(del({ target: '' }))).toEqual([1, 2, 3])
    expect(asked(del({ target: '', target_index: 3 }))).toEqual([1, 2, 3]) // no words, no trust
  })

  it('has nothing to point at when the list is empty', () => {
    expect(
      resolveTarget(del({ target: 'last', target_index: 1 }), [], { text: '', today: TODAY }),
    ).toEqual({
      kind: 'ask',
      candidates: [],
    })
  })
})

describe('resolveTarget: words that fit several movements', () => {
  const cafe = (index: number | null, text: string) =>
    asked(del({ target: 'café', target_index: index }), text)

  it('asks when the model picks one but the person said nothing that does (the guess case)', () => {
    expect(cafe(1, 'perdón, el café salió 4100')).toEqual([1, 4])
    expect(cafe(4, 'borrá el café')).toEqual([1, 4])
  })

  it('takes the number when the person gave a position', () => {
    expect(found(del({ target: 'café', target_index: 4 }), 'borrá el 4')).toBe(7)
    expect(found(del({ target: 'café', target_index: 1 }), 'el último café fue 4100')).toBe(10)
    expect(found(del({ target: 'café', target_index: 1 }), 'la última, el café')).toBe(10)
    expect(found(del({ target: 'café', target_index: 4 }), 'el café anterior')).toBe(7)
  })

  it('asks when the position the person gave is not the one picked', () => {
    expect(cafe(4, 'borrá el 2')).toEqual([1, 4])
    expect(cafe(4, 'el último café')).toEqual([1, 4])
  })

  it('does not take a date or an amount for a position', () => {
    expect(cafe(1, 'el café del 15 de octubre')).toEqual([1, 4])
    expect(cafe(1, 'el café fue 20 lucas')).toEqual([1, 4])
    expect(cafe(1, 'el 30 mil era el café')).toEqual([1, 4])
  })

  it('takes a detail of the message that fits the picked row and no other', () => {
    expect(found(del({ target: 'café', target_index: 4 }), 'el café en efectivo era 3800')).toBe(7) // payment
    expect(found(del({ target: 'café', target_index: 4 }), 'el café de 3.100 fue 3800')).toBe(7) // old amount
    expect(found(del({ target: 'café', target_index: 1 }), 'el café de 2800 fue 3800')).toBe(10)
    expect(found(del({ target: 'café', target_index: 1 }), 'el café de 2800 pesos')).toBe(10)
    expect(found(del({ target: 'café', target_index: 4 }), 'el café de ayer')).toBe(7) // day
    expect(found(del({ target: 'café', target_index: 1 }), 'el café de hoy')).toBe(10)
    expect(found(del({ target: 'café', target_index: 4 }), 'el café del 19/11')).toBe(7)
  })

  it('asks when the detail fits the other match, not the picked row', () => {
    expect(cafe(1, 'el café en efectivo')).toEqual([1, 4])
    expect(cafe(4, 'el café de hoy')).toEqual([1, 4])
    expect(cafe(1, 'el café de 3100')).toEqual([1, 4])
  })
})

describe('resolveTarget: amounts written with units', () => {
  const gyms = [row(2, 'gimnasio', { amount: '18000' }), row(1, 'gimnasio', { amount: '15000' })]
  it('reads "15 mil", "15k" and "15 lucas" as the old amount', () => {
    for (const text of ['el gimnasio de 15 mil', 'el gimnasio de 15k', 'el gimnasio de 15 lucas']) {
      expect(found(del({ target: 'gimnasio', target_index: 2 }), text, gyms), text).toBe(1)
    }
    expect(
      asked(del({ target: 'gimnasio', target_index: 2 }), 'el gimnasio de 18 mil', gyms),
    ).toEqual([1, 2])
  })
})

describe('resolveTarget: "last"', () => {
  it('is number 1', () => {
    expect(found(del({ target: 'last' }))).toBe(10)
    expect(found(del({ target: 'last', target_index: 1 }))).toBe(10)
    expect(found(del({ target: 'el último' }))).toBe(10)
    expect(found(del({ target: 'la última', target_index: 1 }))).toBe(10)
  })

  it('asks when it comes with a different number: a contradiction is not a hint', () => {
    expect(asked(del({ target: 'last', target_index: 3 }))).toEqual([1, 2, 3])
    expect(asked(del({ target: 'el último', target_index: 4 }))).toEqual([1, 2, 3])
    expect(asked(del({ target: 'last', target_index: 99 }))).toEqual([1, 2, 3])
  })
})

describe('resolveTarget: names are descriptions, not shared stems', () => {
  const list = [
    row(3, 'netflix', { category: 'entretenimiento' }),
    row(2, 'uber', { category: 'transporte', payment: 'transferencia' }),
    row(1, 'luz', { category: 'servicios' }),
  ]
  it('does not take the only other match for the target', () => {
    // "entrada" shares "entr" with entretenimiento, "transferencia" with transporte's payment and
    // "tran", "servilletas" shares "serv" with servicios: none names a movement.
    expect(asked(del({ target: 'entrada' }), '', list)).toEqual([1, 2, 3])
    expect(asked(del({ target: 'transferencia a juan', target_index: 2 }), '', list)).toEqual([
      1, 2, 3,
    ])
    expect(asked(del({ target: 'servilletas', target_index: 3 }), '', list)).toEqual([1, 2, 3])
    expect(asked(del({ target: 'transferencia a juan' }), '', list)).toEqual([1, 2, 3])
  })

  it('still finds a movement by its own description', () => {
    expect(found(del({ target: 'uber' }), '', list)).toBe(2)
    expect(found(del({ target: 'la luz' }), '', list)).toBe(1)
  })
})

describe('resolveTarget: low confidence', () => {
  it('never acts, even with a good number', () => {
    expect(asked(del({ target: 'súper', target_index: 2, confidence: 'low' }))).toEqual([2])
  })

  it('lists the one match even when it is outside the newest three', () => {
    expect(asked(del({ target: 'nafta', confidence: 'low' }))).toEqual([5])
    expect(asked(del({ target: 'alquiler', confidence: 'low' }))).toEqual([1, 2, 3])
  })
})
