import { describe, expect, it } from 'vitest'
import type { MovementRow } from './ledger'
import type { Command } from './parse'
import { answerNumber, positionsIn, resolveTarget, saysLast } from './resolve'

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
    expect(
      found(del({ target: 'café', target_index: 4, confidence: 'low' }), 'borrá el café'),
    ).toBe(10)
  })

  it('a confident model pick among the named rows stands: it may have understood a detail code cannot parse', () => {
    expect(found(del({ target: 'café', target_index: 4 }), 'el café de la quinta')).toBe(7)
    expect(found(del({ target: 'café', target_index: 2 }), 'el café de la quinta')).toBe(10) // not a café: newest
    expect(found(del({ target: 'café', target_index: null }), 'el café de la quinta')).toBe(10)
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
    expect(found(del({ target: 'café', target_index: null }), 'el café del 15 de octubre')).toBe(10)
    expect(found(del({ target: 'café', target_index: null }), 'el café fue 20 lucas')).toBe(10)
    expect(found(del({ target: 'café', target_index: null }), 'el 30 mil era el café')).toBe(10)
  })
})

describe('resolveTarget: a position in the message wins', () => {
  it("uses the number the person wrote, even when the model's words name another row", () => {
    // "el 4 fue 4500": the model pointed at number 4 (a café) but wrote target "súper".
    expect(found(del({ target: 'súper', target_index: 4 }), 'el 4 fue 4500')).toBe(7)
    // But not when the model's number differs and the words name another row: it asks.
    expect(asked(del({ target: 'súper', target_index: 2 }), 'el 4 fue 4500')).toEqual([2])
    expect(found(del({ target: 'café', target_index: null }), 'borrá el 4')).toBe(7)
    expect(found(del({ target: 'cena', target_index: 1 }), 'la 3 bórrala')).toBe(8)
  })

  it('understands bare numbers, number words and "último"', () => {
    expect(found(del({ target: 'café', target_index: null }), '4')).toBe(7)
    expect(found(del({ target: 'café', target_index: 1 }), 'el cuatro')).toBe(7)
  })

  it('"primero" and "anterior" take the model\'s number', () => {
    expect(found(del({ target: 'café', target_index: 4 }), 'el café anterior')).toBe(7)
    expect(asked(del({ target: 'gimnasio', target_index: 2 }), 'el primero')).toEqual([1, 2, 3]) // no row named
  })

  it('lists the positions a message names', () => {
    expect(positionsIn('el 3 fue 4500')).toEqual([3])
    expect(positionsIn('2')).toEqual([2])
    expect(positionsIn('borrá el 3')).toEqual([3])
    expect(positionsIn('el 2, bórralo')).toEqual([2])
    expect(positionsIn('la 3 bórrala')).toEqual([3])
    expect(positionsIn('cambiá el 2 por 3000')).toEqual([2])
    expect(positionsIn('#2')).toEqual([2])
    expect(positionsIn('el dos bórralo, cambiame el primero')).toEqual([2, 0])
    expect(positionsIn('el café fueron 4500')).toEqual([])
  })

  it('never takes an amount, a date or a unit for a position', () => {
    for (const text of [
      'el 15 de octubre',
      'el 20 lucas',
      'la nafta del 3/11 fue 25000',
      'cambiá la nafta del 03/11 a 25000', // our own question writes dates this way
      'cambiá el 2.500 por 3000',
      'el 2,5 fue 3',
      'el 1 luca',
      'el 2 palos',
      'el 5 usd',
      'el 3 pesos',
      'el 3 mil',
      'lados',
    ]) {
      expect(positionsIn(text), text).toEqual([])
    }
  })

  it('drops a position that is not in the list', () => {
    expect(positionsIn('el 7 fue 4500', 5)).toEqual([])
    expect(positionsIn('el 4 fue 4500', 5)).toEqual([4])
  })

  it('a position with a date or a negation is still one position', () => {
    expect(positionsIn('el 2 fue del 20/11')).toEqual([2])
    expect(positionsIn('el 2 fue ayer, no el 1')).toEqual([2])
    expect(positionsIn('el anterior al último')).toEqual([0])
  })

  it('knows when a message says "último"', () => {
    expect(saysLast('borrá lo último')).toBe(true)
    expect(saysLast('la última nafta')).toBe(true)
    expect(saysLast('el café fue 3500')).toBe(false)
  })
})

describe('resolveTarget: "el último X"', () => {
  // 1 súper, 2 café 3500, 3 café 4000, 4 nafta
  const list = [
    row(40, 'súper', { category: 'supermercado' }),
    row(30, 'café', { amount: '3500' }),
    row(20, 'café', { amount: '4000' }),
    row(10, 'nafta', { category: 'combustible' }),
  ]
  it('is the newest row its description names, not row 1', () => {
    const correction = {
      type: 'correct',
      target: 'café',
      target_index: 3,
      confidence: 'high',
      changes: {
        direction: null,
        amount: '4000',
        currency: null,
        date: null,
        description: null,
        category: null,
        payment: null,
      },
    } as never
    expect(found(correction, 'el último café fue 4000', list)).toBe(30)
    expect(found(del({ target: 'café', target_index: null }), 'el último café', list)).toBe(30)
    expect(found(del({ target: 'nafta', target_index: 1 }), 'borrá la última nafta', list)).toBe(10)
  })

  it('is row 1 when nothing else is named', () => {
    expect(found(del({ target: 'last', target_index: 3 }), 'borrá lo último', list)).toBe(40)
    expect(found(del({ target: 'last', target_index: null }), 'el último', list)).toBe(40)
  })
})

