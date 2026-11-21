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

export const PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_year',
] as const

// Factories, not shared instances: the API rejects the $defs that a reused schema produces.
const Direction = () => z.enum(['in', 'out'])
const Currency = () => z.enum(['ARS', 'USD'])
const Category = () => z.enum(CATEGORIES)
const Confidence = () => z.enum(['high', 'low'])
/** The number of a movement in the list shown to the model (1 is the newest), or null. Code checks it is an integer in range. */
const TargetIndex = () => z.number().nullable()

/** Amounts and dates are plain strings here; code validates them after the model (validate.ts). */
export const MovementSchema = z.object({
  direction: Direction(),
  amount: z.string(),
  currency: Currency(),
  date: z.string(),
  description: z.string(),
  category: Category(),
  payment: z.string().nullable(),
  confidence: Confidence(),
})

/** Only the fields the person changes are set; the rest are null. */
export const ChangesSchema = z.object({
  direction: Direction().nullable(),
  amount: z.string().nullable(),
  currency: Currency().nullable(),
  date: z.string().nullable(),
  description: z.string().nullable(),
  category: Category().nullable(),
  payment: z.string().nullable(),
})

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('log'), movements: z.array(MovementSchema) }),
  z.object({
    type: z.literal('correct'),
    target: z.string(),
    target_index: TargetIndex(),
    changes: ChangesSchema,
    confidence: Confidence(),
  }),
  z.object({
    type: z.literal('delete'),
    target: z.string(),
    target_index: TargetIndex(),
    confidence: Confidence(),
  }),
  z.object({
    type: z.literal('query'),
    period: z.enum(PERIODS),
    direction: Direction().nullable(),
    category: Category().nullable(),
    payment: z.string().nullable(),
  }),
  z.object({ type: z.literal('help') }),
  z.object({ type: z.literal('off_topic') }),
])

export type Period = (typeof PERIODS)[number]
export type Movement = z.infer<typeof MovementSchema>
export type Changes = z.infer<typeof ChangesSchema>
export type Command = z.infer<typeof CommandSchema>

/** A stored movement shown to the model as context for corrections and deletes. */
export type RecentMovement = Pick<
  Movement,
  'direction' | 'amount' | 'currency' | 'date' | 'description' | 'category' | 'payment'
> & {
  /** When it was logged, Argentine HH:MM. Tells apart movements of the same day. */
  time?: string
}

/** The sender's previous message and the reply it got: context for a short answer ("2", "sí"). */
export type PreviousExchange = { text: string; reply: string }
