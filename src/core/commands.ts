import { z } from 'zod'

/**
 * The tool registry: data only. One entry per tool holds everything the tool is: its input (zod, with real optionals and unions,
 * no sentinels, `.describe()` on the fields), whether it reads or writes, and what an MCP client is shown (title, description,
 * scope, output). The MCP tools derive from it. Guards, apply and describe are exhaustive switches over the tools, each checked
 * against `Tool`; none of them lives on an entry, so this module imports only zod.
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

/** Amounts and dates are plain strings here; code validates them (`core/values.ts`). */
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
 * The days a summary covers. Code resolves it to Argentine days, so the agent never works out where a week or a month starts.
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

// ---- The entries

/** What an MCP client is shown of a tool (`mcp/tools.ts` builds the server from it). */
export interface McpBlock {
  title: string
  description: string
  scope: 'ledger:read' | 'ledger:write'
  /** The tool removes or ends something (an MCP annotation). */
  destructive?: true
  /** The input as a client sends it, where it differs from the canonical one (`confidence` is optional, `high` by default). */
  input?: z.ZodObject
  /** What the tool returns, beside the text. */
  output: z.ZodType
  /** Fields only a client sends (a page, a request id), added to the input. */
  extra?: z.ZodRawShape
}

export interface Entry<S extends z.ZodType = z.ZodType> {
  /** The tool's input: the one canonical shape. */
  input: S
  /** `read`: a lookup that changes nothing. `write`: changes what Warren keeps, at the commit point. */
  kind: 'read' | 'write'
  mcp: McpBlock
}

const define = <S extends z.ZodType, K extends Entry['kind']>(entry: Entry<S> & { kind: K }) =>
  entry

const Nothing = z.object({})

// ---- What a client gets back: structured output, with real shapes. Money is exact (a decimal string) beside how Warren shows it.

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
  record: z.string().describe('What changed, as Warren writes it (Spanish).'),
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
  ]),
  movement: MovementView.optional().describe('The movement as it stands now.'),
  from: MovementView.optional().describe('A corrected movement as the correction left it.'),
  fact: FactView.optional(),
  was: z.string().optional().describe("A fact's value before it was taken back."),
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
    summary: z.string().describe('The same summary as Warren writes it, in Spanish.'),
  }),
  list_facts: z.object({ facts: z.array(FactView), total: z.int() }),
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
    items: z.array(UndoneItem).describe('What came back or went away, one per movement or fact.'),
  }),
  remember_fact: z.object({
    ...Written,
    status: z.enum(['new', 'updated', 'unchanged']),
    fact: FactView,
    previous_value: z.string().nullable(),
  }),
  forget_fact: z.object({ ...Written, forgotten: z.array(FactView) }),
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
    kind: 'read',
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
    kind: 'write',
    mcp: {
      title: 'Log movements',
      description:
        'Logs up to 10 movements (spending or income) for the person. `warren_undo_last` takes the whole call back.',
      scope: LEDGER_WRITE,
      input: z.object({
        movements: z
          .array(
            MovementSchema.extend({ confidence: MovementSchema.shape.confidence.default('high') }),
          )
          .min(1)
          .max(10),
      }),
      output: OUTPUTS.log_movements,
      extra: { request_id: RequestId },
    },
  }),

  correct_movement: define({
    input: z.object({ id: Id, changes: ChangesSchema }),
    kind: 'write',
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
    kind: 'write',
    mcp: {
      title: 'Delete a movement',
      description:
        'Deletes one live movement. Nothing is erased: the movement is marked deleted and `warren_undo_last` brings it back.',
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
        .describe(
          '"previous" to compare with the stretch right before (while the period is still running, the same days of the one before). Send a second range only to compare with a different one (this month vs September); never the whole period before as a range, that is "previous".',
        ),
      direction: Direction.optional(),
      category: Category.optional(),
      payment: z.string().optional(),
      description: z
        .string()
        .optional()
        .describe('Words of the description to count or total: "cuántos cafés" is café.'),
    }),
    kind: 'read',
    mcp: {
      title: 'Summarize spending and income',
      description:
        'Totals of spending and income over a range (a named period, a month, a year or explicit days), optionally split by category, payment, day, week or month, or compared with the period before or a second range. Every figure is computed by Warren; quote them, never recompute.',
      scope: LEDGER_READ,
      output: OUTPUTS.summarize,
    },
  }),

  undo_last: define({
    input: Nothing,
    kind: 'write',
    mcp: {
      title: 'Undo the last change',
      description:
        'Undoes the last unit of work of this person (one write call, or one import) as a whole, whichever client made it, within 24 hours. The result says what came back, or why nothing did.',
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
    kind: 'write',
    mcp: {
      title: 'Remember a fact',
      description:
        'Stores one fact the person told you (an alias, a category rule or a note), in their words: an alias is a name they use for a payment, a place or a thing ("la del galicia" is "la visa"), a category says where a kind of expense goes ("café" is entretenimiento), a note is anything else. Only what they said, never a guess, never a secret or contact data. A new value for the same key replaces the old one.',
      scope: LEDGER_WRITE,
      output: OUTPUTS.remember_fact,
      extra: { request_id: RequestId },
    },
  }),

  forget_fact: define({
    input: z.object({
      target: z.union([
        z.object({ id: z.int().describe('The id from `warren_list_facts`.') }),
        z.object({ key: z.string().describe('The words of the key.') }),
      ]),
    }),
    kind: 'write',
    mcp: {
      title: 'Forget a fact',
      description:
        'Forgets one remembered fact, by id or by key. `warren_undo_last` brings it back. Never for a movement of the ledger.',
      scope: LEDGER_WRITE,
      destructive: true,
      output: OUTPUTS.forget_fact,
      extra: { request_id: RequestId },
    },
  }),

  list_facts: define({
    input: Nothing,
    kind: 'read',
    mcp: {
      title: 'List what Warren remembers',
      description: 'Lists every live fact (alias, category rule or note) the person told Warren.',
      scope: LEDGER_READ,
      output: OUTPUTS.list_facts,
    },
  }),
} satisfies Record<string, Entry>

export type Tool = keyof typeof COMMANDS
export type Input<T extends Tool> = z.infer<(typeof COMMANDS)[T]['input']>
/** A call: one tool and its input. */
export type Call = { [T in Tool]: { tool: T; input: Input<T> } }[Tool]
export type CallOf<T extends Tool> = Extract<Call, { tool: T }>

/** The tools that change what Warren keeps. */
export type WriteTool = {
  [T in Tool]: (typeof COMMANDS)[T]['kind'] extends 'write' ? T : never
}[Tool]
export type WriteCall = CallOf<WriteTool>

export const isTool = (name: string): name is Tool => name in COMMANDS

/** Where `kind` says a call writes. */
export const writes = (call: Call): call is WriteCall => COMMANDS[call.tool].kind === 'write'
