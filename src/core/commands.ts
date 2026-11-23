import { z } from 'zod'
import { FirstSchema, RepeatSchema, type Schedule } from '../domain/reminders/schedule'

/**
 * The tool registry: data only. One entry per tool holds everything the tool is: its input (zod, with real optionals and unions,
 * no sentinels, `.describe()` on the fields), what the model is told, what kind of tool it is, what it changes, the word the turn
 * is labelled with, typed examples and what an MCP client is shown. Everything else derives from it (`TOOLS`, `LABELS`, the MCP
 * tools, the prompt's tool list). Guards, apply and describe are exhaustive switches over the tools, each checked against
 * `Tool`; none of them lives on an entry, so this module imports only zod and the pure schedule schema.
 */

export const CATEGORIES = [
  'supermercado',
  'restaurantes',
  'transporte',
  'combustible',
  'vivienda',
  'servicios',
  'salud',
  'educacion',
  'entretenimiento',
  'ropa',
  'regalos',
  'mascotas',
  'viajes',
  'impuestos',
  'transferencias',
  'sueldo',
  'otros_ingresos',
  'otros',
] as const
export type Category = (typeof CATEGORIES)[number]

/** Periods code resolves from today alone, in Argentine time. */
export const NAMED_PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'weekend',
  'last_weekend',
  'this_month',
  'last_month',
  'this_year',
  'last_year',
] as const

/** How a summary splits its totals: not at all, by what was bought, by how it was paid, or by time. */
export const GROUPS = ['none', 'category', 'payment', 'day', 'week', 'month'] as const

/** What a fact is: a name for a payment, a place or a thing; where a kind of expense goes; or anything else, kept for later. */
export const FACT_KINDS = ['alias', 'category', 'note'] as const
export type FactKind = (typeof FACT_KINDS)[number]

/** The most rows `find_movements` returns. */
export const MAX_FOUND = 20
/** The most movements a message may name in `ask_user`. */
export const MAX_ASKED = 10

/** What a write did, in one word each: the vocabulary of `Outcome.effect` and of the history. */
export const EFFECTS = [
  'logged',
  'corrected',
  'deleted',
  'undone',
  'remembered',
  'forgotten',
  'reminded',
  'unreminded',
] as const
export type Effect = (typeof EFFECTS)[number]

/** One word for a unit of work: the `turn.label` and the latency report's key. */
export type Label =
  | 'log'
  | 'correct'
  | 'delete'
  | 'undo'
  | 'remember'
  | 'forget'
  | 'remind'
  | 'summarize'
  | 'ask'
  | 'find'
  | 'reply'

// ---- Shared shapes

const Direction = z.enum(['in', 'out']).describe('"out" for spending, "in" for income.')
const Currency = z.enum(['ARS', 'USD'])
const Category = z
  .enum(CATEGORIES)
  .describe(
    'The closest category; "otros" for spending, "otros_ingresos" for income when none fits.',
  )
const Amount = z
  .string()
  .describe(
    'Positive decimal string with at most 2 decimals, e.g. "3500" or "1500.50": no thousands separators, no currency symbol.',
  )
const Day = z.string().describe('A real day, yyyy-mm-dd, Argentine time, not after today.')
const Id = z
  .int()
  .describe(
    'The id of a live movement, from the list, a find_movements result or an earlier result.',
  )

/** Amounts and dates are plain strings here; code validates them after the model (`core/values.ts`). */
export const MovementSchema = z.object({
  direction: Direction,
  amount: Amount,
  currency: Currency,
  date: Day,
  description: z
    .string()
    .describe(
      'What it was, in a few words, e.g. "café" or "nafta YPF". No numbers of 4 or more digits.',
    ),
  category: Category,
  payment: z
    .string()
    .optional()
    .describe('How it was paid, e.g. "crédito visa" or "efectivo"; leave out when unknown.'),
  confidence: z.enum(['high', 'low']).describe('"low" when the amount or what it was is a guess.'),
})
export type Movement = z.infer<typeof MovementSchema>

/** Only the fields the person changes are present; the rest are left out. */
export const ChangesSchema = z
  .object({
    direction: Direction.optional(),
    amount: Amount.optional(),
    currency: Currency.optional(),
    date: Day.optional(),
    description: z.string().optional().describe('The new description.'),
    category: Category.optional(),
    payment: z.string().optional().describe('The new payment method.'),
  })
  .describe('Only the fields to change; leave the rest out.')
