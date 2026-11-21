import { describe, expect, it } from 'vitest'
import { gradeTurn, moneyTokens, type Row, type TurnInput } from './grade'
import { type Turn, TurnSchema } from './schema'

const row = (id: number, o: Partial<Row> = {}): Row => ({
  id,
  amount: '3500',
  date: '2026-11-21',
  description: 'café',
  category: 'restaurantes',
  payment: null,
  direction: 'out',
  currency: 'ARS',
  supersededBy: null,
  deleted: false,
  ...o,
})

const turn = (o: Partial<Turn> & { text?: string } = {}): Turn =>
  TurnSchema.parse({ now: '2026-11-21T12:00', text: 'x', ...o })

const grade = (o: Partial<TurnInput> & Pick<TurnInput, 'turn' | 'before' | 'after' | 'reply'>) =>
  gradeTurn({
    today: '2026-11-21',
    refs: new Map([
      ['a', 1],
      ['b', 2],
    ]),
    failed: false,
    commandType: null,
    ...o,
  })

// 1 = café 3500, 2 = súper 12000
const before = [row(1), row(2, { description: 'súper', amount: '12000', category: 'supermercado' })]

describe('gradeTurn: corrections', () => {
  const t = turn({ ops: [{ op: 'correct', ref: 'a', set: { amount: '2500' } }] })

  it('passes the right row with the right value', () => {
    const after = [row(1, { supersededBy: 3 }), before[1] as Row, row(3, { amount: '2500' })]
    const g = grade({ turn: t, before, after, reply: '✓ Corregido: Café $2.500 (antes $3.500)' })
    expect(g.problems).toEqual([])
    expect(g.ok).toBe(true)
    expect(g.refs.get('a')).toBe(3)
  })

  it('a wrong row changed under a ✓ reply is a silent wrong change', () => {
    const after = [
      before[0] as Row,
      row(2, { supersededBy: 3, description: 'súper', amount: '12000' }),
      row(3, { description: 'súper', amount: '2500', category: 'supermercado' }),
    ]
    const g = grade({ turn: t, before, after, reply: '✓ Corregido: Súper $2.500 (antes $12.000)' })
    expect(g.ok).toBe(false)
    expect(g.silentWrong).toBe(true)
    expect(g.problems.join(' ')).toContain('which must stay as it was')
  })

  it('the right row with a wrong amount is a silent wrong change', () => {
    const after = [row(1, { supersededBy: 3 }), before[1] as Row, row(3, { amount: '25000' })]
    const g = grade({ turn: t, before, after, reply: '✓ Corregido: Café $25.000 (antes $3.500)' })
    expect(g.silentWrong).toBe(true)
    expect(g.problems.join(' ')).toContain('amount 25000, expected 2500')
  })

  it('a correction that changes another field too is wrong', () => {
    const after = [
      row(1, { supersededBy: 3 }),
      before[1] as Row,
      row(3, { amount: '2500', payment: 'efectivo' }),
    ]
    const g = grade({ turn: t, before, after, reply: '✓ Corregido: Café $2.500 (efectivo)' })
    expect(g.silentWrong).toBe(true)
  })

  it('a question instead of the change is unnecessary, not silent', () => {
    const g = grade({
      turn: t,
      before,
      after: before,
      reply: '¿Cuál? 1. Café $3.500 · 2. Súper $12.000',
    })
    expect(g.ok).toBe(false)
    expect(g.unnecessaryQuestion).toBe(true)
    expect(g.silentWrong).toBe(false)
  })

  it('no change at all with a ✓ reply is not a wrong write', () => {
    const g = grade({ turn: t, before, after: before, reply: 'Ya figura así: Café $3.500' })
    expect(g.wrongWrite).toBe(false)
    expect(g.ok).toBe(false)
  })
})

describe('gradeTurn: deletes and asks', () => {
  it('passes the right delete', () => {
    const t = turn({ ops: [{ op: 'delete', ref: 'b' }] })
    const after = [before[0] as Row, { ...(before[1] as Row), deleted: true }]
    const g = grade({ turn: t, before, after, reply: '✓ Borré: Súper $12.000' })
    expect(g.ok).toBe(true)
    expect(g.refs.has('b')).toBe(false)
  })

  it('deleting when the scenario wants a question is a silent wrong change', () => {
    const t = turn({ ask: true })
    const after = [{ ...(before[0] as Row), deleted: true }, before[1] as Row]
    const g = grade({ turn: t, before, after, reply: '✓ Borré: Café $3.500' })
    expect(g.silentWrong).toBe(true)
    expect(g.problems).toContain('the reply should be a question')
  })

  it('passes a question that changes nothing', () => {
    const t = turn({ ask: true, reply: { has: ['$3.500'], any: [], not: ['Corregido'] } })
    const g = grade({
      turn: t,
      before,
      after: before,
      reply: '¿Cuál café y qué cambio? 1. Café $3.500',
    })
    expect(g.ok).toBe(true)
  })
})

