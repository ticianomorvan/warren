import type { z } from 'zod'
import type { Outcome } from '../src/core/apply'
import type { Category } from '../src/core/commands'
import type { View } from '../src/core/describe'
import type { Undone } from '../src/core/history'
import type { FactRow } from '../src/domain/facts'
import type { MovementRow } from '../src/domain/movements'
import type { ReminderRow } from '../src/domain/reminders/db'
import { ScheduleSchema } from '../src/domain/reminders/schedule'

/**
 * The outcomes the golden test renders: a fixed set that spans every write tool and every status, plus the lines code says that are
 * not writes. `view` is the message's day (2026-11-20, a Friday) and the newest live movement. The strings v1 rendered for the same
 * situations are in `golden/v1-replies.json` (captured from v1's own render code by `src/golden-v1.test.ts`).
 */

export const TODAY = '2026-11-20'

type Rest<T> = Partial<T>
let version = 0
export const movement = (o: Rest<MovementRow> & Pick<MovementRow, 'id'>): MovementRow => ({
  version: ++version,
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: TODAY,
  description: 'café',
  category: 'restaurantes' as Category,
  payment: null,
  confidence: 'high',
  time: '11:11',
  loggedAt: new Date('2026-11-20T14:11:00Z'),
  ...o,
})
export const fact = (o: Rest<FactRow> & Pick<FactRow, 'id'>): FactRow => ({
  version: ++version,
  kind: 'note',
  key: 'cobro',
  value: 'el 5',
  loggedAt: new Date('2026-11-20T14:11:00Z'),
  ...o,
})
const at = (local: string) => new Date(`${local.replace(' ', 'T')}:00-03:00`)
export const reminder = (
  o: Omit<Rest<ReminderRow>, 'schedule'> &
    Pick<ReminderRow, 'id'> & { schedule: z.input<typeof ScheduleSchema> },
): ReminderRow => ({
  version: ++version,
  what: 'pagar la Visa',
  nextDueAt: at('2026-12-10 09:00'),
  loggedAt: new Date('2026-11-20T14:11:00Z'),
  ...o,
  schedule: ScheduleSchema.parse(o.schedule),
})

const cafe = movement({ id: 1 })
const nafta = movement({
  id: 2,
  description: 'nafta YPF',
  amount: '20000',
  category: 'combustible',
  payment: 'crédito visa',
  date: '2026-11-19',
  time: '09:30',
})
const sueldo = movement({
  id: 3,
  description: 'sueldo',
  direction: 'in',
  amount: '850000.50',
  category: 'sueldo',
  date: '2026-11-05',
})
const dolares = movement({
  id: 4,
  description: 'viaje',
  currency: 'USD',
  amount: '120',
  category: 'viajes',
  date: '2025-12-28',
  confidence: 'low',
})
const visa = fact({ id: 7, kind: 'alias', key: 'la visa', value: 'crédito galicia' })
const cafeRule = fact({ id: 8, kind: 'category', key: 'café', value: 'entretenimiento' })
const cobro = fact({ id: 9 })
const pagoVisa = reminder({ id: 3, schedule: { start: '2026-12-10', time: '09:00' } })

export interface Case {
  name: string
  outcome: Outcome
  view?: View
}
export const view: View = { today: TODAY, newest: 1 }
export const viewNoNewest: View = { today: TODAY, newest: null }

const log = (name: string, ...movements: MovementRow[]): Case => ({
  name,
  outcome: { tool: 'log_movements', status: 'applied', effect: 'logged', movements },
})