export type Changes = z.infer<typeof ChangesSchema>

/**
 * The days a summary covers. Code resolves it to Argentine days, so the model never works out where a week or a month starts.
 * `dates` takes yyyy-mm-dd, mm-dd or dd as the person said it (code picks the latest such day that is not in the future).
 */
export const RangeSchema = z.discriminatedUnion('period', [
  z.object({ period: z.enum(NAMED_PERIODS) }),
  z.object({
    period: z.literal('month'),
    month: z.int().min(1).max(12).describe('1 to 12: "octubre" is 10.'),
    year: z
      .int()
      .optional()
      .describe('Leave out for the latest such month that is not in the future.'),
  }),
  z.object({ period: z.literal('year'), year: z.int() }),
  z.object({
    period: z.literal('dates'),
    from: z.string().describe('yyyy-mm-dd, mm-dd or dd, as the person said it.'),
    to: z.string().optional().describe('Same forms; leave out for the same day as from.'),
  }),
])
export type Range = z.infer<typeof RangeSchema>

/** What an `ask_user` question does once the person picks an option. Code writes the question from it. */
export const ThenSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('delete') }).describe('The person asked to delete one of them.'),
  z
    .object({ do: z.literal('correct'), changes: ChangesSchema })
    .describe('The person asked to change one of them and already gave the new value.'),
  z
    .object({ do: z.literal('ask_change') })
    .describe('The person asked to change one of them and gave no value: ask what to change.'),
])
export type Then = z.infer<typeof ThenSchema>

/** Why a part of the message was not done: code writes the line. */
export const SKIP_REASONS = ['not_found', 'what_to_change', 'cannot', 'separately'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

// ---- The entries

/** What an MCP client is shown of a tool (`mcp/tools.ts` builds the server from it; the client's agent has no prompt). */
export interface McpBlock {
  title: string
  description: string
  scope: 'ledger:read' | 'ledger:write'
  /** The tool removes or ends something (an MCP annotation). */
  destructive?: true
  /** What the tool returns, beside the text. */
  output: z.ZodType
  /** Fields only an MCP client sends (a page, a request id), added to the input. */
  extra?: z.ZodRawShape
}

export interface Entry<S extends z.ZodType = z.ZodType> {
  /** The tool's input: the one canonical shape both channels use. */
  input: S
  /** What the model is told. */
  description: string
  /**
   * `read`: a lookup the loop runs and answers, then goes on (the only non-terminal tool). `write`: changes what Warren keeps, at the
   * commit point. `answer`: ends the turn with something code renders or the model says. `ask`: ends the turn with a question.
   */
  kind: 'read' | 'write' | 'answer' | 'ask'
  /** What a write does: the word its outcome and the history carry. */
  effect?: Effect
  label: Label
  /** Sent alone: with another action in the same turn it is refused. */
  alone?: true
  /** Only code sends it, after the person's own answer; the model is never offered it. */
  by?: 'code'
  /** Typed inputs a test parses with `input`; the prompt shows them. */
  examples: z.input<S>[]
  mcp?: McpBlock
}

const define = <S extends z.ZodType, K extends Entry['kind']>(entry: Entry<S> & { kind: K }) =>
  entry

const Nothing = z.object({})

// ---- What an MCP client gets back: structured output, with real shapes. Money is exact (a decimal string) beside how Warren shows it.

const Money = {
  amount: z.string().describe('Decimal string, exact. Quote it as given.'),
  display: z.string().describe('The amount as Warren writes it, e.g. "$3.500" or "US$ 20".'),
}
const MovementView = z.object({
  id: z.int().describe('Warren id of the movement: the same across its corrections.'),
  date: z.string().describe('yyyy-mm-dd, Argentine day.'),
  time: z.string().describe('hh:mm Argentine time when it was logged.'),
  direction: z.enum(['in', 'out']).describe('"out" is money spent, "in" money received.'),
  ...Money,
  currency: Currency,
  description: z.string(),
  category: Category,
  payment: z.string().nullable(),
})
const FactView = z.object({
  id: z.int(),
  kind: z.enum(FACT_KINDS),
  key: z.string(),
  value: z.string(),
})
const ReminderView = z.object({
  id: z.int().describe('Warren id of the reminder.'),
  what: z.string(),
  next_due_at: z
    .string()
    .nullable()
    .describe('When it fires next, an ISO instant; null once a one-off has been sent.'),
  when: z.string().describe('The reminder in words, as Warren says it (Spanish).'),
})
const Total = z.object({
  direction: z.enum(['in', 'out']),
  currency: Currency,
  count: z.int(),
  ...Money,
})
const Group = Total.extend({
  key: z.string(),
  label: z.string().describe('The group in words, as Warren says it.'),
})
const Side = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().describe('The range in words, e.g. "Octubre (1–31)".'),
  totals: z.array(Total).describe('One per direction and currency; never added together.'),
  groups: z.array(Group),
  groups_omitted: z.int().describe('Groups left out of `groups` (the text lists the rest).'),
})

