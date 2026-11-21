import { describe, expect, it } from 'vitest'
import { answerAction, answerNumber } from './resolve'

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
      input: { id: 37, changes },
    })
    expect(answerAction('la primera', { asked, pending: { action: 'correct', changes } })).toEqual({
      tool: 'correct_movement',
      input: { id: 41, changes },
    })
  })

  it('runs the pending deletion', () => {
    expect(answerAction('dale el 1', { asked, pending: { action: 'delete' } })).toEqual({
      tool: 'delete_movement',
      input: { id: 41 },
    })
  })

  it('is nothing without a pending action, or when the message is more than an answer', () => {
    expect(answerAction('2', { asked, pending: null })).toBeNull()
    expect(answerAction('2', null)).toBeNull()
    expect(answerAction('el 2 fue 4500', { asked, pending: { action: 'delete' } })).toBeNull()
    expect(answerAction('3', { asked, pending: { action: 'delete' } })).toBeNull()
    expect(answerAction('sí', { asked, pending: { action: 'delete' } })).toBeNull() // two options
  })
})
