import { describe, expect, it } from 'vitest'
import type { MovementRow } from '../domain/movements'
import { declineLine, describe as say } from './describe'
import { DECLINES } from './guards'

const TODAY = '2026-11-20'
const row = (o: Partial<MovementRow> = {}): MovementRow => ({
  id: 1,
  version: 1,
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: TODAY,
  description: 'café',
  category: 'restaurantes',
  payment: null,
  confidence: 'high',
  time: '12:00',
  loggedAt: new Date('2026-11-20T15:00:00Z'),
  ...o,
})
const view = { today: TODAY, newest: null }

describe('the line of an outcome', () => {
  it('a log is one line for one movement and a bulleted list for several', () => {
    expect(
      say({ tool: 'log_movements', status: 'applied', effect: 'logged', movements: [row()] }, view),
    ).toBe('✓ Café $3.500')
    const many = say(
      {
        tool: 'log_movements',
        status: 'applied',
        effect: 'logged',
        movements: [
          row(),
          row({ id: 2, description: 'súper', amount: '12000', date: '2026-11-19' }),
        ],
      },
      view,
    )
    expect(many).toBe('✓ Anoté 2:\n• Café $3.500\n• Súper $12.000 · ayer')
  })

  it('says a change did not happen when the movement is gone', () => {
    const line = say({ tool: 'delete_movement', status: 'gone', effect: null, id: 9 }, view)
    expect(line).toMatch(/ya fue corregido o borrado/)
    expect(line).not.toMatch(/WhatsApp/i)
  })

  it('an undo of a log names what it took back', () => {
    expect(
      say(
        {
          tool: 'undo_last',
          status: 'applied',
          effect: 'undone',
          turn: 3,
          items: [{ kind: 'logged', movement: row() }],
        },
        view,
      ),
    ).toBe('↩︎ Deshice: Café $3.500')
  })

  it('every decline code has its line, and no two share one', () => {
    const lines = DECLINES.map(declineLine)
    expect(new Set(lines).size).toBe(DECLINES.length)
  })
})