/** What every change returns: the line Warren writes, the unit of work it belongs to and whether this is an answer replayed. */
const Written = {
  record: z.string().describe('What changed, as Warren writes it on WhatsApp (Spanish).'),
  turn: z
    .int()
    .nullable()
    .describe(
      'The unit of work this belongs to (an undo takes it back); null when nothing changed.',
    ),
  replayed: z
    .boolean()
    .describe(
      'True when this answers an earlier call with the same request_id: nothing was written now.',
    ),
}
const UndoneItem = z.object({
  kind: z.enum([
    'logged',
    'corrected',
    'deleted',
    'fact_removed',
    'fact_restored',
    'fact_reverted',
    'reminder_removed',
    'reminder_restored',
  ]),
  movement: MovementView.optional().describe('The movement as it stands now.'),
  from: MovementView.optional().describe('A corrected movement as the correction left it.'),
  fact: FactView.optional(),
  was: z.string().optional().describe("A fact's value before it was taken back."),
  reminder: ReminderView.optional(),
})

/** The output of each MCP tool. `mcp/tools.ts` builds its results from these types. */
export const OUTPUTS = {
  find_movements: z.object({
    movements: z.array(MovementView),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pass as `cursor` for the next page; null at the end.'),
  }),
  summarize: Side.extend({
    compared_with: Side.nullable(),
    changes: z
      .array(
        z.object({
          direction: z.enum(['in', 'out']),
          currency: Currency,
          way: z
            .enum(['more', 'less', 'same'])
            .describe('How the asked range went from the compared one.'),
          ...Money,
          percent: z
            .string()
            .nullable()
            .describe('"+20,5%", or null when there was nothing before.'),
        }),
      )
      .describe('Empty unless the summary was compared.'),
    summary: z.string().describe('The same summary as Warren writes it on WhatsApp, in Spanish.'),
  }),
  list_facts: z.object({ facts: z.array(FactView), total: z.int() }),
  list_reminders: z.object({ reminders: z.array(ReminderView) }),
  log_movements: z.object({ ...Written, movements: z.array(MovementView) }),
  correct_movement: z.object({
    ...Written,
    changed: z
      .array(z.string())
      .describe('The fields the correction changed; empty when it was already so.'),
    before: MovementView,
    after: MovementView,
  }),
  delete_movement: z.object({ ...Written, deleted: MovementView }),
  undo_last: z.object({
    ...Written,
    undone_turn: z.int().describe('The unit of work that was taken back.'),
    items: z
      .array(UndoneItem)
      .describe('What came back or went away, one per movement, fact or reminder.'),
  }),
  remember_fact: z.object({
    ...Written,
    status: z.enum(['new', 'updated', 'unchanged']),
    fact: FactView,
    previous_value: z.string().nullable(),
  }),
  forget_fact: z.object({ ...Written, forgotten: z.array(FactView) }),
  set_reminder: z.object({ ...Written, reminder: ReminderView }),
  cancel_reminder: z.object({ ...Written, reminder: ReminderView }),
} as const

const RequestId = z
  .uuid()
  .optional()
  .describe(
    'A uuid you make up for this call. Send the same call again with the same request_id (a retry after a timeout) and Warren returns the first answer without writing twice.',
  )

