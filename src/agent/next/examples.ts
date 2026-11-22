import type { z } from 'zod'
import type { COMMANDS, Input, Tool } from '../../core/commands'

/**
 * The prompt's examples, as typed data: every call is checked against its tool's schema by a test (`prompt.test.ts`) and the prompt
 * renders them with `renderExamples`. A movement's list line is `[id, direction, amount, date, time, description, category, payment]`.
 */
type Row = [number, 'in' | 'out', string, string, string, string, string, string]

/** A call of an example, typed by its tool. */
type Say = { [T in Tool]: { tool: T; input: z.input<(typeof COMMANDS)[T]['input']> } }[Tool]

export interface Example {
  list?: Row[]
  facts?: string
  reminders?: string[]
  conversation?: string
  pending?: string
  message: string
  /** Said between the message and the calls, in the prompt's words (never part of the model's input). */
  note?: string
  /** The calls of a search turn, then what the search returned, then the calls of the next turn. */
  search?: { call: Say; result: string }
  calls: Say[]
}

const call = <T extends Tool>(
  tool: T,
  input: Input<T> | z.input<(typeof COMMANDS)[T]['input']>,
): Say => ({ tool, input }) as Say

const mv = (
  amount: string,
  description: string,
  category: string,
  o: {
    date?: string
    direction?: 'in' | 'out'
    currency?: 'ARS' | 'USD'
    payment?: string
    low?: boolean
  } = {},
) => ({
  direction: o.direction ?? 'out',
  amount,
  currency: o.currency ?? 'ARS',
  date: o.date ?? '<today>',
  description,
  category,
  ...(o.payment ? { payment: o.payment } : {}),
  confidence: o.low ? 'low' : 'high',
})
// biome-ignore lint/suspicious/noExplicitAny: the shape is checked against the registry's schema by the examples test
const log = (...m: any[]) => call('log_movements', { movements: m } as never)
const correct = (id: number, changes: object) => call('correct_movement', { id, changes } as never)
const del = (id: number) => call('delete_movement', { id })
const range = (period: string, o: object = {}) => ({ range: { period }, ...o })
const summarize = (input: object) => call('summarize', input as never)
const remind = (input: object) => call('set_reminder', input as never)

const CAFE: Row = [905, 'out', '2900', '<today>', '11:40', 'café', 'restaurantes', 'sin medio']
const SUPER: Row = [
  904,
  'out',
  '15400',
  '<yesterday>',
  '10:20',
  'súper',
  'supermercado',
  'crédito visa',
]
const FARMACIA: Row = [
  903,
  'out',
  '6200',
  '<2 days ago>',
  '09:05',
  'farmacia',
  'salud',
  'sin medio',
]
const C930: Row = [930, 'out', '2400', '<today>', '11:40', 'café', 'restaurantes', 'sin medio']
const C929: Row = [929, 'out', '7300', '<today>', '10:55', 'cena', 'restaurantes', 'débito']

