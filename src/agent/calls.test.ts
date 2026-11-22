import { describe, expect, it } from 'vitest'
import { REPLY_FACT_SECRET, REPLY_REMINDER_FAR, REPLY_REMINDER_PAST } from '../render'
import { checkCall, checkInput, type Guard } from './calls'
import { MAX_FOUND } from './schema'

const TODAY = '2026-11-18'
const guard = (o: Partial<Guard> = {}): Guard => ({
  today: TODAY,
  seen: new Set(),
  logged: 0,
  ...o,
})

const cafe = {
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: TODAY,
  description: 'café',
  category: 'restaurantes',
  payment: null,
  confidence: 'high',
}
const log = (n = 1) => ({ movements: Array.from({ length: n }, () => cafe), text: null })
const correct = (id: number) => ({
  id,
  changes: { amount: '3800' },
  text: null,
})

/**
 * Two layers: the value guards (`checkInput`: what any sender's input must be) and the conversation guards `checkCall` adds
 * for WhatsApp's model (what it was shown, what the message already holds). Values are the same under both.
 */
describe('checkInput: values alone, no conversation', () => {
  it('needs no ids shown, no message and no count of the message', () => {
    expect(checkInput('correct_movement', correct(99), TODAY).kind).toBe('action')
    expect(checkInput('log_movements', log(), TODAY).kind).toBe('action')
    expect(
      checkInput(
        'remember_fact',
        { kind: 'note', key: 'cobro', value: 'el cinco', text: null },
        TODAY,
      ).kind,
    ).toBe('action') // the words need not be the person's own: nobody wrote a message
  })

  it('still refuses every value a table cannot hold', () => {
    const bad = (name: string, input: unknown) => checkInput(name, input, TODAY)
    expect(
      bad('log_movements', { movements: [{ ...cafe, amount: '3,500' }], text: null }).kind,
    ).toBe('rejected')
    expect(
      bad('log_movements', { movements: [{ ...cafe, date: '2026-11-19' }], text: null }).kind,
    ).toBe('rejected')
    expect(
      bad('log_movements', { movements: [{ ...cafe, date: '2026-02-30' }], text: null }),
    ).toMatchObject({
      kind: 'rejected',
      message: expect.stringContaining('date does not exist'),
    })
    expect(bad('log_movements', log(11)).kind).toBe('rejected')
    expect(bad('correct_movement', { id: 1, changes: {}, text: null }).kind).toBe('rejected')
    expect(bad('find_movements', { to: '2026-02-30' })).toMatchObject({
      kind: 'rejected',
      message: 'to "2026-02-30": date does not exist',
    })
    expect(bad('find_movements', { amount: 'mucho' }).kind).toBe('rejected')
    expect(bad('summarize', {})).toMatchObject({
      kind: 'rejected',
      message: expect.stringContaining('invalid input'),
    })
    expect(bad('nope', {})).toEqual({ kind: 'rejected', message: 'unknown tool nope' })
  })

  it('refuses a secret in a fact, whoever sends it: a notice, not a retry', () => {
    const r = checkInput(
      'remember_fact',
      { kind: 'note', key: 'tarjeta', value: '4509 9535 6623 3704', text: null },
      TODAY,
    )
    expect(r).toMatchObject({ kind: 'action', action: { tool: 'notice' } })
  })

  it('leaves the size of a page to the caller', () => {
    const r = checkInput('find_movements', { limit: 500 }, TODAY)
    expect(r).toMatchObject({ kind: 'read', filter: { limit: 500 } })
  })
})

describe('checkCall: the conversation on top of the values', () => {
  it('an id the model was not shown is refused, one it was shown goes through', () => {
    expect(checkCall('correct_movement', correct(99), guard()).kind).toBe('rejected')
    expect(checkCall('correct_movement', correct(99), guard({ seen: new Set([99]) })).kind).toBe(
      'action',
    )
    expect(checkCall('delete_movement', { id: 5, text: null }, guard()).kind).toBe('rejected')
  })

  it('the movements of the whole message are counted, not only this call', () => {
    expect(checkCall('log_movements', log(6), guard({ logged: 5 })).kind).toBe('rejected')
    expect(checkCall('log_movements', log(5), guard({ logged: 5 })).kind).toBe('action')
  })

  it("WhatsApp's model is capped at MAX_FOUND rows a search", () => {
    const r = checkCall('find_movements', { limit: 500 }, guard())
    expect(r).toMatchObject({ kind: 'read', filter: { limit: MAX_FOUND } })
    expect(checkCall('find_movements', {}, guard())).toMatchObject({
      kind: 'read',
      filter: { limit: 10 },
    })
  })

  it('a fact is words the person wrote, a value rule alone does not ask for that', () => {
    const fact = { kind: 'note', key: 'cobro', value: 'el cinco', text: null }
    expect(checkCall('remember_fact', fact, guard({ message: 'otra cosa' })).kind).toBe('rejected')
    expect(checkCall('remember_fact', fact, guard({ message: 'cobro el cinco' })).kind).toBe(
      'action',
    )
  })

  it('a fact id the model was not shown is refused', () => {
    const forget = { id: 7, key: '', text: null }
    expect(checkCall('forget_fact', forget, guard()).kind).toBe('rejected')
    expect(checkCall('forget_fact', forget, guard({ seenFacts: new Set([7]) })).kind).toBe('action')
  })

  it('the same value refusals as the values alone', () => {
    const input = { movements: [{ ...cafe, amount: '3,500' }], text: null }
    expect(checkCall('log_movements', input, guard())).toEqual(
      checkInput('log_movements', input, TODAY),
    )
  })
})