const LEDGER_READ = 'ledger:read'
const LEDGER_WRITE = 'ledger:write'

export const COMMANDS = {
  find_movements: define({
    input: z.object({
      text: z
        .string()
        .optional()
        .describe(
          'Words of the description or the category, all of them; accents and case do not matter.',
        ),
      from: z.string().optional().describe('yyyy-mm-dd'),
      to: z.string().optional().describe('yyyy-mm-dd'),
      category: Category.optional(),
      payment: z.string().optional(),
      amount: Amount.optional(),
      limit: z.int().optional(),
    }),
    description:
      "Search the person's whole history for a movement that is not in the list of the 10 newest. Returns up to 20 live movements with their ids, newest first. Leave out the filters you do not need.",
    kind: 'read',
    label: 'find',
    examples: [{ text: 'nafta', from: '2026-10-01' }, { amount: '12000' }],
    mcp: {
      title: 'Find movements',
      description:
        'Finds live movements by words, dates, category, payment or amount, newest first, a page at a time. Use it to get the id of a movement before correcting or deleting it.',
      scope: LEDGER_READ,
      output: OUTPUTS.find_movements,
      extra: {
        limit: z.int().min(1).max(50).optional().describe('Page size, 1 to 50 (default 25).'),
        cursor: z.string().max(32).optional().describe('The `next_cursor` of the previous page.'),
      },
    },
  }),

  log_movements: define({
    input: z.object({ movements: z.array(MovementSchema).min(1).max(10) }),
    description: 'Record 1 to 10 new movements (expenses or income) the person tells you about.',
    kind: 'write',
    effect: 'logged',
    label: 'log',
    examples: [
      {
        movements: [
          {
            direction: 'out',
            amount: '3500',
            currency: 'ARS',
            date: '2026-11-20',
            description: 'café',
            category: 'restaurantes',
            payment: 'crédito visa',
            confidence: 'high',
          },
        ],
      },
    ],
    mcp: {
      title: 'Log movements',
      description:
        'Logs up to 10 movements (spending or income) for the person. The person can undo it from WhatsApp ("deshacer").',
      scope: LEDGER_WRITE,
      output: OUTPUTS.log_movements,
      extra: { request_id: RequestId },
    },
  }),

  correct_movement: define({
    input: z.object({ id: Id, changes: ChangesSchema }),
    description:
      'Change fields of one existing movement, by id. Only the fields that change are sent.',
    kind: 'write',
    effect: 'corrected',
    label: 'correct',
    examples: [{ id: 41, changes: { amount: '3800' } }],
    mcp: {
      title: 'Correct a movement',
      description:
        'Changes fields of one live movement. Nothing is overwritten: a correction adds a new version.',
      scope: LEDGER_WRITE,
      output: OUTPUTS.correct_movement,
      extra: { request_id: RequestId },
    },
  }),

  delete_movement: define({
    input: z.object({ id: Id }),
    description: 'Delete one existing movement, by id.',
    kind: 'write',
    effect: 'deleted',
    label: 'delete',
    examples: [{ id: 41 }],
    mcp: {
      title: 'Delete a movement',
      description:
        'Deletes one live movement. Nothing is erased: the movement is marked deleted and "deshacer" brings it back.',
      scope: LEDGER_WRITE,
      destructive: true,
      output: OUTPUTS.delete_movement,
      extra: { request_id: RequestId },
    },
  }),

  summarize: define({
    input: z.object({
      range: RangeSchema,
      group_by: z.enum(GROUPS).optional().describe('Split the totals; leave out for none.'),
      compare: z
        .union([z.literal('previous'), RangeSchema])
        .optional()
        .describe('"previous" for the period just before, or a second range the person named.'),
      direction: Direction.optional(),
      category: Category.optional(),
      payment: z.string().optional(),
      description: z
        .string()
        .optional()
        .describe('Words of the description to count or total: "cuántos cafés" is café.'),
    }),
    description:
      'Answer how much the person spent or received over any days (a named period, a month, a year or explicit days), optionally split by category, payment, day, week or month, or compared with the period before or a second range. Code resolves the days and computes every total, count, difference and percentage; you only choose the range, the split, the comparison and the filters (including the words of a description, for "cuántos cafés").',
    kind: 'answer',
    label: 'summarize',
    examples: [
      { range: { period: 'this_month' }, group_by: 'category' },
      { range: { period: 'month', month: 10 }, compare: { period: 'month', month: 9 } },
      { range: { period: 'last_month' }, compare: 'previous', category: 'supermercado' },
    ],
    mcp: {
      title: 'Summarize spending and income',
      description:
        'Totals of spending and income over a range, optionally split or compared. Every figure is computed by Warren; quote them, never recompute.',
      scope: LEDGER_READ,
      output: OUTPUTS.summarize,
    },
  }),

  ask_user: define({
    input: z.object({
      movement_ids: z.array(Id).min(1).max(MAX_ASKED),
      then: ThenSchema,
    }),
    description:
      'Ask which movement the person means, or what to change in it, when you cannot act. Code writes the question and lists the movements you give; you write no question. `then` says what the answer will do: delete it, correct it (with the new value the person already gave), or ask what to change.',
    kind: 'ask',
    label: 'ask',
    examples: [
      { movement_ids: [41, 38], then: { do: 'delete' } },
      { movement_ids: [41, 38], then: { do: 'correct', changes: { amount: '4100' } } },
      { movement_ids: [41], then: { do: 'ask_change' } },
    ],
  }),

  reply: define({
    input: z.object({ text: z.string().max(280) }),
    description:
      'Answer in words, for anything that is not a change to the ledger: a question about what you did or what is stored, small talk, something you cannot do, a request outside expenses, a change when the person has no movements at all (never when some exist and none fits: that is ask_user). Short, in Argentine Spanish. The text may use only numbers that code gave you. Sent alone.',
    kind: 'answer',
    label: 'reply',
    alone: true,
    examples: [{ text: 'Eso no lo puedo hacer, pero te anoto los gastos.' }],
  }),

  skip: define({
    input: z.object({
      part: z
        .string()
        .max(80)
        .describe(
          'The thing you did not find or do, as a noun phrase in the person\'s words, without the verb: "el súper", "el primero" (not "borrá el súper"). At most 8 words, no numbers.',
        ),
      reason: z
        .enum(SKIP_REASONS)
        .describe(
          'not_found: no such movement. what_to_change: the person did not say what to change. cannot: Warren does not do that. separately: it needs its own message.',
        ),
    }),
    description:
      'Say that you did not do one part of a message while you did the others. Code writes the line. Never for the whole message.',
    kind: 'answer',
    label: 'reply',
    examples: [{ part: 'la nafta del lunes', reason: 'not_found' }],
  }),

  help: define({
    input: Nothing,
    description:
      'Send the canned help text: only when the person asks for help or what you can do, or greets you.',
    kind: 'answer',
    label: 'reply',
    examples: [{}],
  }),

  undo_last: define({
    input: Nothing,
    description:
      'Undo the person\'s LAST batch of changes as a whole (everything one earlier message logged, corrected or deleted): "deshacer", "volvé atrás", "anulá lo que hiciste", "no, eso no" right after a record. Code finds the batch and writes what it undid; you send no id. Never for one named movement (that is delete_movement or correct_movement), and never together with another action.',
    kind: 'write',
    effect: 'undone',
    label: 'undo',
    alone: true,
    examples: [{}],
    mcp: {
      title: 'Undo the last change',
      description:
        'Undoes the last unit of work of this person, whichever channel made it, as a whole. The result says what came back, or why nothing did.',
      scope: LEDGER_WRITE,
      destructive: true,
      output: OUTPUTS.undo_last,
      extra: { request_id: RequestId },
    },
  }),

  remember_fact: define({
    input: z.object({
      kind: z.enum(FACT_KINDS),
      key: z.string().describe("The person's own words for it."),
      value: z.string(),
    }),
    description:
      'Remember ONE fact the person states about their own money or habits, so you understand later messages: an alias (a name they use for a payment, a place or a thing: "la del galicia" is "la visa"), a category (where a kind of expense goes: "café" is entretenimiento) or a note (anything else: "cobro" is "el 5"). Only what they say, explicitly ("acordate que...") or as a clear statement; never a guess, never something you inferred. It logs, corrects and deletes nothing. A new value for the same key replaces the old one. Code checks it and writes the record.',
    kind: 'write',
    effect: 'remembered',
    label: 'remember',
    examples: [
      { kind: 'alias', key: 'la visa', value: 'crédito galicia' },
      { kind: 'category', key: 'café', value: 'entretenimiento' },
      { kind: 'note', key: 'cobro', value: 'el 5' },
    ],
    mcp: {
      title: 'Remember a fact',
      description:
        'Stores one fact the person told you (an alias, a category rule or a note), in their words. Never a secret or contact data.',
      scope: LEDGER_WRITE,
      output: OUTPUTS.remember_fact,
      extra: { request_id: RequestId },
    },
  }),

  forget_fact: define({
    input: z.object({
      target: z.union([
        z.object({ id: z.int().describe('The id from "Hechos".') }),
        z.object({
          key: z.string().describe('The words of the key, for a fact that is not shown.'),
        }),
      ]),
    }),
    description:
      'Forget one remembered fact: its id from "Hechos" (only an id you were shown), or its key (the words) when it is not shown. For "olvidate de lo de la visa". Never for a movement of the ledger.',
    kind: 'write',
    effect: 'forgotten',
    label: 'forget',
    examples: [{ target: { id: 7 } }, { target: { key: 'la visa' } }],
    mcp: {
      title: 'Forget a fact',
      description: 'Forgets one remembered fact, by id or by key. "deshacer" brings it back.',
      scope: LEDGER_WRITE,
      destructive: true,
      output: OUTPUTS.forget_fact,
      extra: { request_id: RequestId },
    },
  }),

  forget_all_facts: define({
    input: Nothing,
    description:
      'The person asks you to forget everything you know about them ("olvidate de todo lo que sabés de mí"). Code asks "¿Seguro?" and only their "sí" confirms; you never do. Never together with another action.',
    kind: 'ask',
    label: 'forget',
    alone: true,
    examples: [{}],
  }),

  forget_all_confirmed: define({
    input: Nothing,
    description: "The person's own 'sí' to '¿Seguro?'. Code sends it; the model never does.",
    kind: 'write',
    effect: 'forgotten',
    label: 'forget',
    by: 'code',
    examples: [{}],
  }),

  list_facts: define({
    input: Nothing,
    description:
      'The person asks what you know or have noted about them ("¿qué sabés de mí?", "¿qué tenés anotado?"). Code lists every fact.',
    kind: 'answer',
    label: 'reply',
    examples: [{}],
    mcp: {
      title: 'List what Warren remembers',
      description: 'Lists every live fact (alias, category rule or note) the person told Warren.',
      scope: LEDGER_READ,
      output: OUTPUTS.list_facts,
    },
  }),

  set_reminder: define({
    input: z.object({
      what: z
        .string()
        .describe(
          'What to remind them of, in their words, one line, no numbers they did not write.',
        ),
      first: FirstSchema.describe(
        'When it first fires, as the person said it: {in:{n,unit}} for "en 20 minutos"; {day:"today"|"tomorrow"|"day_after", time?}; {weekday:"mon".."sun", time?}; {month_day:1..31, month?, time?}; {date:"yyyy-mm-dd", time?}. Leave time out when they gave none (09:00). Code works out the day.',
      ),
      ...RepeatSchema.shape,
    }),
    description:
      'Set a reminder: Warren sends the person a WhatsApp message with `what` at the time `first` says. For a repeating one add `every` (day, week, month, year) with `interval` (1 unless "cada 2…"); weekdays for week (mon..sun); month_days for month or year (1 to 31, -1 is the last day); nth ({n: 1..4 or -1, weekday}) for "el primer lunes"; month (1..12) for year; until or count to end it. Leave out every field that does not apply. Code works out the first date, checks it is ahead and writes the confirmation.',
    kind: 'write',
    effect: 'reminded',
    label: 'remind',
    examples: [
      { what: 'pagar la Visa', first: { month_day: 10 } },
      { what: 'llamar al médico', first: { in: { n: 20, unit: 'minutes' } } },
      {
        what: 'tomar la pastilla',
        first: { day: 'tomorrow', time: '08:00' },
        every: 'week',
        weekdays: ['mon', 'thu'],
      },
    ],
    mcp: {
      title: 'Set a reminder',
      description:
        'Sets a reminder: Warren sends the person a WhatsApp message at the time it says.',
      scope: LEDGER_WRITE,
      output: OUTPUTS.set_reminder,
      extra: { request_id: RequestId },
    },
  }),

  cancel_reminder: define({
    input: z.object({ id: z.int().describe('The id from "Recordatorios".') }),
    description:
      'Cancel one live reminder, by an id from "Recordatorios" (only an id you were shown). For "cancelá el del alquiler", "ya no me recuerdes la pastilla". Never for a movement of the ledger.',
    kind: 'write',
    effect: 'unreminded',
    label: 'remind',
    examples: [{ id: 3 }],
    mcp: {
      title: 'Cancel a reminder',
      description: 'Cancels one live reminder, by id. "deshacer" brings it back.',
      scope: LEDGER_WRITE,
      destructive: true,
      output: OUTPUTS.cancel_reminder,
      extra: { request_id: RequestId },
    },
  }),

  list_reminders: define({
    input: Nothing,
    description:
      'The person asks which reminders they have ("¿qué recordatorios tengo?", "¿qué me ibas a recordar?"). Code lists every live reminder.',
    kind: 'answer',
    label: 'reply',
    examples: [{}],
    mcp: {
      title: 'List reminders',
      description: 'Lists every live reminder, the next to come first.',
      scope: LEDGER_READ,
      output: OUTPUTS.list_reminders,
    },
  }),
} satisfies Record<string, Entry>

