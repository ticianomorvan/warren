import { describe, expect, it } from 'vitest'
import { answerAction, answerNumber, linkCode, type PendingQuestion } from './resolve'

describe('answerNumber', () => {
  it('reads a message that is only the pick of one of the options shown', () => {
    const asked = [2, 3, 5]
    expect(answerNumber('2', asked)).toBe(2)
    expect(answerNumber('el 3', asked)).toBe(3)
    expect(answerNumber('la 5.', asked)).toBe(5)
    expect(answerNumber('dale el 2', asked)).toBe(2)
    expect(answerNumber('el tres', asked)).toBe(3)
    expect(answerNumber('el primero', asked)).toBe(2) // the first option shown
    expect(answerNumber('la primera', [4, 1])).toBe(4)
  })

  it('"el último" is list row 1, only if the question showed it', () => {
    expect(answerNumber('el último', [1, 2, 3])).toBe(1)
    expect(answerNumber('el último', [2, 3])).toBeNull()
  })

  it('"sí" and "dale" answer only a one-option question', () => {
    expect(answerNumber('sí', [4])).toBe(4)
    expect(answerNumber('dale', [4])).toBe(4)
    expect(answerNumber('sí', [4, 5])).toBeNull()
  })

  it('is not an answer when the message says more, or picks a row not shown', () => {
    expect(answerNumber('el 4', [1, 2, 3])).toBeNull()
    expect(answerNumber('el 2 fue 4500', [1, 2, 3])).toBeNull()
    expect(answerNumber('café 3500', [1, 2, 3])).toBeNull()
    expect(answerNumber('4500', [1, 2, 3])).toBeNull()
    expect(answerNumber('el anterior', [1, 2, 3])).toBeNull()
  })
})

describe('answerAction', () => {
  const asked = [
    { number: 1, id: 41 },
    { number: 2, id: 37 },
  ]
  const changes = { amount: '5000' }

  it('runs the pending correction on the option that was picked, by id', () => {
    expect(answerAction('2', { asked, pending: { action: 'correct', changes } })).toEqual({
      tool: 'correct_movement',
      input: { id: 37, changes, text: null },
    })
    expect(answerAction('la primera', { asked, pending: { action: 'correct', changes } })).toEqual({
      tool: 'correct_movement',
      input: { id: 41, changes, text: null },
    })
  })

  it('runs the pending deletion', () => {
    expect(answerAction('dale el 1', { asked, pending: { action: 'delete' } })).toEqual({
      tool: 'delete_movement',
      input: { id: 41, text: null },
    })
  })

  it('narrows a question with no action behind it to the one movement picked, and asks about it alone', () => {
    expect(answerAction('2', { asked, pending: null })).toEqual({
      tool: 'ask_user',
      input: { question: 'Qué querés cambiar', movement_ids: [37], after_answer: 'none' },
    })
    expect(answerAction('la primera', { asked, pending: null })).toMatchObject({
      input: { movement_ids: [41] },
    })
    // not a pick of an option: the model reads it
    expect(answerAction('el 2 fue 4500', { asked, pending: null })).toBeNull()
    expect(answerAction('sí', { asked, pending: null })).toBeNull()
    // one option: a bare "1" goes to the model (narrowing it again would loop on the number)
    const one = [asked[0] as (typeof asked)[number]]
    expect(answerAction('1', { asked: one, pending: null })).toBeNull()
  })

  it('answers "ese" or "sí" after a one-option question by asking about that same movement, never others (live #79)', () => {
    const one = [asked[0] as (typeof asked)[number]]
    for (const text of ['ese', 'Ese.', 'sí', 'dale', 'sí, ese', 'ese mismo', 'esa', 'el mismo']) {
      expect(answerAction(text, { asked: one, pending: null }), text).toEqual({
        tool: 'ask_user',
        input: { question: 'Qué querés cambiar', movement_ids: [41], after_answer: 'none' },
      })
    }
    // with a change it is the model's: "a ese ponele 3500", "ese fue 3500"
    for (const text of ['a ese ponele 3500', 'ese fue 3500', 'ponele 3500']) {
      expect(answerAction(text, { asked: one, pending: null }), text).toBeNull()
    }
    // "ese" among several options picks nothing: the model reads it
    expect(answerAction('ese', { asked, pending: null })).toBeNull()
  })

  it('takes "ese" as a yes to a pending action with one option', () => {
    const one = [asked[0] as (typeof asked)[number]]
    expect(answerAction('ese', { asked: one, pending: { action: 'delete' } })).toEqual({
      tool: 'delete_movement',
      input: { id: 41, text: null },
    })
  })

  it('is nothing without a pending action, or when the message is more than an answer', () => {
    expect(
      answerAction('2', { asked: [asked[0] as (typeof asked)[number]], pending: null }),
    ).toBeNull()
    expect(answerAction('2', null)).toBeNull()
    expect(answerAction('el 2 fue 4500', { asked, pending: { action: 'delete' } })).toBeNull()
    expect(answerAction('3', { asked, pending: { action: 'delete' } })).toBeNull()
    expect(answerAction('sí', { asked, pending: { action: 'delete' } })).toBeNull() // two options
  })
})

describe('answerAction: the confirmation of forgetting everything', () => {
  const question = { asked: [{ number: 1, id: 0 }], pending: { action: 'forget_all' as const } }
  const confirmed = { tool: 'forget_all_confirmed', input: {} }

  it('only a bare yes confirms it', () => {
    for (const yes of ['sí', 'si', 'Sí.', 'dale', 'ok', 'sí, dale', 'bueno'])
      expect(answerAction(yes, question), yes).toEqual(confirmed)
  })

  it('not a number, "ese", an ordinal, a no or anything with more in it', () => {
    for (const no of [
      '1',
      'el 1',
      'ese',
      'el primero',
      'no',
      'mejor no',
      'sí, pero la visa no',
      'borrá todo',
      'café 3500',
    ]) {
      expect(answerAction(no, question), no).toBeNull()
    }
  })

  it('without the question there is nothing to confirm', () => {
    expect(answerAction('sí', null)).toBeNull()
  })
})

describe('a sign-in question', () => {
  const question: PendingQuestion = { asked: [], pending: { action: 'link', link_id: 7 } }

  it('only a bare "sí" confirms it and only a bare "no" declines it', () => {
    for (const yes of ['sí', 'Sí', 'si', 'SI!', 'sí.']) {
      expect(answerAction(yes, question), yes).toEqual({
        tool: 'link_confirm',
        input: { link_id: 7 },
      })
    }
    for (const no of ['no', 'No.', 'nop']) {
      expect(answerAction(no, question), no).toEqual({
        tool: 'link_decline',
        input: { link_id: 7 },
      })
    }
  })

  it('nothing else is an answer to it: not ok, dale or bueno, not a number, not more words', () => {
    for (const other of [
      'ok',
      'dale',
      'bueno',
      'sí, dale',
      '1',
      'ese',
      'no sé',
      'café 3500',
      'sí pero no',
    ]) {
      expect(answerAction(other, question), other).toBeNull()
    }
  })
})

describe('linkCode', () => {
  it('reads "vincular <code>" and nothing else, in upper case', () => {
    expect(linkCode('vincular K7M2QX')).toBe('K7M2QX')
    expect(linkCode('  Vinculá k7m2qx. ')).toBe('K7M2QX')
    expect(linkCode('vincular K7M2Q')).toBeNull()
    expect(linkCode('vincular K7M2QX por favor')).toBeNull()
    expect(linkCode('café 3500 vincular K7M2QX')).toBeNull()
  })
})