describe('resolveTarget: dates and amounts are not positions', () => {
  const list = [
    row(40, 'kiosco'),
    row(30, 'café'),
    row(20, 'nafta', { category: 'combustible', date: '2026-11-03', amount: '20000' }),
  ]
  it('"la nafta del 3/11 fue 25000" is the nafta, not number 3 by accident, and number 2 stays unmoved', () => {
    expect(
      found(del({ target: 'nafta', target_index: 3 }), 'la nafta del 3/11 fue 25000', list),
    ).toBe(20)
    expect(found(del({ target: 'café', target_index: 2 }), 'el café del 3/11', list)).toBe(30)
    expect(found(del({ target: 'café', target_index: 2 }), 'cambiá el 2.500 por 3000', list)).toBe(
      30,
    )
  })
})

describe('resolveTarget: the new value does not narrow the candidates', () => {
  const list = [
    row(30, 'café', { amount: '3500' }),
    row(20, 'café', { amount: '4000', date: '2026-11-19' }),
    row(10, 'súper', { category: 'supermercado', payment: 'crédito visa' }),
    row(9, 'súper', { category: 'supermercado', payment: 'efectivo' }),
  ]
  const fix = (target: string, changes: Partial<Record<string, string>>, text: string) =>
    found(
      {
        type: 'correct',
        target,
        target_index: null,
        confidence: 'high',
        changes: {
          direction: null,
          amount: null,
          currency: null,
          date: null,
          description: null,
          category: null,
          payment: null,
          ...changes,
        },
      } as never,
      text,
      list,
    )

  it('"el café fue 4000" corrects the newest café, not the one that already is 4000', () => {
    expect(fix('café', { amount: '4000' }, 'el café fue 4000')).toBe(30)
  })

  it('"el café fue ayer y 3800" does not pick the café of yesterday', () => {
    expect(fix('café', { date: '2026-11-19', amount: '3800' }, 'el café fue ayer y 3800')).toBe(30)
  })

  it('"el súper fue 9500 con la visa" does not pick the súper already on visa', () => {
    expect(
      fix('súper', { amount: '9500', payment: 'crédito visa' }, 'el súper fue 9500 con la visa'),
    ).toBe(10)
  })

  it('an old value still narrows: "el café de 4000 fue 3800", "el súper en efectivo fue 9500"', () => {
    expect(fix('café', { amount: '3800' }, 'el café de 4000 fue 3800')).toBe(20)
    expect(fix('súper', { amount: '9500' }, 'el súper en efectivo fue 9500')).toBe(9)
    expect(fix('café', { amount: '3800' }, 'el café de ayer fue 3800')).toBe(20)
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
    expect(found(del({ target: 'gimnasio', target_index: 2 }), 'el gimnasio', gyms)).toBe(1) // confident pick
    expect(found(del({ target: 'gimnasio', target_index: null }), 'el gimnasio', gyms)).toBe(2)
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

describe('answerNumber', () => {
  it('reads a message that is only the pick of one of the options shown', () => {
    const asked = [2, 3, 5]
    expect(answerNumber('2', asked)).toBe(2)
    expect(answerNumber('el 3', asked)).toBe(3)
    expect(answerNumber('la 5.', asked)).toBe(5)
    expect(answerNumber('dale el 2', asked)).toBe(2)
    expect(answerNumber('el tres', asked)).toBe(3)
    expect(answerNumber('el primero', asked)).toBe(2) // the first option shown
    expect(answerNumber('la primera', [4, 1])).toBe(4)
  })

  it('"el último" is list row 1, only if the question showed it', () => {
    expect(answerNumber('el último', [1, 2, 3])).toBe(1)
    expect(answerNumber('el último', [2, 3])).toBeNull()
  })

  it('"sí" and "dale" answer only a one-option question', () => {
    expect(answerNumber('sí', [4])).toBe(4)
    expect(answerNumber('dale', [4])).toBe(4)
    expect(answerNumber('sí', [4, 5])).toBeNull()
  })

  it('is not an answer when the message says more, or picks a row not shown', () => {
    expect(answerNumber('el 4', [1, 2, 3])).toBeNull()
    expect(answerNumber('el 2 fue 4500', [1, 2, 3])).toBeNull()
    expect(answerNumber('café 3500', [1, 2, 3])).toBeNull()
    expect(answerNumber('4500', [1, 2, 3])).toBeNull()
    expect(answerNumber('el anterior', [1, 2, 3])).toBeNull()
  })
})

describe('resolveTarget: "del N" is a day, not a position', () => {
  // 1 kiosco, 2 café, 3 pan, 4 café
  const list = [
    row(40, 'kiosco'),
    row(30, 'café'),
    row(20, 'pan', { category: 'supermercado' }),
    row(10, 'café', { amount: '3100' }),
  ]
  it('"el café del 3" and "el café del 3 fue 4500" are not row 3', () => {
    expect(found(del({ target: 'café', target_index: null }), 'borrá el café del 3', list)).toBe(30)
    expect(found(del({ target: 'café', target_index: null }), 'el café del 3 fue 4500', list)).toBe(
      30,
    )
    expect(positionsIn('el café del 3 fue 4500')).toEqual([])
  })

  it('a position that is not one of the rows the words name asks', () => {
    // "fue el 5 en la panadería": 5 is not the panadería.
    const bakery = [
      row(5, 'kiosco'),
      row(4, 'panadería'),
      row(3, 'pan'),
      row(2, 'café'),
      row(1, 'luz'),
    ]
    expect(positionsIn('fue el 5 en la panadería', 5)).toEqual([5])
    expect(
      asked(del({ target: 'panadería', target_index: 2 }), 'fue el 5 en la panadería', bakery),
    ).toEqual([2])
    // "el 10 a la noche": number 10 is not the cena.
    const ten = Array.from({ length: 10 }, (_, k) => row(100 - k, k === 3 ? 'cena' : `algo${k}x`))
    expect(asked(del({ target: 'cena', target_index: 4 }), 'el 10 a la noche', ten)).toEqual([4])
  })
})

describe('resolveTarget: ordinals', () => {
  it('"la segunda" and "la tercera" are model-placed like "primero", only on a named row', () => {
    expect(found(del({ target: 'café', target_index: 4 }), 'la segunda')).toBe(7)
    expect(asked(del({ target: 'café', target_index: 2 }), 'la tercera')).toEqual([1, 4])
    expect(asked(del({ target: 'café', target_index: null }), 'el cuarto')).toEqual([1, 4])
  })
})

describe('resolveTarget: time of day, "el otro", and a confident model pick', () => {
  // Cafés logged at 10:10, 11:11 and 11:52 (newest first), and a súper.
  const cafes = [
    row(5, 'café', { amount: '2700', time: '11:52' }),
    row(4, 'súper', { category: 'supermercado', time: '11:30' }),
    row(3, 'café', { amount: '2600', time: '11:11' }),
    row(2, 'café', { amount: '2400', time: '10:10' }),
  ]
  const fix = (text: string, pick: number | null = null, amount = '2500') =>
    found(
      {
        type: 'correct',
        target: 'café',
        target_index: pick,
        confidence: 'high',
        changes: {
          direction: null,
          amount,
          currency: null,
          date: null,
          description: null,
          category: null,
          payment: null,
        },
      } as never,
      text,
      cafes,
    )

  it('"de las 10" narrows to the café logged at 10:xx, not the newest', () => {
    expect(fix('el café de las 10 fueron 2500')).toBe(2)
    expect(fix('el café de las 11:11 fueron 2500')).toBe(3)
    expect(fix('el café a las 11 fue 2500')).toBe(5) // two at 11: the newest of them
    expect(fix('el café de las 11:52 fue 2500')).toBe(5)
  })

  it('parts of the day', () => {
    expect(fix('el café de esta mañana')).toBe(5) // all before noon: newest
    const mixed = [
      row(9, 'café', { time: '20:00' }),
      row(8, 'café', { time: '13:00' }),
      row(7, 'café', { time: '09:00' }),
    ]
    expect(found(del({ target: 'café' }), 'el café de la mañana', mixed)).toBe(7)
    expect(found(del({ target: 'café' }), 'el café de la tarde', mixed)).toBe(8)
    expect(found(del({ target: 'café' }), 'el café de la noche', mixed)).toBe(9)
    const yesterdayNight = [
      row(9, 'café', { time: '20:00' }),
      row(8, 'café', { time: '21:00', date: '2026-11-19' }),
    ]
    expect(found(del({ target: 'café' }), 'el café de anoche', yesterdayNight)).toBe(8)
  })

  it('"el otro café" is the second newest café', () => {
    expect(found(del({ target: 'café' }), 'el otro café fue 3000', cafes)).toBe(3)
    expect(found(del({ target: 'café' }), 'el anterior café', cafes)).toBe(3)
    expect(asked(del({ target: 'súper' }), 'el otro súper', cafes)).toEqual([2])
  })

  it('a confident pick among the named rows stands; a low-confidence one does not', () => {
    expect(fix('el café de la quinta', 4)).toBe(2) // number 4 is the 10:10 café
    expect(fix('el café de la quinta', 2)).toBe(5) // number 2 is the súper: not named, newest
    expect(
      found(
        del({ target: 'café', target_index: 4, confidence: 'low' }),
        'el café de la quinta',
        cafes,
      ),
    ).toBe(5)
  })

  it('"el último café" is the newest café whatever the model picked', () => {
    expect(found(del({ target: 'café', target_index: 4 }), 'el último café', cafes)).toBe(5)
  })
})
