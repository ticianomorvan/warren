import { describe, expect, it } from 'vitest'
import type { Call } from '../core/commands'
import type { Question } from '../core/turn'
import { answerNumber, codeAnswer, disconnectRequest, linkCode } from './resolve'

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

const answer = (
  text: string,
  question: Question | null,
  o: { typed?: boolean; signIn?: boolean } = {},
) => codeAnswer(text, { question, typed: o.typed ?? true, signIn: o.signIn ?? false })
const call = (c: Call) => ({ kind: 'call', call: c })

describe('codeAnswer: the answer to a question', () => {
  const options = [
    { n: 1, id: 41 },
    { n: 2, id: 37 },
  ]
  const changes = { amount: '5000' }
  const correct: Question = { options, then: { do: 'correct', changes } }
  const remove: Question = { options, then: { do: 'delete' } }
  const open: Question = { options, then: { do: 'ask_change' } }
  const one = (q: Question): Question => ({
    ...q,
    options: [options[0] as { n: number; id: number }],
  })

  it('runs the pending correction on the option that was picked, by id', () => {
    expect(answer('2', correct)).toEqual(
      call({ tool: 'correct_movement', input: { id: 37, changes } }),
    )
    expect(answer('la primera', correct)).toEqual(
      call({ tool: 'correct_movement', input: { id: 41, changes } }),
    )
  })

  it('runs the pending deletion', () => {
    expect(answer('dale el 1', remove)).toEqual(
      call({ tool: 'delete_movement', input: { id: 41 } }),
    )
  })

  it('narrows a question with no action behind it to the one movement picked, and asks about it alone', () => {
    expect(answer('2', open)).toEqual(
      call({ tool: 'ask_user', input: { movement_ids: [37], then: { do: 'ask_change' } } }),
    )
    expect(answer('la primera', open)).toMatchObject({ call: { input: { movement_ids: [41] } } })
    // not a pick of an option: the model reads it
    expect(answer('el 2 fue 4500', open)).toBeNull()
    expect(answer('sí', open)).toBeNull()
    // one option: a bare "1" goes to the model (narrowing it again would loop on the number)
    expect(answer('1', one(open))).toBeNull()
  })

  it('answers "ese" or "sí" after a one-option question by asking about that same movement, never others (live #79)', () => {
    for (const text of ['ese', 'Ese.', 'sí', 'dale', 'sí, ese', 'ese mismo', 'esa', 'el mismo']) {
      expect(answer(text, one(open)), text).toEqual(
        call({ tool: 'ask_user', input: { movement_ids: [41], then: { do: 'ask_change' } } }),
      )
    }
    // with a change it is the model's: "a ese ponele 3500", "ese fue 3500"
    for (const text of ['a ese ponele 3500', 'ese fue 3500', 'ponele 3500']) {
      expect(answer(text, one(open)), text).toBeNull()
    }
    // "ese" among several options picks nothing: the model reads it
    expect(answer('ese', open)).toBeNull()
  })

  it('takes "ese" as a yes to a pending action with one option', () => {
    expect(answer('ese', one(remove))).toEqual(call({ tool: 'delete_movement', input: { id: 41 } }))
  })

  it('is nothing without a question, or when the message is more than an answer', () => {
    expect(answer('2', null)).toBeNull()
    expect(answer('el 2 fue 4500', remove)).toBeNull()
    expect(answer('3', remove)).toBeNull()
    expect(answer('sí', remove)).toBeNull() // two options
  })

  it('is never an answer to a voice note or a photo: a delete is not run on what a model of speech heard', () => {
    expect(answer('2', remove, { typed: false })).toBeNull()
    expect(answer('deshacer', null, { typed: false })).toBeNull()
  })
})

describe('codeAnswer: the confirmation of forgetting everything', () => {
  const question: Question = { options: [], then: { do: 'forget_all' } }
  const confirmed = call({ tool: 'forget_all_confirmed', input: {} })

  it('only a bare yes confirms it', () => {
    for (const yes of ['sí', 'si', 'Sí.', 'dale', 'ok', 'sí, dale', 'bueno'])
      expect(answer(yes, question), yes).toEqual(confirmed)
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
      expect(answer(no, question), no).toBeNull()
    }
  })

  it('without the question there is nothing to confirm', () => {
    expect(answer('sí', null)).toBeNull()
  })
})

describe('codeAnswer: a sign-in', () => {
  const question: Question = { options: [], then: { do: 'link', link_id: 7 } }

  it('only a bare "sí" confirms it and only a bare "no" declines it', () => {
    for (const yes of ['sí', 'Sí', 'si', 'SI!', 'sí.']) {
      expect(answer(yes, question), yes).toEqual({ kind: 'link_confirm', linkId: 7 })
    }
    for (const no of ['no', 'No.', 'nop']) {
      expect(answer(no, question), no).toEqual({ kind: 'link_decline', linkId: 7 })
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
      expect(answer(other, question), other).toBeNull()
    }
  })

  it('"vincular <code>" asks about it, even with another question open, and only where connecting is on', () => {
    expect(answer('vincular K7M2QX', null, { signIn: true })).toEqual({
      kind: 'link_ask',
      code: 'K7M2QX',
    })
    expect(answer('vincular K7M2QX', question, { signIn: true })).toEqual({
      kind: 'link_ask',
      code: 'K7M2QX',
    })
    expect(answer('vincular K7M2QX', null)).toBeNull()
  })
})

describe('codeAnswer: a bare "deshacer" and "desconectar"', () => {
  it('undoes the last turn, when no question is open', () => {
    for (const text of [
      'deshacer',
      'Deshacé',
      'ay, deshacelo',
      'volvé atrás',
      'anulá lo que hiciste',
    ]) {
      expect(answer(text, null), text).toEqual(call({ tool: 'undo_last', input: {} }))
    }
  })

  it('not what names one movement, not "todo", not the opposite, and not while a question is open', () => {
    for (const text of [
      'deshacé el café',
      'deshacer todo',
      'no deshacer',
      'mejor no anular',
      'café 3500',
    ]) {
      expect(answer(text, null), text).toBeNull()
    }
    const open: Question = {
      options: [
        { n: 1, id: 1 },
        { n: 2, id: 2 },
      ],
      then: { do: 'delete' },
    }
    expect(answer('deshacer', open)).toBeNull()
  })

  it('"desconectar" cuts the connections, only where connecting is on', () => {
    expect(answer('desconectá a Claude', null, { signIn: true })).toEqual({ kind: 'disconnect' })
    expect(answer('desconectar', null)).toBeNull()
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

describe('disconnectRequest', () => {
  it('reads a typed message that is only "desconectar", with or without Claude, and nothing with more in it', () => {
    for (const yes of [
      'desconectar',
      'Desconectá',
      'desconectá a Claude',
      'Desconectar Claude.',
      'por favor desconectar todo',
      'desconectame',
      'desconectar las conexiones',
    ]) {
      expect(disconnectRequest(yes), yes).toBe(true)
    }
    for (const no of [
      'desconectar y borrar todo',
      'no desconectar',
      'café desconectar',
      'conectar',
      'desconectar el wifi',
      '',
    ]) {
      expect(disconnectRequest(no), no).toBe(false)
    }
  })
})