describe('gradeTurn: logs', () => {
  const t = turn({
    ops: [
      {
        op: 'log',
        movements: [
          {
            ref: 'n',
            amount: '3500',
            description: 'café',
            direction: 'out',
            currency: 'ARS',
            payment: null,
          },
        ],
      },
    ],
  })

  it('passes a log with a loose description and names the ref', () => {
    const g = grade({
      turn: t,
      before: [],
      after: [row(5, { description: 'cafecito' })],
      reply: '✓ Cafecito $3.500',
    })
    expect(g.ok).toBe(true)
    expect(g.refs.get('n')).toBe(5)
  })

  it('a wrong amount is a silent wrong change', () => {
    const g = grade({
      turn: t,
      before: [],
      after: [row(5, { amount: '35000' })],
      reply: '✓ Café $35.000',
    })
    expect(g.silentWrong).toBe(true)
  })

  it('a payment nobody said is wrong', () => {
    const g = grade({
      turn: t,
      before: [],
      after: [row(5, { payment: 'efectivo' })],
      reply: '✓ Café $3.500 (efectivo)',
    })
    expect(g.silentWrong).toBe(true)
  })

  it('the date defaults to the day of the turn', () => {
    const g = grade({
      turn: t,
      before: [],
      after: [row(5, { date: '2026-11-20' })],
      reply: '✓ Café $3.500 · ayer',
    })
    expect(g.silentWrong).toBe(true)
  })

  it('a missing movement fails without being a wrong write', () => {
    const two = turn({
      ops: [
        {
          op: 'log',
          movements: [
            {
              amount: '3500',
              description: 'café',
              direction: 'out',
              currency: 'ARS',
              payment: null,
            },
            {
              amount: '900',
              description: 'subte',
              direction: 'out',
              currency: 'ARS',
              payment: null,
            },
          ],
        },
      ],
    })
    const g = grade({ turn: two, before: [], after: [row(5)], reply: '✓ Café $3.500' })
    expect(g.ok).toBe(false)
    expect(g.wrongWrite).toBe(false)
    expect(g.problems.join(' ')).toContain('missing movement subte 900')
  })
})

describe('gradeTurn: the reply', () => {
  it('checks has, any, not and re, ignoring accents and case', () => {
    const t = turn({
      reply: { has: ['CORREGIDO'], any: ['cual', 'otra'], not: ['borre'], re: 'antes \\$3\\.500' },
    })
    const ok = grade({ turn: t, before, after: before, reply: '¿Cuál? Corregido (antes $3.500)' })
    expect(ok.problems).toEqual([])
    const bad = grade({ turn: t, before, after: before, reply: 'Borré. Corregido (antes algo)' })
    expect(bad.problems).toHaveLength(3)
  })

  it('flags an amount in the reply that no movement has', () => {
    const g = grade({ turn: turn(), before, after: before, reply: 'Ya figura así: Café $3.600' })
    expect(g.invented).toEqual(['$3.600'])
    expect(g.ok).toBe(false)
  })

  it('does not call an amount invented when the person wrote it in this message', () => {
    const t = turn({ text: 'cambiame lo del almuerzo a 5000' })
    expect(
      grade({ turn: t, before, after: before, reply: '¿Cuál cambio a $5.000?' }).invented,
    ).toEqual([])
    expect(
      grade({ turn: t, before, after: before, reply: '¿Cuál cambio a $5.001?' }).invented,
    ).toEqual(['$5.001'])
  })

  it('leaves a query answer to the scenario text', () => {
    const t = turn({ reply: { has: ['$15.500'], any: [], not: [] } })
    const g = grade({
      turn: t,
      before,
      after: before,
      reply: 'Hoy gastaste $15.500 (2 movimientos).',
      commandType: 'query',
    })
    expect(g.ok).toBe(true)
  })

  it('a failure notice fails the turn', () => {
    const g = grade({
      turn: turn(),
      before,
      after: before,
      reply: 'No pude procesar tu mensaje.',
      failed: true,
    })
    expect(g.ok).toBe(false)
  })

  it('refuses a scenario that points at a movement that is not live', () => {
    const t = turn({ ops: [{ op: 'delete', ref: 'zz' }] })
    expect(() => grade({ turn: t, before, after: before, reply: '' })).toThrow('scenario bug')
  })
})

describe('moneyTokens', () => {
  it('reads pesos and dollars, not the dollar sign inside US$', () => {
    expect(moneyTokens('✓ Cena US$ 50 (antes $3.500). Y $8.500,50')).toEqual([
      'US$ 50',
      '$3.500',
      '$8.500,50',
    ])
  })
})
