import { describe, expect, it } from 'vitest'
import type { MovementRow } from './ledger'
import type { Command } from './parse'
import { positionsIn, resolveTarget } from './resolve'

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

describe('resolveTarget: the words', () => {
  it('finds the movement the words name', () => {
    expect(found(del({ target: 'súper', target_index: 2 }))).toBe(9)
    expect(found(del({ target: 'super', target_index: 2 }))).toBe(9) // no accent
    expect(found(del({ target: 'supermercado', target_index: 2 }))).toBe(9) // its whole category name
    expect(found(del({ target: 'el súper' }))).toBe(9)
  })

  it('does not follow a number whose row the words do not name (an off-by-one)', () => {
    expect(found(del({ target: 'nafta', target_index: 4 }))).toBe(6)
    for (const target_index of [null, 0, 6, -1, 1.5, Number.NaN]) {
      expect(found(del({ target: 'nafta', target_index }))).toBe(6)
    }
  })

  it('asks, listing the newest, when the words name nothing', () => {
    expect(asked(del({ target: 'alquiler' }))).toEqual([1, 2, 3])
    expect(asked(del({ target: '' }))).toEqual([1, 2, 3])
    expect(asked(del({ target: '', target_index: 3 }))).toEqual([1, 2, 3]) // no words, no trust
  })

  it('has nothing to point at when the list is empty', () => {
    expect(
      resolveTarget(del({ target: 'last', target_index: 1 }), [], { text: '', today: TODAY }),
    ).toEqual({ kind: 'ask', candidates: [] })
  })
})

describe('resolveTarget: words that fit several movements', () => {
  it('the newest match wins, whatever number the model gave', () => {
    expect(found(del({ target: 'café', target_index: null }), 'perdón, el café salió 4100')).toBe(
      10,
    )
    expect(found(del({ target: 'café', target_index: 1 }), 'perdón, el café salió 4100')).toBe(10)
    expect(found(del({ target: 'café', target_index: 4 }), 'borrá el café')).toBe(10)
  })

  it('a detail of the message narrows the matches first, then the newest left wins', () => {
    expect(found(del({ target: 'café', target_index: 1 }), 'el café en efectivo era 3800')).toBe(7)
    expect(found(del({ target: 'café', target_index: 1 }), 'el café de 3.100 fue 3800')).toBe(7)
    expect(found(del({ target: 'café', target_index: 1 }), 'el café de 2800 fue 3800')).toBe(10)
    expect(found(del({ target: 'café', target_index: 1 }), 'el café de ayer')).toBe(7)
    expect(found(del({ target: 'café', target_index: 4 }), 'el café de hoy')).toBe(10)
    expect(found(del({ target: 'café', target_index: 1 }), 'el café del 19/11')).toBe(7)
  })

  it('does not take a date or an amount for a position', () => {
    expect(found(del({ target: 'café', target_index: 4 }), 'el café del 15 de octubre')).toBe(10)
    expect(found(del({ target: 'café', target_index: 4 }), 'el café fue 20 lucas')).toBe(10)
    expect(found(del({ target: 'café', target_index: 4 }), 'el 30 mil era el café')).toBe(10)
  })
})

describe('resolveTarget: a position in the message wins', () => {
  it("uses the number the person wrote, even when the model's words name another row", () => {
    // "el 4 fue 4500": the model pointed at number 4 (a café) but wrote target "súper".
    expect(found(del({ target: 'súper', target_index: 4 }), 'el 4 fue 4500')).toBe(7)
    // And even when the model's number differs.
    expect(found(del({ target: 'súper', target_index: 2 }), 'el 4 fue 4500')).toBe(7)
    expect(found(del({ target: 'café', target_index: null }), 'borrá el 4')).toBe(7)
    expect(found(del({ target: 'café', target_index: 1 }), 'la 3 bórrala')).toBe(8)
  })

  it('understands bare numbers, number words and "último"', () => {
    expect(found(del({ target: 'café', target_index: null }), '4')).toBe(7)
    expect(found(del({ target: 'café', target_index: 1 }), 'el cuatro')).toBe(7)
    expect(found(del({ target: 'nafta', target_index: 5 }), 'el último café fue 4100')).toBe(10)
  })

  it('"primero" and "anterior" take the model\'s number', () => {
    expect(found(del({ target: 'café', target_index: 4 }), 'el café anterior')).toBe(7)
    expect(found(del({ target: 'gimnasio', target_index: 2 }), 'el primero')).toBe(9)
  })

  it('lists the positions a message names', () => {
    expect(positionsIn('el 3 fue 4500')).toEqual([3])
    expect(positionsIn('2')).toEqual([2])
    expect(positionsIn('el dos bórralo, cambiame el primero')).toEqual([2, 0])
    expect(positionsIn('la última')).toEqual([1])
    expect(positionsIn('el 15 de octubre')).toEqual([])
    expect(positionsIn('el 20 lucas')).toEqual([])
    expect(positionsIn('el café fueron 4500')).toEqual([])
  })
})

