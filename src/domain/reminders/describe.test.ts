import { describe, expect, it } from 'vitest'
import { describeSchedule, instantInWords } from './describe'
import { nextOccurrence, ScheduleSchema } from './schedule'

type Input = Parameters<typeof ScheduleSchema.parse>[0]
const at = (local: string) => new Date(`${local.replace(' ', 'T')}:00-03:00`)
/** Saturday 21 November 2026, 12:00: the schedule in words, with its first occurrence after that. */
const words = (input: Input, o: { since?: boolean; now?: string } = {}) => {
  const s = ScheduleSchema.parse(input)
  const now = at(o.now ?? '2026-11-21 12:00')
  const first = nextOccurrence(s, now)
  if (!first) throw new Error('no occurrence')
  return describeSchedule(s, first, '2026-11-21', o)
}

describe('describeSchedule', () => {
  it.each([
    [{ start: '2026-11-22', time: '08:00' }, 'mañana a las 08:00'],
    [{ start: '2026-11-21', time: '18:30' }, 'hoy a las 18:30'],
    [{ start: '2026-12-10' }, 'el jueves 10/12 a las 09:00'],
    [{ start: '2027-01-04' }, 'el lunes 04/01/27 a las 09:00'],
    [{ start: '2026-11-22', every: 'day' }, 'todos los días a las 09:00, desde mañana'],
    [{ start: '2026-11-22', every: 'day', interval: 15 }, 'cada 15 días a las 09:00, desde mañana'],
    [
      { start: '2026-11-21', every: 'week', weekdays: ['thu', 'mon'], time: '08:00' },
      'todos los lunes y jueves a las 08:00, desde el lunes 23/11',
    ],
    [
      { start: '2026-11-21', every: 'week', weekdays: ['mon', 'wed', 'fri'] },
      'todos los lunes, miércoles y viernes a las 09:00, desde el lunes 23/11',
    ],
    [
      { start: '2026-11-21', every: 'week', weekdays: ['sat'] },
      'todos los sábados a las 09:00, desde el sábado 28/11',
    ],
    [
      { start: '2026-11-21', every: 'week', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
      'de lunes a viernes a las 09:00, desde el lunes 23/11',
    ],
    [
      { start: '2026-11-21', every: 'week', interval: 2, weekdays: ['mon'] },
      'cada 2 semanas, los lunes a las 09:00, desde el lunes 30/11',
    ],
    [
      { start: '2026-11-01', every: 'month', month_days: [15, 1] },
      'el 1 y el 15 de cada mes a las 09:00, desde el martes 01/12',
    ],
    [
      { start: '2026-11-01', every: 'month', month_days: [-1] },
      'el último día de cada mes a las 09:00, desde el lunes 30/11',
    ],
    [
      { start: '2026-11-01', every: 'month', month_days: [5] },
      'el 5 de cada mes a las 09:00, desde el sábado 05/12',
    ],
    [
      { start: '2026-11-01', every: 'month', interval: 2, month_days: [10] },
      'cada 2 meses, el 10 a las 09:00, desde el domingo 10/01/27',
    ],
    [
      { start: '2026-11-01', every: 'month', nth: { n: 1, weekday: 'mon' } },
      'el primer lunes de cada mes a las 09:00, desde el lunes 07/12',
    ],
    [
      { start: '2026-11-01', every: 'month', nth: { n: -1, weekday: 'fri' } },
      'el último viernes de cada mes a las 09:00, desde el viernes 27/11',
    ],
    [
      { start: '2026-11-22', every: 'year', month: 4, month_days: [3] },
      'el 3 de abril de cada año a las 09:00, desde el sábado 03/04/27',
    ],
    [
      { start: '2026-11-22', every: 'day', until: '2026-12-31' },
      'todos los días a las 09:00, desde mañana, hasta el 31/12',
    ],
    [
      { start: '2026-11-22', every: 'day', count: 3 },
      'todos los días a las 09:00, desde mañana, 3 veces',
    ],
  ] as [Input, string][])('%j is "%s"', (input, expected) => {
    expect(words(input)).toBe(expected)
  })

  it('a repeated schedule that happens once is a one-off', () => {
    expect(words({ start: '2026-11-21', every: 'month', month_days: [10], count: 1 })).toBe(
      'el jueves 10/12 a las 09:00',
    )
  })

  it('leaves out "desde" for a list', () => {
    expect(words({ start: '2026-11-22', every: 'week', weekdays: ['mon'] }, { since: false })).toBe(
      'todos los lunes a las 09:00',
    )
  })

  it('says an instant in Argentine time', () => {
    expect(instantInWords(new Date('2026-11-23T12:00:00Z'), '2026-11-21')).toBe(
      'el lunes 23/11 a las 09:00',
    )
  })
})
