import { z } from 'zod'

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

/** The named periods, plus the three that need the fields of the range: a month, a year, explicit days. */
export const PERIODS = [...NAMED_PERIODS, 'month', 'year', 'dates'] as const

/** How a summary splits its totals: not at all, by what was bought, by how it was paid, or by time. */
export const GROUPS = ['none', 'category', 'payment', 'day', 'week', 'month'] as const

/** What a summary is compared with: nothing, the period before, or a second range the person named. */
export const COMPARES = ['none', 'previous', 'range'] as const

// Factories, not shared instances: the API rejects the $defs that a reused schema produces.
const Direction = () => z.enum(['in', 'out'])
const Currency = () => z.enum(['ARS', 'USD'])
const Category = () => z.enum(CATEGORIES)
const Confidence = () => z.enum(['high', 'low'])
/**
 * A short sentence in the person's voice, or null. Always present (a nullable, not an optional, field:
 * strict tools allow 24 optional parameters and the tools already use 22). Code sends it after the
 * lines it renders, and only when every number in it comes from code (`checkSay`).
 */
const Say = () => z.string().nullable()

/** Amounts and dates are plain strings here; code validates them after the model (validate.ts). */
export const MovementSchema = () =>
  z.object({
    direction: Direction(),
    amount: z.string(),
    currency: Currency(),
    date: z.string(),
    description: z.string(),
    category: Category(),
    payment: z.string().nullable(),
    confidence: Confidence(),
  })

/**
 * Only the fields the person changes are present; the rest are left out. (Optional, not nullable:
 * strict tools allow 24 optional parameters but only 16 with a union type, and nullable is a union.)
 */
export const ChangesSchema = () =>
  z.object({
    direction: Direction().optional(),
    amount: z.string().optional(),
    currency: Currency().optional(),
    date: z.string().optional(),
    description: z.string().optional(),
    category: Category().optional(),
    payment: z.string().optional(),
  })

/**
 * The days a summary covers. Every field is always present (strict tools allow few optional or union
 * fields, and the others are used up): a field the period does not use is 0 or "". Code resolves it to
 * Argentine days (`resolveRange`), so the model never works out where a week or a month starts.
 */
export const RangeSchema = () =>
  z.object({
    period: z.enum(PERIODS),
    /** `month` only: 1 to 12 ("octubre" is 10). */
    month: z.number().int(),
    /** `month` (0 = the latest one that is not in the future) and `year` (the year). */
    year: z.number().int(),
    /** `dates` only: yyyy-mm-dd, mm-dd or dd, as the person said it (code picks the latest such day that is not in the future). */
    from: z.string(),
    /** `dates` only: same forms; "" is the same day as `from`. */
    to: z.string(),
  })

export type Period = (typeof PERIODS)[number]
export type NamedPeriod = (typeof NAMED_PERIODS)[number]
export type GroupBy = (typeof GROUPS)[number]
export type CompareTo = (typeof COMPARES)[number]
export type RangeInput = z.infer<ReturnType<typeof RangeSchema>>
export type Category = (typeof CATEGORIES)[number]
export type Movement = z.infer<ReturnType<typeof MovementSchema>>
export type Changes = z.infer<ReturnType<typeof ChangesSchema>>

/** A stored movement as the model and the replies see it. */
export type RecentMovement = Pick<
  Movement,
  'direction' | 'amount' | 'currency' | 'date' | 'description' | 'category' | 'payment'
> & {
  /** When it was logged, Argentine HH:MM. Tells apart movements of the same day. */
  time?: string
}

/** The most movements one message may log. */
export const MAX_MOVEMENTS = 10
/** The most rows `find_movements` returns. */
export const MAX_FOUND = 20

/** What an `ask_user` question will do once the person picks an option. */
export const PENDING_ACTIONS = ['none', 'correct', 'delete'] as const

/**
 * The tools, one input schema each. Strict tools: nothing but the listed fields is allowed, and the
 * fields that are not optional are always there (an unset one is null). Optional and nullable
 * fields are spread so the whole list stays under the strict-mode limits (24 optional, 16 union).
 * The terminal tools (everything but `find_movements`) end the loop.
 */
export const TOOL_INPUTS = {
  find_movements: () =>
    z.object({
      text: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      category: Category().optional(),
      payment: z.string().optional(),
      amount: z.string().optional(),
      limit: z.number().int().optional(),
    }),
  log_movements: () => z.object({ movements: z.array(MovementSchema()), text: Say() }),
  correct_movement: () => z.object({ id: z.number().int(), changes: ChangesSchema(), text: Say() }),
  delete_movement: () => z.object({ id: z.number().int(), text: Say() }),
  summarize: () =>
    z.object({
      range: RangeSchema(),
      group_by: z.enum(GROUPS),
      compare_to: z.enum(COMPARES),
      /** Only with `compare_to: "range"`: the second range ("noviembre vs octubre": range November, other October). */
      other: RangeSchema().optional(),
      direction: Direction().nullable(),
      category: Category().nullable(),
      payment: z.string().nullable(),
      /** Words of the description to count or total: "cuántos cafés" is `café`. */
      description: z.string().nullable(),
      text: Say(),
    }),
  ask_user: () =>
    z.object({
      question: z.string(),
      movement_ids: z.array(z.number().int()),
      after_answer: z.enum(PENDING_ACTIONS),
      changes: ChangesSchema().optional(),
    }),
  reply: () => z.object({ text: z.string() }),
  help: () => z.object({}),
  /** Reverts the sender's last write batch (everything one earlier message changed). Code finds the batch: the model sends no id. */
  undo_last: () => z.object({ text: Say() }),
} as const

export type ToolName = keyof typeof TOOL_INPUTS
export type ToolInput<N extends ToolName> = z.infer<ReturnType<(typeof TOOL_INPUTS)[N]>>
export type FindInput = ToolInput<'find_movements'>

/** A terminal call, validated: what the model asked for, which code then runs. */
export type ModelAction = {
  [N in Exclude<ToolName, 'find_movements'>]: { tool: N; input: ToolInput<N> }
}[Exclude<ToolName, 'find_movements'>]

/** A reply code decides on its own, never the model (a photo that cannot be read): sent as written. */
export type Notice = { tool: 'notice'; input: { text: string } }

/** What runs at the commit point: the model's terminal calls, or a notice from code. */
export type Action = ModelAction | Notice

/** What `ask_user` leaves for the answer path: run this on the option the person picks. */
export type Pending = { action: 'correct'; changes: Changes } | { action: 'delete' }
