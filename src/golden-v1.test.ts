import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CASES, SAID, TODAY, view } from '../test/golden-cases'
import type { Outcome } from './core/apply'
import type { View } from './core/describe'
import { MAX_FACTS } from './domain/facts'
import {
  REPLY_FACT_CONTACT,
  REPLY_FACT_SECRET,
  REPLY_FACTS_NONE,
  REPLY_GONE,
  REPLY_REMINDER_FAR,
  REPLY_REMINDER_GONE,
  REPLY_REMINDER_PAST,
  REPLY_UNDO_EXPIRED,
  REPLY_UNDO_NOTHING,
  reminderReply,
  renderAsk,
  renderCorrection,
  renderDeletion,
  renderFacts,
  renderFactsFull,
  renderForgetAllAsk,
  renderForgot,
  renderForgotAll,
  renderForgotNone,
  renderKnown,
  renderLog,
  renderRemembered,
  renderReminderCancelled,
  renderReminders,
  renderRemindersFull,
  renderStale,
  renderUnchanged,
  renderUndo,
  undoLine,
} from './render'

/**
 * v1's own strings for the situations in `test/golden-cases.ts`, from v1's render code (`render.ts`, as `execute.ts` composes it). The
 * committed fixture `test/golden/v1-replies.json` is what the permanent golden test (`core/golden.test.ts`) reads, so it keeps working
 * when v1 is deleted; this file proves the fixture is v1's output, and rewrites it with UPDATE_GOLDEN=1. The slice that deletes v1
 * deletes this file.
 */

const FIXTURE = new URL('../test/golden/v1-replies.json', import.meta.url)

/** What execute.ts would have rendered for the same outcome: its branches, over v1's render functions. */
function v1Line(o: Outcome, v: View): string {
  const { today, newest } = v
  switch (o.tool) {
    case 'log_movements':
      return renderLog(o.movements, today)
    case 'correct_movement':
      if (o.status === 'gone') return REPLY_GONE
      if (o.status === 'unchanged') return renderUnchanged(o.old, today)
      return renderCorrection(o.old, o.next, o.changed, today, o.old.id === newest)
    case 'delete_movement':
      return o.status === 'gone' ? REPLY_GONE : renderDeletion(o.old, today, o.old.id === newest)
    case 'undo_last':
      if (o.status === 'applied') return renderUndo(o.items.map(undoLine), today)
      if (o.status === 'nothing' || o.status === 'restricted') return REPLY_UNDO_NOTHING
      if (o.status === 'expired') return REPLY_UNDO_EXPIRED
      if (o.status === 'stale')
        return renderStale(o.moved.movements, today, o.moved.facts, o.moved.reminders)
      throw new Error('blocked is new: v1 had no such reply')
    case 'remember_fact':
      if (o.status === 'full') return renderFactsFull(MAX_FACTS)
      if (o.status === 'unchanged') return renderKnown(o.fact)
      return renderRemembered(o.fact, o.before)
    case 'forget_fact':
      if (o.status === 'applied') return o.facts.map(renderForgot).join('\n')
      return 'id' in o.target ? '🧠 Eso ya lo había olvidado.' : renderForgotNone(o.target.key)
    case 'forget_all_confirmed':
      return o.status === 'applied' ? renderForgotAll(o.facts.length) : renderFacts([])
    case 'set_reminder':
      if (o.status === 'applied')
        return reminderReply({ tool: o.tool, kind: 'applied', reminder: o.reminder }, today, 20)
          .line
      return o.status === 'full' ? renderRemindersFull(o.max) : REPLY_REMINDER_PAST
    case 'cancel_reminder':
      return o.status === 'gone' ? REPLY_REMINDER_GONE : renderReminderCancelled(o.reminder, today)
  }
}

/** The lines that are not a write's outcome, under the names the golden test uses. */
function v1Said(): Record<string, string> {
  const t = TODAY
  return {
    'facts list': renderFacts(SAID.facts),
    'facts none': REPLY_FACTS_NONE,
    'reminders list': renderReminders(SAID.reminders, t),
    'reminders none': renderReminders([], t),
    'forget everything asks': renderForgetAllAsk(3),
    'ask: several options, delete': renderAsk('Cuál', SAID.options, 'delete', t),
    'ask: several options, correct': renderAsk('Cuál', SAID.options, 'correct', t),
    'ask: several options, ask what to change': renderAsk('Cuál', SAID.options, 'none', t),
    'ask: alike options show the time': renderAsk('Cuál', SAID.alike, 'delete', t),
    'ask: one option, ask what to change': renderAsk('Qué querés cambiar', [SAID.one], 'none', t),
    'ask: no option': renderAsk('Qué querés cambiar', [], 'none', t),
    'decline: secret': REPLY_FACT_SECRET,
    'decline: contact': REPLY_FACT_CONTACT,
    'decline: reminder past': REPLY_REMINDER_PAST,
    'decline: reminder far': REPLY_REMINDER_FAR,
  }
}

function v1Strings() {
  const cases = Object.fromEntries(CASES.map((c) => [c.name, v1Line(c.outcome, c.view ?? view)]))
  return { cases, said: v1Said() }
}

describe('the golden fixture is what v1 renders', () => {
  it('has the same strings (rewrite it with UPDATE_GOLDEN=1)', () => {
    const live = v1Strings()
    if (process.env.UPDATE_GOLDEN) writeFileSync(FIXTURE, `${JSON.stringify(live, null, 2)}\n`)
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(live)
    expect(CASES.length + Object.keys(live.said).length).toBeGreaterThanOrEqual(40)
  })
})
