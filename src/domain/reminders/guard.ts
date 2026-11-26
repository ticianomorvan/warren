import type { z } from 'zod'
import { hasForeignDigit } from '../../core/numbers'
import { holdsSecretValue, looksContact } from '../../core/secrets'
import { tidy as tidyWords } from '../facts'
import {
  type First,
  nextOccurrence,
  normalizeSchedule,
  type RepeatSchema,
  resolveFirst,
  type Schedule,
  ScheduleSchema,
} from './schedule'

/**
 * What a reminder says, on one line: runs of whitespace (a newline, a tab, five spaces) become one space. A template's
 * parameter may hold none of those, and the person's words are not changed by it.
 */
export const tidyWhat = (what: string): string => what.replace(/\s+/g, ' ').trim()

/** The most live reminders one account holds. */
export const MAX_REMINDERS = 20
/** How far ahead the first occurrence may be. */
export const MAX_DAYS_AHEAD = 366
/** What a reminder says: one line of at most this many characters. */
export const MAX_WHAT = 100

const DAY_MS = 86_400_000

export type ReminderCheck =
  | { ok: true; what: string; schedule: Schedule; first: Date }
  /** What the model is told, to send it again. */
  | { ok: false; message: string }
  /** The text is a secret or contact data: it leaves through Meta, so nothing is stored and the person is told. */
  | { ok: false; refused: 'secret' | 'contact' }
  /** The schedule has no occurrence after now (a time that has passed), or the first is too far: the person is told, not the model. */
  | { ok: false; refused: 'past' | 'far' }

/**
 * The rules of a reminder before it is stored, whoever sends it: the text is one line of at most `MAX_WHAT` characters and
 * no secret or contact data (it is sent to the person through Meta, as written); the schedule's first occurrence after `now`
 * exists and is at most `MAX_DAYS_AHEAD` days away. Every send is at least a day after the one before (a schedule holds
 * one time a day), so no check of that is left to make. What needs the person's own message (a secret in it, a number in the text
 * they did not write) is `checkTurn`'s: the conversation's rules.
 */
export function checkReminder(
  input: { what: string; schedule: Schedule | null },
  now: Date,
): ReminderCheck {
  const what = tidyWhat(tidyWords(input.what))
  if (looksContact(what) || /\+\d/.test(what)) return { ok: false, refused: 'contact' }
  if (holdsSecretValue(what)) return { ok: false, refused: 'secret' }
  if (what === '') return { ok: false, message: 'what is empty: it is what to remind them of' }
  if (hasForeignDigit(what)) return { ok: false, message: 'what has digits that are not 0-9' }
  if (what.length > MAX_WHAT) {
    return { ok: false, message: `what is too long: at most ${MAX_WHAT} characters, in one line` }
  }
  // From `now` on (see `normalizeSchedule`): a start that has passed is moved to the first occurrence, never drained by `count`.
  const schedule = input.schedule && normalizeSchedule(input.schedule, now)
  const first = schedule && nextOccurrence(schedule, now)
  if (!schedule || !first) return { ok: false, refused: 'past' }
  if (first.getTime() - now.getTime() > MAX_DAYS_AHEAD * DAY_MS)
    return { ok: false, refused: 'far' }
  return { ok: true, what, schedule, first }
}

/** What `set_reminder` sends: the text, when it first fires as the person said it, and the repeat fields. */
export type ReminderInput = { what: string; first: First } & z.input<typeof RepeatSchema>

/**
 * The schedule a `set_reminder` input comes to, from the instant of the message: `first` is resolved to a day and a clock time
 * (`resolveFirst`), joined with the repeat fields and parsed, then counted from `now` (`normalizeSchedule`). A string is why it
 * cannot be a schedule (for the model); null means it has no occurrence after `now`. Pure and deterministic, so the guard and
 * the commit point reach the same schedule from the same input and instant.
 */
export function scheduleOf(input: ReminderInput, now: Date): Schedule | string | null {
  const { what: _, first, ...repeat } = input
  const parsed = ScheduleSchema.safeParse({ ...resolveFirst(first, now), ...repeat })
  if (!parsed.success) {
    return parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'schedule'}: ${i.message}`)
      .join('; ')
  }
  return normalizeSchedule(parsed.data, now)
}
