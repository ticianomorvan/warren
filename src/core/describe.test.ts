import { describe, expect, it } from 'vitest'
import { SAID, TODAY } from '../../test/golden-cases'
import { SKIP_REASONS } from './commands'
import { askLine, declineLine, describe as say, skipLine } from './describe'
import { DECLINES } from './guards'

describe('the lines code says that v1 did not', () => {
  it('a skip is rendered by code, one line per reason', () => {
    expect(skipLine('la nafta del lunes', 'not_found')).toBe('No encontré la nafta del lunes.')
    expect(skipLine('el súper', 'what_to_change')).toBe('¿Qué querés cambiar del súper?')
    expect(skipLine('un préstamo', 'cannot')).toBe('Un préstamo: eso no lo puedo hacer.')
    expect(skipLine('lo de la tarjeta', 'separately')).toBe('Mandame lo de la tarjeta aparte.')
    expect(SKIP_REASONS).toHaveLength(4)
  })

  it('every decline code has its line, and no two share one', () => {
    const lines = DECLINES.map(declineLine)
    expect(new Set(lines).size).toBe(DECLINES.length)
  })

  it('a blocked undo names what blocks it and points to fixing the older change directly', () => {
    const reminder = SAID.reminders[0] as (typeof SAID.reminders)[number]
    const blocked = (why: 'sent' | 'past' | 'cap') =>
      say(
        {
          tool: 'undo_last',
          status: 'blocked',
          effect: null,
          turn: 3,
          blocking: { movements: [], facts: [], reminders: [reminder] },
          why: [why],
        },
        { today: TODAY, newest: null },
      )
    expect(blocked('sent')).toContain(
      'ya se mandó y no se puede deshacer, así que tampoco lo anterior',
    )
    expect(blocked('past')).toContain('ya pasó su fecha')
    expect(blocked('cap')).toContain('no entra: ya tenés el máximo')
    for (const why of ['sent', 'past', 'cap'] as const)
      expect(blocked(why)).toContain('decime qué, por ejemplo "corregí el café"')
  })

  it('a question about one movement asks what to change; about several, which', () => {
    expect(askLine([SAID.one], { do: 'ask_change' }, TODAY)).toMatch(
      /^¿Qué querés cambiar\? Nafta YPF/,
    )
    expect(askLine(SAID.options, { do: 'delete' }, TODAY)).toMatch(
      /^¿Cuál\? 1\. .*\nRespondé con el número, por ejemplo "el 1"\.$/,
    )
  })
})
