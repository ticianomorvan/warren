import { holdsSecretValue, looksContact, tidy as tidyWords } from '../agent/memory'
import { hasForeignDigit, unwritten } from '../agent/say'
import { tidyWhat } from './db'
import { nextOccurrence, normalizeSchedule, type Schedule } from './schedule'

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
 * one time a day), so no check of that is left to make. `message` is the person's own message, when there is one: a number
 * in the text must be one they wrote.
 */
export function checkReminder(
  input: { what: string; schedule: Schedule },
  now: Date,
  message?: string,
): ReminderCheck {
  const what = tidyWhat(tidyWords(input.what))
  if (looksContact(what) || /\+\d/.test(what)) return { ok: false, refused: 'contact' }
  // A message that holds a secret sets no reminder, whatever the model leaves of it in `what`: the person is told and it is wiped.
  if (holdsSecretValue(what) || (message !== undefined && holdsSecretValue(message))) {
    return { ok: false, refused: 'secret' }
  }
  if (what === '') return { ok: false, message: 'what is empty: it is what to remind them of' }
  if (hasForeignDigit(what)) return { ok: false, message: 'what has digits that are not 0-9' }
  if (what.length > MAX_WHAT) {
    return { ok: false, message: `what is too long: at most ${MAX_WHAT} characters, in one line` }
  }
  if (message !== undefined) {
    const made = unwritten(what, message)
    if (made.length > 0) {
      return {
        ok: false,
        message: `numbers the person did not write in what: ${[...new Set(made)].join(', ')}. Leave them out`,
      }
    }
  }
  // From `now` on (see `normalizeSchedule`): a start that has passed is moved to the first occurrence, never drained by `count`.
  const schedule = normalizeSchedule(input.schedule, now)
  const first = schedule && nextOccurrence(schedule, now)
  if (!schedule || !first) return { ok: false, refused: 'past' }
  if (first.getTime() - now.getTime() > MAX_DAYS_AHEAD * DAY_MS)
    return { ok: false, refused: 'far' }
  return { ok: true, what, schedule, first }
}
