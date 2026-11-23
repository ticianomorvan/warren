import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CASES, SAID, TODAY, view } from '../../test/golden-cases'
import {
  askLine,
  declineLine,
  describeFacts,
  describeReminders,
  forgetAllQuestion,
  describe as say,
} from './describe'

/**
 * The golden test: the Spanish `describe()` renders, for a fixed set of outcomes that spans every write tool and every status, the
 * strings v1 rendered for the same situations, byte for byte. The one exception is the date format the spec unified: `05/12`, plus
 * `/25` outside the current year, where v1's reminder lines wrote `5/12` and `/2025`. The strings are v1's own, captured by
 * `src/golden-v1.test.ts` from v1's render code into `test/golden/v1-replies.json` (so this test outlives v1).
 */

const fixture = JSON.parse(
  readFileSync(new URL('../../test/golden/v1-replies.json', import.meta.url), 'utf8'),
) as {
  cases: Record<string, string>
  said: Record<string, string>
}

const pad = (n: string) => n.padStart(2, '0')
/** v1's reminder dates (`5/12`, `4/1/2027`) in the unified format (`05/12`, `04/01/27`): the only change the spec makes. */
const unifyDates = (text: string) =>
  text.replace(
    /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g,
    (_, d: string, m: string, y?: string) => `${pad(d)}/${pad(m)}${y ? `/${y.slice(-2)}` : ''}`,
  )

describe('describe() against what v1 rendered', () => {
  it('covers every write tool and every status the outcomes have, in at least 40 cases', () => {
    const seen = new Set(CASES.map((c) => `${c.outcome.tool}:${c.outcome.status}`))
    expect([...seen].sort()).toEqual(
      [
        'log_movements:applied',
        'correct_movement:gone',
        'correct_movement:unchanged',
        'correct_movement:applied',
        'delete_movement:gone',
        'delete_movement:applied',
        'undo_last:nothing',
        'undo_last:restricted',
        'undo_last:expired',
        'undo_last:applied',
        'remember_fact:applied',
        'remember_fact:unchanged',
        'remember_fact:full',
        'forget_fact:applied',
        'forget_fact:gone',
        'forget_all_confirmed:applied',
        'forget_all_confirmed:nothing',
        'set_reminder:applied',
        'set_reminder:full',
        'set_reminder:past',
        'cancel_reminder:applied',
        'cancel_reminder:gone',
      ].sort(),
    )
    expect(CASES.length + Object.keys(fixture.said).length).toBeGreaterThanOrEqual(40)
  })

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (name, c) => {
    const v1 = fixture.cases[name] as string
    expect(v1, 'a case without a fixture string').toBeTypeOf('string')
    expect(say(c.outcome, c.view ?? view)).toBe(unifyDates(v1))
  })

  it('changes nothing but dates: where a string differs from v1’s, only its dates do', () => {
    const changed = CASES.filter((c) => say(c.outcome, c.view ?? view) !== fixture.cases[c.name])
    expect(changed.map((c) => c.name).sort()).toEqual(
      [
        'remind a one-off, one digit of day',
        'remind a one-off, next year',
        'remind monthly on two days',
        'remind on the nth weekday and the last day',
        'remind every year',
        'remind on weekdays, with an end',
      ].sort(),
    )
    for (const c of changed)
      expect(say(c.outcome, c.view ?? view)).toBe(unifyDates(fixture.cases[c.name] as string))
  })

  it('the lines code says that are not a write: lists, questions, declines', () => {
    const t = TODAY
    const got: Record<string, string> = {
      'facts list': describeFacts(SAID.facts),
      'facts none': describeFacts([]),
      'reminders list': describeReminders(SAID.reminders, t),
      'reminders none': describeReminders([], t),
      'forget everything asks': forgetAllQuestion(3),
      'ask: several options, delete': askLine(SAID.options, { do: 'delete' }, t),
      'ask: several options, correct': askLine(
        SAID.options,
        { do: 'correct', changes: { amount: '4100' } },
        t,
      ),
      'ask: several options, ask what to change': askLine(SAID.options, { do: 'ask_change' }, t),
      'ask: alike options show the time': askLine(SAID.alike, { do: 'delete' }, t),
      'ask: one option, ask what to change': askLine([SAID.one], { do: 'ask_change' }, t),
      'ask: no option': askLine([], { do: 'ask_change' }, t),
      'decline: secret': declineLine('secret'),
      'decline: contact': declineLine('contact'),
      'decline: reminder past': declineLine('reminder_past'),
      'decline: reminder far': declineLine('reminder_far'),
    }
    expect(Object.keys(got).sort()).toEqual(Object.keys(fixture.said).sort())
    for (const [name, text] of Object.entries(got))
      expect(text, name).toBe(unifyDates(fixture.said[name] as string))
  })
})