export type Tool = keyof typeof COMMANDS
export type Input<T extends Tool> = z.infer<(typeof COMMANDS)[T]['input']>
/**
 * A call: one tool and its input. A `set_reminder` that `checkValues` passed also carries the schedule it resolved (from the instant it
 * checked at), so the commit point stores the schedule the guard approved and does not work it out again from another instant.
 */
export type Call = {
  [T in Tool]: { tool: T; input: Input<T> } & (T extends 'set_reminder'
    ? { schedule?: Schedule }
    : unknown)
}[Tool]
export type CallOf<T extends Tool> = Extract<Call, { tool: T }>

/** The tools that change what Warren keeps. */
export type WriteTool = {
  [T in Tool]: (typeof COMMANDS)[T]['kind'] extends 'write' ? T : never
}[Tool]
export type WriteCall = CallOf<WriteTool>

const entries = Object.entries(COMMANDS) as [Tool, Entry][]
export const TOOL_NAMES = entries.map(([name]) => name)
export const isTool = (name: string): name is Tool => name in COMMANDS
export const isWriteTool = (name: string): name is WriteTool =>
  isTool(name) && COMMANDS[name].kind === 'write'

/** Where `kind` says a call writes. */
export const writes = (call: Call): call is WriteCall => COMMANDS[call.tool].kind === 'write'