describe('resolveTarget: amounts written with units', () => {
  const gyms = [row(2, 'gimnasio', { amount: '18000' }), row(1, 'gimnasio', { amount: '15000' })]
  it('reads "15 mil", "15k" and "15 lucas" as the old amount', () => {
    for (const text of ['el gimnasio de 15 mil', 'el gimnasio de 15k', 'el gimnasio de 15 lucas']) {
      expect(found(del({ target: 'gimnasio', target_index: 1 }), text, gyms), text).toBe(1)
    }
    expect(found(del({ target: 'gimnasio', target_index: 2 }), 'el gimnasio de 18 mil', gyms)).toBe(
      2,
    )
    expect(found(del({ target: 'gimnasio', target_index: 2 }), 'el gimnasio', gyms)).toBe(2)
  })
})

describe('resolveTarget: "last"', () => {
  it('is number 1', () => {
    expect(found(del({ target: 'last' }))).toBe(10)
    expect(found(del({ target: 'last', target_index: 1 }))).toBe(10)
    expect(found(del({ target: 'el último' }))).toBe(10)
    expect(found(del({ target: 'la última', target_index: 1 }))).toBe(10)
  })

  it('asks when it comes with a different number and the message says no position', () => {
    expect(asked(del({ target: 'last', target_index: 3 }))).toEqual([1, 2, 3])
    expect(asked(del({ target: 'el último', target_index: 4 }))).toEqual([1, 2, 3])
    expect(asked(del({ target: 'last', target_index: 99 }))).toEqual([1, 2, 3])
    expect(asked(del({ target: 'last', confidence: 'low' }))).toEqual([1, 2, 3])
  })
})

describe('resolveTarget: names are descriptions, not shared stems', () => {
  const list = [
    row(3, 'netflix', { category: 'entretenimiento' }),
    row(2, 'uber', { category: 'transporte', payment: 'transferencia' }),
    row(1, 'luz', { category: 'servicios' }),
  ]
  it('does not take the only other match for the target', () => {
    // "entrada" shares "entr" with entretenimiento, "transferencia" and "tran" with transporte, and
    // "servilletas" shares "serv" with servicios: none names a movement.
    expect(asked(del({ target: 'entrada' }), '', list)).toEqual([1, 2, 3])
    expect(asked(del({ target: 'transferencia a juan', target_index: 2 }), '', list)).toEqual([
      1, 2, 3,
    ])
    expect(asked(del({ target: 'servilletas', target_index: 3 }), '', list)).toEqual([1, 2, 3])
  })

  it('still finds a movement by its own description', () => {
    expect(found(del({ target: 'uber' }), '', list)).toBe(2)
    expect(found(del({ target: 'la luz' }), '', list)).toBe(1)
  })
})

describe('resolveTarget: low confidence', () => {
  it('acts when the words name a movement, asks when they name none', () => {
    expect(found(del({ target: 'nafta', confidence: 'low' }))).toBe(6)
    expect(asked(del({ target: 'alquiler', confidence: 'low' }))).toEqual([1, 2, 3])
    expect(asked(del({ target: '', target_index: 2, confidence: 'low' }))).toEqual([1, 2, 3])
  })
})