// ---- Reminders (slice 6).

const NOW = new Date('2026-11-18T15:00:00Z') // 12:00 in Argentina, Wednesday
const reminder = (o: Record<string, unknown> = {}, schedule: Record<string, unknown> = {}) => ({
  what: 'pagar la Visa',
  schedule: { start: '2026-11-20', time: '09:00', interval: 1, ...schedule },
  text: null,
  ...o,
})
const set = (input: unknown, g: Partial<Guard> = {}) =>
  checkCall('set_reminder', input, guard({ now: NOW, message: 'recordame pagar la visa', ...g }))
const notice = (c: ReturnType<typeof set>) =>
  c.kind === 'action' && c.action.tool === 'notice' ? c.action.input.text : null

describe('set_reminder', () => {
  it('accepts a schedule with a first occurrence in the next year and keeps what code understood', () => {
    const c = set(reminder())
    expect(c).toMatchObject({
      kind: 'action',
      action: { tool: 'set_reminder', input: { what: 'pagar la Visa' } },
    })
  })

  it('puts the text on one line', () => {
    const c = set(reminder({ what: '  pagar \n la   Visa ' }))
    expect(c).toMatchObject({ kind: 'action', action: { input: { what: 'pagar la Visa' } } })
  })

  it('answers a time that has passed with code’s own line, not a retry', () => {
    const c = set(reminder({}, { start: '2026-11-18', time: '09:00' }))
    expect(notice(c)).toBe(REPLY_REMINDER_PAST)
    expect(notice(set(reminder({}, { start: '2026-11-17' })))).toBe(REPLY_REMINDER_PAST)
  })

  it('accepts a time later today', () => {
    expect(set(reminder({}, { start: '2026-11-18', time: '18:00' })).kind).toBe('action')
    expect(notice(set(reminder({}, { start: '2026-11-18', time: '18:00' })))).toBeNull()
  })

  it('refuses a first occurrence more than 366 days away, and allows exactly that far', () => {
    expect(notice(set(reminder({}, { start: '2027-11-20' })))).toBe(REPLY_REMINDER_FAR)
    expect(notice(set(reminder({}, { start: '2027-11-19', time: '12:00' })))).toBeNull()
    expect(notice(set(reminder({}, { start: '2027-11-19', time: '12:01' })))).toBe(
      REPLY_REMINDER_FAR,
    )
  })

  it('refuses a secret or contact data in the text, and the person is told (not the model)', () => {
    for (const what of [
      'pagar con la clave 7788',
      'llamar al 11 5555 1234',
      'mandar a juan@mail.com',
    ]) {
      const c = set(reminder({ what }), { message: what })
      expect(notice(c), what).not.toBeNull()
    }
    expect(notice(set(reminder({ what: 'la clave del banco' })))).toBe(REPLY_FACT_SECRET)
    // The model drops the secret from the text, but the message held one: nothing is set.
    const clean = set(reminder({ what: 'pagar' }), {
      message: 'recordame mañana pagar con la clave 7788',
    })
    expect(notice(clean)).toBe(REPLY_FACT_SECRET)
  })

  it('refuses text that is empty or too long, and a number the person did not write, to the model', () => {
    expect(set(reminder({ what: '  ' })).kind).toBe('rejected')
    expect(set(reminder({ what: 'x'.repeat(101) })).kind).toBe('rejected')
    expect(set(reminder({ what: 'pagar 4509 de la visa' })).kind).toBe('rejected')
    expect(
      set(reminder({ what: 'pagar 4509 de la visa' }), { message: 'recordame pagar 4509' }).kind,
    ).toBe('action')
  })

  it('refuses a schedule that does not parse, with the reason', () => {
    expect(set(reminder({}, { every: 'week', month_days: [1] }))).toMatchObject({
      kind: 'rejected',
      message: expect.stringContaining('schedule.month_days'),
    })
    expect(set(reminder({}, { start: '2026-02-30' })).kind).toBe('rejected')
    expect(set(reminder({}, { time: '25:00' })).kind).toBe('rejected')
    expect(set(reminder({}, { cron: '* * * * *' })).kind).toBe('rejected')
  })

  it('is checked the same without a conversation (the value guards)', () => {
    expect(checkInput('set_reminder', reminder(), TODAY, NOW).kind).toBe('action')
    expect(
      notice(checkInput('set_reminder', reminder({}, { start: '2026-11-17' }), TODAY, NOW)),
    ).toBe(REPLY_REMINDER_PAST)
  })
})

describe('cancel_reminder', () => {
  it('needs an id the model was shown', () => {
    const input = { id: 7, text: null }
    expect(checkCall('cancel_reminder', input, guard({ seenReminders: new Set([7]) })).kind).toBe(
      'action',
    )
    expect(checkCall('cancel_reminder', input, guard({ seenReminders: new Set([8]) })).kind).toBe(
      'rejected',
    )
    expect(checkCall('cancel_reminder', input, guard()).kind).toBe('rejected')
    // A movement's or a fact's id is in another space.
    expect(
      checkCall('cancel_reminder', input, guard({ seen: new Set([7]), seenFacts: new Set([7]) }))
        .kind,
    ).toBe('rejected')
  })

  it('refuses an id that is not positive', () => {
    expect(
      checkCall('cancel_reminder', { id: 0, text: null }, guard({ seenReminders: new Set([0]) }))
        .kind,
    ).toBe('rejected')
  })
})