/** The Anthropic tool definition of a registry entry: the input's JSON schema (defaults are how code reads a field the model left out, not something to show it). */
function definition(name: Tool, entry: Entry) {
  const { $schema: _, ...schema } = z.toJSONSchema(entry.input, { io: 'input' }) as Record<
    string,
    unknown
  >
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip)
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node)
          // `z.int()` states the safe-integer range as its bounds: noise for the model, so only real bounds stay.
          .filter(
            ([key, value]) =>
              key !== 'default' &&
              !(
                (key === 'minimum' || key === 'maximum') &&
                Math.abs(Number(value)) === Number.MAX_SAFE_INTEGER
              ),
          )
          .map(([key, value]) => [key, strip(value)]),
      )
    }
    return node
  }
  return {
    name,
    description: entry.description,
    input_schema: strip(schema) as { type: 'object'; [key: string]: unknown },
  }
}

/**
 * The tools the model is offered, in the registry's order, built once and never changed: its order and bytes are part of the cached
 * prefix. The tools are not `strict`; the input is parsed with the same zod schema and every value is checked by code.
 */
export const TOOLS = entries
  .filter(([, entry]) => entry.by !== 'code')
  .map(([name, entry]) => definition(name, entry))

/** The turn's label for a list of calls: the one tool's, or `multi`. */
export function labelOf(calls: readonly { tool: Tool }[]): Label | 'multi' {
  const [only] = calls
  return !only || calls.length > 1 ? 'multi' : COMMANDS[only.tool].label
}
