import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { CATEGORIES, FACT_KINDS } from '../../src/core/commands'
import { ScheduleSchema } from '../../src/domain/reminders/schedule'

/**
 * A scenario is a conversation: a seeded ledger, then user turns, each with the Argentine "now" it
 * is sent at and what must be true afterwards. Expectations describe the INTENDED behaviour
 * (docs/history/agent-spec.md, Goal), not what the current pipeline does.
 *
 * Ledger expectations are a delta over a closed world: a turn lists the changes it must make
 * (`ops`), and every other live movement must be untouched. No `ops` means "no change at all".
 */

export const TAGS = [
  'logging',
  'correction',
  'deletion',
  'answer',
  'query',
  'multi-action',
  'older-item',
  'typo',
  'time-reference',
  'other',
  /** Taking back the last batch of changes ("deshacer"): graded as the delete, the correction or the log it comes to. */
  'undo',
  /** A total over a range, split or compared (agent slice D): graded on the figures of the reply. */
  'summary',
  /** A voice note: its latency includes the transcription, so it is kept apart from the other tags. */
  'voice',
  /** What the person tells Warren about themselves, kept and used later (agent slice F): remembering, using, forgetting, listing. */
  'memory',
  /** Setting, listing and cancelling reminders (slice 6.2): graded on the reminders the person has after the turn. */
  'reminder',
] as const
export type Tag = (typeof TAGS)[number]

const Category = z.enum(CATEGORIES)
const Direction = z.enum(['in', 'out'])
const Currency = z.enum(['ARS', 'USD'])
const Amount = z.string().regex(/^\d+(\.\d{1,2})?$/, 'a decimal string')
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-mm-dd')
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM')
/** The Argentine wall clock of a turn: `2026-11-21T12:00`. */
const Now = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'yyyy-mm-ddTHH:MM')

/** A movement already in the ledger when the scenario starts. List them in the order they were logged (oldest first). */
export const SeedSchema = z.strictObject({
  ref: z.string().min(1),
  description: z.string().min(1),
  amount: Amount,
  /** The day the movement is dated. */
  on: Day,
  /** Argentine time it was logged, shown to the model. */
  at: Clock,
  /** The day it was logged, when not the day it is dated. */
  loggedOn: Day.optional(),
  category: Category,
  payment: z.string().nullable().default(null),
  direction: Direction.default('out'),
  currency: Currency.default('ARS'),
})
export type Seed = z.infer<typeof SeedSchema>

/** A fact already stored when the scenario starts (agent slice F): what the person told Warren on an earlier day. */
export const SeedFactSchema = z.strictObject({
  kind: z.enum(FACT_KINDS),
  /** Already normalized: lowercase, no accents. */
  key: z.string().min(1),
  value: z.string().min(1),
})
export type SeedFact = z.infer<typeof SeedFactSchema>

/** A reminder already set when the scenario starts: its next date is the first occurrence after the scenario's first turn. */
export const SeedReminderSchema = z.strictObject({
  what: z.string().min(1),
  schedule: ScheduleSchema,
})
export type SeedReminder = z.infer<typeof SeedReminderSchema>

/**
 * A live reminder the person must have after a turn. The turn lists them all (a closed world, like the ledger): every live
 * reminder matches exactly one, and none is missing. `first` is its next date, Argentine time (`yyyy-mm-ddThh:mm`); `schedule`
 * holds the stored fields that must be as written (the others are not checked; a list is compared as a set).
 */
export const ReminderExpectSchema = z.strictObject({
  /** Loose match, like a movement's description. */
  what: z.string().min(1),
  first: Now.optional(),
  schedule: z.record(z.string(), z.unknown()).optional(),
})
export type ReminderExpect = z.infer<typeof ReminderExpectSchema>

/** What a new movement must look like. Unset fields are not checked, except `date` (the turn's day) and `direction`/`currency`/`payment` (out, ARS, null). */
const NewMovement = z.strictObject({
  /** Names the movement for later turns. */
  ref: z.string().optional(),
  amount: Amount,
  /** Loose match: either text contains the other, accents and case ignored. A list accepts any of its words (a genuinely open choice). */
  description: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  date: Day.optional(),
  direction: Direction.default('out'),
  currency: Currency.default('ARS'),
  category: Category.optional(),
  payment: z.string().nullable().default(null),
})
export type NewMovementExpect = z.infer<typeof NewMovement>