export const CASES: Case[] = [
  log('log one', cafe),
  log('log one low confidence', movement({ id: 5, confidence: 'low', amount: '15' })),
  log('log one income in another year', sueldo),
  log('log one dollars, a year ago', dolares),
  log('log several, a payment, yesterday, a date this year', cafe, nafta, sueldo, dolares),
  {
    name: 'correct gone',
    outcome: { tool: 'correct_movement', status: 'gone', effect: null, id: 9 },
  },
  {
    name: 'correct unchanged',
    outcome: { tool: 'correct_movement', status: 'unchanged', effect: null, old: nafta },
  },
  {
    name: 'correct money, the newest',
    outcome: {
      tool: 'correct_movement',
      status: 'applied',
      effect: 'corrected',
      old: cafe,
      next: movement({ id: 1, amount: '3800' }),
      changed: ['money'],
    },
  },
  {
    name: 'correct money and payment, not the newest (shows the time)',
    outcome: {
      tool: 'correct_movement',
      status: 'applied',
      effect: 'corrected',
      old: nafta,
      next: movement({ ...nafta, amount: '21000.50', payment: 'efectivo' }),
      changed: ['money', 'payment'],
    },
  },
  {
    name: 'correct date to today is spelled out',
    outcome: {
      tool: 'correct_movement',
      status: 'applied',
      effect: 'corrected',
      old: nafta,
      next: movement({ ...nafta, date: TODAY }),
      changed: ['date'],
    },
  },
  {
    name: 'correct date to another day and category',
    outcome: {
      tool: 'correct_movement',
      status: 'applied',
      effect: 'corrected',
      old: cafe,
      next: movement({ id: 1, date: '2026-11-03', category: 'entretenimiento' }),
      changed: ['date', 'category'],
    },
  },
  {
    name: 'correct description and drop the payment',
    outcome: {
      tool: 'correct_movement',
      status: 'applied',
      effect: 'corrected',
      old: nafta,
      next: movement({ ...nafta, description: 'nafta shell', payment: null }),
      changed: ['description', 'payment'],
    },
  },
  {
    name: 'correct direction to income',
    outcome: {
      tool: 'correct_movement',
      status: 'applied',
      effect: 'corrected',
      old: cafe,
      next: movement({ id: 1, direction: 'in' }),
      changed: ['money'],
    },
  },
  {
    name: 'delete gone',
    outcome: { tool: 'delete_movement', status: 'gone', effect: null, id: 9 },
  },
  {
    name: 'delete the newest',
    outcome: { tool: 'delete_movement', status: 'applied', effect: 'deleted', old: cafe },
  },
  {
    name: 'delete not the newest, another day',
    outcome: { tool: 'delete_movement', status: 'applied', effect: 'deleted', old: nafta },
  },
  { name: 'undo nothing', outcome: { tool: 'undo_last', status: 'nothing', effect: null } },
  { name: 'undo expired', outcome: { tool: 'undo_last', status: 'expired', effect: null } },
  undone('undo one log', [{ kind: 'logged', movement: cafe }]),
  undone('undo several logs', [
    { kind: 'logged', movement: cafe },
    { kind: 'logged', movement: nafta },
    { kind: 'logged', movement: sueldo },
  ]),
  undone('undo a correction', [
    { kind: 'corrected', from: movement({ id: 1, amount: '3800' }), to: cafe },
  ]),
  undone('undo a correction of date, category and payment', [
    {
      kind: 'corrected',
      from: movement({ ...nafta, date: TODAY, category: 'otros', payment: null }),
      to: nafta,
    },
  ]),
  undone('undo a delete', [{ kind: 'deleted', movement: nafta }]),
  undone('undo a mixed turn', [
    { kind: 'logged', movement: cafe },
    { kind: 'corrected', from: movement({ id: 2, amount: '1' }), to: nafta },
    { kind: 'deleted', movement: sueldo },
  ]),
  undone('undo facts', [
    { kind: 'fact_removed', fact: cobro },
    { kind: 'fact_reverted', fact: visa, was: 'crédito santander' },
    { kind: 'fact_reverted', fact: cafeRule, was: 'restaurantes' },
    { kind: 'fact_restored', fact: cafeRule },
  ]),
  undone('undo reminders', [
    { kind: 'reminder_removed', reminder: pagoVisa },
    {
      kind: 'reminder_restored',
      reminder: reminder({
        id: 4,
        what: 'tomar la pastilla',
        schedule: { start: '2026-11-21', every: 'week', weekdays: ['mon', 'thu'], time: '08:00' },
        nextDueAt: at('2026-11-23 08:00'),
      }),
    },
  ]),
  {
    name: 'remember a new alias',
    outcome: { tool: 'remember_fact', status: 'applied', effect: 'remembered', fact: visa },
  },
  {
    name: 'remember a category rule',
    outcome: { tool: 'remember_fact', status: 'applied', effect: 'remembered', fact: cafeRule },
  },
  {
    name: 'remember a note',
    outcome: { tool: 'remember_fact', status: 'applied', effect: 'remembered', fact: cobro },
  },
  {
    name: 'remember an update',
    outcome: {
      tool: 'remember_fact',
      status: 'applied',
      effect: 'remembered',
      fact: visa,
      before: 'crédito santander',
    },
  },
  {
    name: 'remember a category update',
    outcome: {
      tool: 'remember_fact',
      status: 'applied',
      effect: 'remembered',
      fact: cafeRule,
      before: 'restaurantes',
    },
  },
  {
    name: 'remember unchanged',
    outcome: { tool: 'remember_fact', status: 'unchanged', effect: null, fact: visa },
  },
  {
    name: 'remember full',
    outcome: { tool: 'remember_fact', status: 'full', effect: null, max: 100 },
  },
  {
    name: 'forget one',
    outcome: { tool: 'forget_fact', status: 'applied', effect: 'forgotten', facts: [visa] },
  },
  {
    name: 'forget several',
    outcome: {
      tool: 'forget_fact',
      status: 'applied',
      effect: 'forgotten',
      facts: [visa, cafeRule, cobro],
    },
  },
  {
    name: 'forget by id gone',
    outcome: { tool: 'forget_fact', status: 'gone', effect: null, target: { id: 7 } },
  },
  {
    name: 'forget by key gone',
    outcome: { tool: 'forget_fact', status: 'gone', effect: null, target: { key: 'la visa' } },
  },
  {
    name: 'forget all',
    outcome: {
      tool: 'forget_all_confirmed',
      status: 'applied',
      effect: 'forgotten',
      facts: [visa, cafeRule, cobro],
    },
  },
  {
    name: 'forget all with nothing',
    outcome: { tool: 'forget_all_confirmed', status: 'nothing', effect: null },
  },
  {
    name: 'remind a one-off, today',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        what: 'llamar al médico',
        schedule: { start: TODAY, time: '15:00' },
        nextDueAt: at('2026-11-20 15:00'),
      }),
    },
  },
  {
    name: 'remind a one-off, tomorrow, text ending in a stop',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        what: '¡sacar la basura!',
        schedule: { start: '2026-11-21', time: '21:30' },
        nextDueAt: at('2026-11-21 21:30'),
      }),
    },
  },
  {
    name: 'remind a one-off, two digits of day',
    outcome: { tool: 'set_reminder', status: 'applied', effect: 'reminded', reminder: pagoVisa },
  },
  {
    name: 'remind a one-off, one digit of day',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        schedule: { start: '2026-12-05' },
        nextDueAt: at('2026-12-05 09:00'),
      }),
    },
  },
  {
    name: 'remind a one-off, next year',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        schedule: { start: '2027-01-04' },
        nextDueAt: at('2027-01-04 09:00'),
      }),
    },
  },
  {
    name: 'remind every day',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        what: 'tomar agua',
        schedule: { start: '2026-11-21', every: 'day', time: '10:00' },
        nextDueAt: at('2026-11-21 10:00'),
      }),
    },
  },
  {
    name: 'remind on weekdays, with an end',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        what: 'standup',
        schedule: {
          start: '2026-11-23',
          every: 'week',
          weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
          time: '09:30',
          until: '2026-12-04',
        },
        nextDueAt: at('2026-11-23 09:30'),
      }),
    },
  },
  {
    name: 'remind every two weeks, a count',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        what: 'regar',
        schedule: { start: '2026-11-30', every: 'week', interval: 2, weekdays: ['mon'], count: 3 },
        nextDueAt: at('2026-11-30 09:00'),
      }),
    },
  },
  {
    name: 'remind monthly on two days',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        what: 'pagar el alquiler',
        schedule: { start: '2026-12-01', every: 'month', month_days: [15, 1] },
        nextDueAt: at('2026-12-01 09:00'),
      }),
    },
  },
  {
    name: 'remind on the nth weekday and the last day',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        what: 'reunión',
        schedule: { start: '2026-12-07', every: 'month', nth: { n: 1, weekday: 'mon' } },
        nextDueAt: at('2026-12-07 09:00'),
      }),
    },
  },
  {
    name: 'remind every year',
    outcome: {
      tool: 'set_reminder',
      status: 'applied',
      effect: 'reminded',
      reminder: reminder({
        id: 3,
        what: 'cumple de mamá',
        schedule: { start: '2027-03-12', every: 'year' },
        nextDueAt: at('2027-03-12 09:00'),
      }),
    },
  },
  { name: 'remind full', outcome: { tool: 'set_reminder', status: 'full', effect: null, max: 20 } },
  { name: 'remind past', outcome: { tool: 'set_reminder', status: 'past', effect: null } },
  {
    name: 'cancel one',
    outcome: {
      tool: 'cancel_reminder',
      status: 'applied',
      effect: 'unreminded',
      reminder: pagoVisa,
    },
  },
  {
    name: 'cancel a repeating one',
    outcome: {
      tool: 'cancel_reminder',
      status: 'applied',
      effect: 'unreminded',
      reminder: reminder({
        id: 4,
        what: 'tomar la pastilla',
        schedule: { start: '2026-11-21', every: 'week', weekdays: ['mon', 'thu'], time: '08:00' },
        nextDueAt: at('2026-11-23 08:00'),
      }),
    },
  },
  {
    name: 'cancel gone',
    outcome: { tool: 'cancel_reminder', status: 'gone', effect: null, id: 3 },
  },
]

function undone(name: string, items: Undone[]): Case {
  return {
    name,
    outcome: { tool: 'undo_last', status: 'applied', effect: 'undone', turn: 5, items },
  }
}

/** The lines code says that are not a write's outcome: lists, questions, declines. */
export const SAID = {
  facts: [visa, cafeRule, cobro],
  reminders: [
    pagoVisa,
    reminder({
      id: 4,
      what: 'tomar la pastilla',
      schedule: { start: '2026-11-21', every: 'week', weekdays: ['mon', 'thu'], time: '08:00' },
      nextDueAt: at('2026-11-23 08:00'),
    }),
    reminder({
      id: 5,
      what: 'llamar al médico',
      schedule: { start: TODAY, time: '15:00' },
      nextDueAt: at('2026-11-20 15:00'),
    }),
  ],
  options: [cafe, nafta, movement({ id: 6, description: 'café', date: TODAY, time: '08:15' })],
  alike: [movement({ id: 1, time: '08:15' }), movement({ id: 6, time: '11:11' }), nafta],
  one: nafta,
}
