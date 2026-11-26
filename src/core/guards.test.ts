import { describe, expect, it } from 'vitest'
import { cafe, TODAY } from '../../test/core'
import { type Checked, checkValues, DECLINES } from './guards'

const env = { today: TODAY }
const values = (tool: string, input: unknown) => checkValues(tool, input, env)
const rejection = (c: Checked) => (c.kind === 'rejected' ? c.message : null)

describe('checkValues: what a call says', () => {
  it('refuses a tool that does not exist, one the registry no longer has, and an input of the wrong shape, with every issue', () => {
    expect(rejection(values('rm_rf', {}))).toBe('unknown tool rm_rf')
    expect(rejection(values('set_reminder', {}))).toBe('unknown tool set_reminder')
    expect(rejection(values('delete_movement', { id: 'x' }))).toMatch(/^invalid input: id: /)
    expect(rejection(values('correct_movement', { id: 1.5, changes: { amount: 3 } }))).toMatch(
      /id: .*; changes.amount: /,
    )
  })

  it('declines a secret or contact data in a movement’s words, as in a fact, for a log and for a correction', () => {
    const declined = (kind: 'secret' | 'contact') => ({ kind: 'declined', declined: kind })
    for (const description of ['clave del wifi perro', 'mi contraseña es azul']) {
      expect(values('log_movements', { movements: [cafe({ description })] })).toEqual(
        declined('secret'),
      )
    }
    expect(
      values('log_movements', {
        movements: [cafe({ description: 'transferencia a juan@mail.com' })],
      }),
    ).toEqual(declined('contact'))
    expect(
      values('log_movements', { movements: [cafe({ payment: 'cbu 0170099220000067797370' })] }),
    ).toEqual(declined('secret'))
    expect(
      values('correct_movement', { id: 1, changes: { description: 'clave del wifi perro' } }),
    ).toEqual(declined('secret'))
    expect(values('correct_movement', { id: 1, changes: { payment: 'juan@mail.com' } })).toEqual(
      declined('contact'),
    )
    // Plain words are not.
    expect(
      values('log_movements', { movements: [cafe({ description: 'café con juan' })] }).kind,
    ).toBe('ok')
  })

  it('accepts a log and keeps it as sent', () => {
    expect(values('log_movements', { movements: [cafe()] })).toEqual({
      kind: 'ok',
      call: { tool: 'log_movements', input: { movements: [cafe()] } },
    })
  })

  it.each([
    ['an amount with a thousands separator', { amount: '3,500' }, /amount/],
    ['a zero amount', { amount: '0' }, /amount/],
    ['a date after today', { date: '2026-11-21' }, /after today/],
    ['a day that does not exist', { date: '2026-02-30' }, /does not exist/],
    ['a description with a long number', { description: 'café 12000' }, /4 or more digits/],
    ['a payment with a long number', { payment: 'visa 4509' }, /4 or more digits/],
    ['an empty description', { description: '  ' }, /empty/],
  ])('refuses %s', (_, change, why) => {
    expect(rejection(values('log_movements', { movements: [cafe(change)] }))).toMatch(why)
  })

  it('refuses no movements and more than ten', () => {
    expect(rejection(values('log_movements', { movements: [] }))).toMatch(/invalid input/)
    expect(rejection(values('log_movements', { movements: Array(11).fill(cafe()) }))).toMatch(
      /invalid input/,
    )
  })

  it('refuses a correction that changes nothing, and values a table cannot hold', () => {
    expect(rejection(values('correct_movement', { id: 1, changes: {} }))).toMatch(
      /at least one field/,
    )
    expect(
      rejection(values('correct_movement', { id: 1, changes: { date: '2027-01-01' } })),
    ).toMatch(/after today/)
    expect(values('correct_movement', { id: 1, changes: { amount: '3800' } }).kind).toBe('ok')
  })

  it('searches: bad filters are refused, and the page size is the caller’s', () => {
    expect(rejection(values('find_movements', { amount: 'abc' }))).toMatch(/decimal/)
    expect(rejection(values('find_movements', { from: '2026-13-01' }))).toMatch(/from/)
    const read = values('find_movements', { text: 'nafta', limit: 500 })
    expect(read).toMatchObject({
      kind: 'ok',
      call: { tool: 'find_movements', input: { text: 'nafta', limit: 500 } },
    })
  })

  it('checks a summary’s range and comparison in code', () => {
    expect(values('summarize', { range: { period: 'last_month' }, compare: 'previous' }).kind).toBe(
      'ok',
    )
    expect(
      values('summarize', {
        range: { period: 'month', month: 10 },
        compare: { period: 'month', month: 9 },
      }).kind,
    ).toBe('ok')
    expect(rejection(values('summarize', { range: { period: 'month', month: 13 } }))).toMatch(
      /month/,
    )
    expect(rejection(values('summarize', { range: { period: 'year', year: 2099 } }))).toMatch(
      /future|started|year/i,
    )
    expect(
      rejection(
        values('summarize', {
          range: { period: 'this_month' },
          group_by: 'day',
          compare: 'previous',
        }),
      ),
    ).toMatch(/cannot be grouped by day/)
    expect(
      rejection(
        values('summarize', { range: { period: 'this_month' }, description: 'café 12000' }),
      ),
    ).toMatch(/4 or more/)
  })

  it('answers a secret or contact data in a fact with a typed decline, never text the client could fix', () => {
    expect(
      values('remember_fact', { kind: 'note', key: 'tarjeta', value: '4509 9530 1234 5678' }),
    ).toEqual({ kind: 'declined', declined: 'secret' })
    expect(values('remember_fact', { kind: 'note', key: 'mail', value: 'a@b.com' })).toEqual({
      kind: 'declined',
      declined: 'contact',
    })
    expect(DECLINES).toEqual(['secret', 'contact'])
  })

  it('normalizes a fact’s key and refuses what does not fit', () => {
    expect(
      values('remember_fact', { kind: 'alias', key: '¡La Visa!', value: 'crédito galicia' }),
    ).toMatchObject({
      call: {
        tool: 'remember_fact',
        input: { kind: 'alias', key: 'la visa', value: 'crédito galicia' },
      },
    })
    expect(
      rejection(values('remember_fact', { kind: 'category', key: 'café', value: 'bebidas' })),
    ).toMatch(/exactly one of/)
    expect(
      rejection(values('remember_fact', { kind: 'note', key: 'a b c d e', value: 'x' })),
    ).toMatch(/at most 4 words/)
  })

  it('forgets by id or by key, the key in the person’s normalized words', () => {
    expect(values('forget_fact', { target: { key: ' La  Visa ' } })).toMatchObject({
      call: { input: { target: { key: 'la visa' } } },
    })
    expect(rejection(values('forget_fact', { target: { key: '  ' } }))).toMatch(/key/)
    expect(rejection(values('forget_fact', { target: { id: 0 } }))).toMatch(/id/)
  })
})