const SetFields = z.strictObject({
  amount: Amount.optional(),
  date: Day.optional(),
  description: z.string().optional(),
  category: Category.optional(),
  payment: z.string().nullable().optional(),
  currency: Currency.optional(),
  direction: Direction.optional(),
})
export type SetExpect = z.infer<typeof SetFields>

export const OpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('log'), movements: z.array(NewMovement).min(1) }),
  /** `ref` is the movement that must be superseded; its replacement keeps the ref. */
  z.strictObject({ op: z.literal('correct'), ref: z.string(), set: SetFields }),
  z.strictObject({ op: z.literal('delete'), ref: z.string() }),
])
export type Op = z.infer<typeof OpSchema>

export const ReplySchema = z.strictObject({
  /** Every one must appear (accents and case ignored). */
  has: z.array(z.string()).default([]),
  /** At least one must appear. */
  any: z.array(z.string()).default([]),
  /** None may appear. */
  not: z.array(z.string()).default([]),
  /** A regular expression (flag i) the reply must match. */
  re: z.string().optional(),
})
export type ReplyExpect = z.infer<typeof ReplySchema>

export const TurnSchema = z
  .strictObject({
    now: Now,
    text: z.string().min(1),
    /** A file in `evals/scenarios/fixtures` sent as a photo, with `text` as its caption. */
    image: z
      .string()
      .regex(/^[\w.-]+\.(png|jpe?g|webp)$/, 'a file name in evals/scenarios/fixtures')
      .optional(),
    /**
     * A file in `evals/scenarios/fixtures` sent as a voice note (`make-voice.sh` makes them): the real
     * transcription service hears it. `text` is what it says, for the report and for people.
     */
    audio: z
      .string()
      .regex(/^[\w.-]+\.(ogg|m4a|mp3)$/, 'a file name in evals/scenarios/fixtures')
      .optional(),
    ops: z.array(OpSchema).default([]),
    /** How many live facts the person has after this turn. Unset: not checked. */
    liveFacts: z.number().int().min(0).optional(),
    /** The live reminders after this turn, all of them (see `ReminderExpectSchema`). Unset: not checked. */
    liveReminders: z.array(ReminderExpectSchema).optional(),
    /** True: the reply must be a question (starts with ¿). With `ops` on the turn it must not be one. */
    ask: z.boolean().default(false),
    /**
     * Speed, not correctness: the most model calls this turn should use. A turn over it is counted in the
     * report ("over their model-turn cap") and does not fail the scenario.
     */
    maxModelTurns: z.number().int().min(1).optional(),
    reply: ReplySchema.default({ has: [], any: [], not: [] }),
  })
  .refine((t) => !(t.image && t.audio), 'a turn has an image or an audio, not both')

export type Turn = z.infer<typeof TurnSchema>

export const ScenarioSchema = z.strictObject({
  id: z.string().regex(/^s\d{3}$/),
  split: z.enum(['dev', 'test']),
  tags: z.array(z.enum(TAGS)).min(1),
  /** Where it came from: a real transcript, the spec's Goal, or written for coverage. */
  source: z.enum(['transcript', 'spec', 'synthetic']),
  /** One line: what it checks. */
  note: z.string().min(1),
  seed: z.array(SeedSchema).default([]),
  /** Facts the person told Warren before the scenario starts. */
  facts: z.array(SeedFactSchema).default([]),
  /** Reminders the person set before the scenario starts. */
  reminders: z.array(SeedReminderSchema).default([]),
  turns: z.array(TurnSchema).min(1),
})
export type Scenario = z.infer<typeof ScenarioSchema>

const here = dirname(fileURLToPath(import.meta.url))
export const SCENARIOS_FILE = join(here, 'scenarios.jsonl')

/** Parses and validates the file; a bad line names its number. */
export function parseScenarios(raw: string): Scenario[] {
  return raw
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim() !== '')
    .map(({ line, n }) => {
      try {
        return ScenarioSchema.parse(JSON.parse(line))
      } catch (error) {
        throw new Error(
          `scenarios.jsonl line ${n}: ${error instanceof Error ? error.message : error}`,
        )
      }
    })
}

export const loadScenarios = (file = SCENARIOS_FILE): Scenario[] =>
  parseScenarios(readFileSync(file, 'utf8'))