export const EXAMPLES: Example[] = [
  { message: 'cafecito 2800', calls: [log(mv('2800', 'café', 'restaurantes'))] },
  {
    message: 'super 12.000 con la visa y 4.500 de farmacia',
    calls: [
      log(
        mv('12000', 'súper', 'supermercado', { payment: 'crédito visa' }),
        mv('4500', 'farmacia', 'salud'),
      ),
    ],
  },
  {
    message: 'ayer 20 lucas de nafta en efectivo',
    calls: [log(mv('20000', 'nafta', 'combustible', { date: '<yesterday>', payment: 'efectivo' }))],
  },
  {
    message: 'me salio 1,5 palos el service del auto, pague con transfe',
    calls: [log(mv('1500000', 'service del auto', 'otros', { payment: 'transferencia' }))],
  },
  {
    message: 'cobre el sueldo 1.850.000',
    calls: [log(mv('1850000', 'sueldo', 'sueldo', { direction: 'in' }))],
  },
  {
    message: 'le pase 30 lucas a mi hermana por mp',
    calls: [
      log(mv('30000', 'transferencia a mi hermana', 'transferencias', { payment: 'mercado pago' })),
    ],
  },
  {
    message: 'compre 50 usd para ahorrar el lunes',
    calls: [
      log(
        mv('50', 'compra de dólares', 'otros', {
          currency: 'USD',
          date: '<the last Monday in the calendar>',
        }),
      ),
    ],
  },
  {
    message: 'Pedro me devolvió 8k de la cena',
    calls: [log(mv('8000', 'devolución de Pedro', 'otros_ingresos', { direction: 'in' }))],
  },
  {
    message: 'pagué 3,5k de colectivo y 2.800,50 de kiosco anteayer',
    calls: [
      log(
        mv('3500', 'colectivo', 'transporte', { date: '<two days ago>' }),
        mv('2800.50', 'kiosco', 'restaurantes', { date: '<two days ago>' }),
      ),
    ],
  },
  {
    message: 'gaste 40 en el chino',
    calls: [log(mv('40', 'chino', 'supermercado', { low: true }))],
  },
  {
    message: 'unos 15 mil de luz mas o menos',
    calls: [log(mv('15000', 'luz', 'servicios', { low: true }))],
  },
  {
    message: 'abl 85 mil y expensas 210.500 el 3',
    calls: [
      log(
        mv('85000', 'ABL', 'impuestos', { date: '<the 3rd of this month>' }),
        mv('210500', 'expensas', 'vivienda', { date: '<the 3rd of this month>' }),
      ),
    ],
  },
  {
    message: 'teatro 20k pasado manana',
    calls: [log(mv('20000', 'teatro', 'entretenimiento', { low: true }))],
  },
  {
    list: [CAFE, SUPER],
    message: 'uy no, el cafe fueron 4200',
    calls: [correct(905, { amount: '4200' })],
  },
  {
    list: [CAFE, SUPER],
    message: 'cambia lo del super a ayer',
    calls: [correct(904, { date: '<yesterday>' })],
  },
  {
    list: [CAFE, SUPER],
    message: 'eso fue con la master y ayer',
    calls: [correct(905, { date: '<yesterday>', payment: 'crédito mastercard' })],
  },
  {
    list: [
      [912, 'out', '15400', '<today>', '11:40', 'súper', 'supermercado', 'crédito visa'],
      [911, 'out', '7300', '<today>', '10:55', 'cena', 'restaurantes', 'débito'],
      [910, 'out', '6800', '<2 days ago>', '09:30', 'súper', 'supermercado', 'efectivo'],
    ],
    message: 'el super que pague en efectivo era 8500',
    calls: [correct(910, { amount: '8500' })],
  },
  {
    list: [CAFE, SUPER, FARMACIA],
    message: 'saca lo de la farmacia y borra lo ultimo que puse',
    calls: [del(903), del(905)],
  },
  {
    list: [CAFE, SUPER],
    message: 'elimina el 2 y el cafe fue 3100, ah y anote subte 800',
    calls: [del(904), correct(905, { amount: '3100' }), log(mv('800', 'subte', 'transporte'))],
  },
  {
    list: [
      [940, 'out', '4000', '<today>', '12:30', 'helado', 'restaurantes', 'sin medio'],
      [939, 'out', '9000', '<today>', '11:00', 'farmacia', 'salud', 'sin medio'],
      [938, 'out', '2000', '<today>', '10:00', 'kiosco', 'restaurantes', 'sin medio'],
    ],
    message: 'el 2 lucas fue 2200',
    calls: [correct(938, { amount: '2200' })],
  },
  {
    list: [
      C930,
      C929,
      [928, 'out', '2700', '<2 days ago>', '09:05', 'café', 'restaurantes', 'efectivo'],
    ],
    message: 'el cafe de las 9 eran 2600',
    calls: [correct(928, { amount: '2600' })],
  },
  {
    list: [C930, C929],
    message: 'el gimnasio fue 19000  (no está en la lista)',
    search: {
      call: call('find_movements', { text: 'gimnasio', limit: 5 }),
      result: 'id=811 out 18000 ARS <2 months ago> 18:00 gimnasio [entretenimiento] (sin medio)',
    },
    calls: [correct(811, { amount: '19000' })],
  },
  {
    list: [C930, C929],
    message: 'el seguro del auto eran 45 mil',
    search: {
      call: call('find_movements', { text: 'seguro', limit: 5 }),
      result: 'id=640 out 40000 ARS <20 days ago> 09:00 seguro del auto [servicios] (débito)',
    },
    calls: [correct(640, { amount: '45000' })],
  },
  {
    list: [CAFE, SUPER, FARMACIA],
    message: 'borrá lo del taxi  (nothing fits, and find_movements found nothing)',
    calls: [call('ask_user', { movement_ids: [905, 904, 903], then: { do: 'delete' } })],
  },
  {
    list: [CAFE],
    message: 'me equivoque en el cafe',
    calls: [call('ask_user', { movement_ids: [905], then: { do: 'ask_change' } })],
  },
  {
    list: [],
    message: 'borra lo ultimo',
    calls: [call('reply', { text: 'Todavía no tenés movimientos anotados.' })],
  },
  {
    pending: 'Pregunta pendiente: 1 = id 905, 2 = id 904 (la persona pidió borrar)',
    message: 'dale, el 2 fue 3000',
    calls: [correct(904, { amount: '3000' })],
  },
  {
    list: [CAFE],
    conversation: '(persona) café 2900 / (Warren) ✓ Café $2.900',
    message: '3',
    calls: [call('help', {})],
  },
  {
    conversation:
      '(persona) super 12.000 y farmacia 4.500 / (Warren) ✓ Anoté 2: • Súper $12.000 • Farmacia $4.500',
    message: 'no, eso no',
    calls: [call('undo_last', {})],
  },
  { list: [CAFE, SUPER], message: 'deshacé el cafe', calls: [del(905)] },
  {
    message: 'deshacé todo',
    calls: [
      call('reply', {
        text: 'Puedo deshacer de a un paso: decime «deshacer» y vuelvo atrás lo último.',
      }),
    ],
  },
  {
    message: 'la visa es la del galicia',
    calls: [call('remember_fact', { kind: 'alias', key: 'la del galicia', value: 'la visa' })],
  },
  {
    message: 'acordate que los cafes van en entretenimiento',
    calls: [call('remember_fact', { kind: 'category', key: 'cafe', value: 'entretenimiento' })],
  },
  {
    message: 'cobro el 5 de cada mes',
    calls: [call('remember_fact', { kind: 'note', key: 'cobro', value: 'el 5 de cada mes' })],
  },
  {
    message: 'pago el gimnasio a principio de mes',
    calls: [call('remember_fact', { kind: 'note', key: 'gimnasio', value: 'a principio de mes' })],
  },
  {
    message: 'anota 8000 en la cueva, que es la verduleria',
    calls: [
      log(mv('8000', 'verdulería', 'supermercado')),
      call('remember_fact', { kind: 'alias', key: 'la cueva', value: 'verdulería' }),
    ],
  },
  {
    facts: 'id=3 alias "la del galicia" = "la visa"',
    message: 'super 9500 con la del galicia',
    calls: [log(mv('9500', 'súper', 'supermercado', { payment: 'crédito visa' }))],
  },
  {
    facts: 'id=4 categoría "cafe" → entretenimiento',
    message: 'cafe 3000',
    calls: [log(mv('3000', 'café', 'entretenimiento'))],
  },
  {
    message:
      'un cafe 2600 (no "Hechos": only a fact changes where a thing goes, so the default category stands)',
    calls: [log(mv('2600', 'café', 'restaurantes'))],
  },
  {
    facts: 'id=3 alias "la del galicia" = "la visa"',
    message: 'olvidate de lo de la visa',
    calls: [call('forget_fact', { target: { id: 3 } })],
  },
  { message: 'quiero que te olvides de todo lo mio', calls: [call('forget_all_facts', {})] },
  { message: 'que sabes de mi?', calls: [call('list_facts', {})] },
  {
    message: 'recordame pagar la visa el 10',
    calls: [remind({ what: 'pagar la Visa', first: { month_day: 10 } })],
  },
  {
    message: 'todos los lunes y jueves recordame la pastilla a las 8',
    calls: [
      remind({
        what: 'la pastilla',
        first: { weekday: 'mon', time: '08:00' },
        every: 'week',
        weekdays: ['mon', 'thu'],
      }),
    ],
  },
  {
    message: 'avisame cada 15 dias de regar las plantas',
    calls: [
      remind({
        what: 'regar las plantas',
        first: { in: { n: 15, unit: 'days' } },
        every: 'day',
        interval: 15,
      }),
    ],
  },
  {
    message: 'el ultimo dia de cada mes recordame pasar los gastos a la planilla',
    calls: [
      remind({
        what: 'pasar los gastos a la planilla',
        first: { day: 'today' },
        every: 'month',
        month_days: [-1],
      }),
    ],
  },
  {
    message: 'mañana a las 18 recordame llamar al medico',
    calls: [remind({ what: 'llamar al médico', first: { day: 'tomorrow', time: '18:00' } })],
  },
  {
    message: 'en 20 minutos recordame sacar la ropa',
    calls: [remind({ what: 'sacar la ropa', first: { in: { n: 20, unit: 'minutes' } } })],
  },
  {
    reminders: [
      'id=4 "pagar el alquiler" — el 5 de cada mes a las 09:00 (próximo: el sábado 5/12 a las 09:00)',
    ],
    message: 'cancela el del alquiler',
    calls: [call('cancel_reminder', { id: 4 })],
  },
  {
    reminders: [
      'id=4 "pagar el alquiler" — el 5 de cada mes a las 09:00 (próximo: el sábado 5/12 a las 09:00)',
      'id=7 "la pastilla" — todos los lunes y jueves a las 08:00 (próximo: el lunes 23/11 a las 08:00)',
    ],
    message: 'cancela todos los recordatorios',
    calls: [call('cancel_reminder', { id: 4 }), call('cancel_reminder', { id: 7 })],
  },
  { message: 'que recordatorios tengo?', calls: [call('list_reminders', {})] },
  { message: 'pague la luz 15000', calls: [log(mv('15000', 'luz', 'servicios'))] },
  {
    message: 'siempre pago el cafe con la visa, no? (a question, nothing stated)',
    calls: [call('reply', { text: '¿Querés que me acuerde de eso?' })],
  },
  {
    message: 'cuanto gaste este mes en comida?',
    calls: [summarize(range('this_month', { direction: 'out', category: 'restaurantes' }))],
  },
  {
    message: 'cuantos cafes anote hoy',
    calls: [summarize(range('today', { direction: 'out', description: 'café' }))],
  },
  {
    message: 'cuanto cobre en el año',
    calls: [summarize(range('this_year', { direction: 'in' }))],
  },
  {
    message: 'cuanto me salio la visa la semana pasada',
    calls: [summarize(range('last_week', { direction: 'out', payment: 'crédito visa' }))],
  },
  {
    message: 'cuanto gaste en septiembre?',
    calls: [summarize({ range: { period: 'month', month: 9 }, direction: 'out' })],
  },
  {
    message: 'que categoria me sale mas?',
    calls: [summarize(range('this_month', { group_by: 'category', direction: 'out' }))],
  },
  {
    message: 'estoy gastando mas que el mes pasado?',
    calls: [summarize(range('this_month', { compare: 'previous', direction: 'out' }))],
  },
  {
    message: 'este mes vs septiembre',
    calls: [
      summarize(range('this_month', { compare: { period: 'month', month: 9 }, direction: 'out' })),
    ],
  },
  {
    message: 'del 3 al 10 de octubre por tarjeta',
    calls: [
      summarize({
        range: { period: 'dates', from: '10-03', to: '10-10' },
        group_by: 'payment',
        direction: 'out',
      }),
    ],
  },
  {
    message: 'cuanto gaste el fin de semana pasado',
    calls: [summarize(range('last_weekend', { direction: 'out' }))],
  },
  {
    message: 'gastos de cada mes de 2026',
    calls: [summarize(range('this_year', { group_by: 'month', direction: 'out' }))],
  },
  { message: 'hola, que podes hacer?', calls: [call('help', {})] },
  {
    message: 'cuanto sale el dolar oficial',
    calls: [call('reply', { text: 'Eso no lo sé: solo llevo tus gastos e ingresos.' })],
  },
  { message: 'mil gracias, genial', calls: [call('reply', { text: '¡De nada!' })] },
  {
    conversation: '(persona, hace 1 min) borra el super / (Warren) ✓ Borré: Súper $12.000 · 09:12',
    message: 'borraste el super?',
    calls: [call('reply', { text: 'Sí, borré el súper de $12.000.' })],
  },
  {
    list: [
      [7, 'out', '20000', '<today>', '10:45', 'nafta', 'combustible', 'efectivo'],
      [6, 'out', '3500', '<today>', '10:10', 'café', 'restaurantes', 'sin medio'],
    ],
    message: 'borrá el alquiler y la nafta fue 25000',
    search: { call: call('find_movements', { text: 'alquiler', limit: 5 }), result: 'No matches.' },
    calls: [
      correct(7, { amount: '25000' }),
      call('skip', { part: 'el alquiler', reason: 'not_found' }),
    ],
  },
  {
    list: [CAFE, SUPER],
    message: 'cambiame el primero y anotá subte 800',
    calls: [
      call('skip', { part: 'el primero', reason: 'what_to_change' }),
      log(mv('800', 'subte', 'transporte')),
    ],
  },
]

const rowLine = (row: Row, k: number) => {
  const [id, direction, amount, date, time, description, category, payment] = row
  return `${k + 1}. id=${id} ${direction} ${amount} ARS ${date} ${time} ${description} [${category}] (${payment})`
}

/** The examples as the prompt shows them. */
export function renderExamples(examples: readonly Example[] = EXAMPLES): string {
  return examples
    .map((e) => {
      const head = [
        ...(e.list
          ? [`Lista: ${e.list.length === 0 ? '(ninguno)' : e.list.map(rowLine).join(' / ')}`]
          : []),
        ...(e.facts ? [`Hechos: ${e.facts}`] : []),
        ...(e.reminders ? [`Recordatorios: ${e.reminders.join('\n')}`] : []),
        ...(e.conversation ? [`Conversación: ${e.conversation}`] : []),
        ...(e.pending ? [e.pending] : []),
        `Message: ${e.message}`,
      ]
      const show = (c: Say) => `${c.tool} ${JSON.stringify(c.input)}`
      const search = e.search ? [show(e.search.call), `(result: ${e.search.result})`] : []
      return [...head, ...search, ...e.calls.map(show)].join('\n')
    })
    .join('\n\n')
}
