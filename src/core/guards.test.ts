import { describe, expect, it } from 'vitest'
import { cafe, NOW, TODAY } from '../../test/core'
import { type Call, MAX_FOUND } from './commands'
import { type Checked, capFind, checkTurn, checkValues, DECLINES, type Shown } from './guards'

const env = { today: TODAY, now: NOW }
const values = (tool: string, input: unknown) => checkValues(tool, input, env)
const rejection = (c: Checked) => (c.kind === 'rejected' ? c.message : null)
const shown = (o: Partial<Shown> = {}): Shown => ({
  movements: new Map<number, number | undefined>([
    [41, 410],
    [38, 380],
  ]),
  facts: new Set([7]),
  reminders: new Set([3]),
  evidence: ['café 3500 11:40 $3.500'],
  window: ['✓ Café $3.500'],
  ...o,
})
const turnOf = (calls: Call[], message = '', s: Shown = shown()) => checkTurn(calls, s, message)

describe('checkValues: what a call says, whoever sends it', () => {
  it('refuses a tool that does not exist, one only code sends, and an input of the wrong shape, with every issue', () => {
    expect(rejection(values('rm_rf', {}))).toBe('unknown tool rm_rf')
    expect(rejection(values('forget_all_confirmed', {}))).toBe('unknown tool forget_all_confirmed')
    expect(rejection(values('delete_movement', { id: 'x' }))).toMatch(/^invalid input: id: /)
    expect(rejection(values('correct_movement', { id: 1.5, changes: { amount: 3 } }))).toMatch(
      /id: .*; changes.amount: /,
    )
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
    expect(rejection(values('correct_movement', { id: 1, changes: {} }))).toMatch(/call ask_user/)
    expect(
      rejection(values('correct_movement', { id: 1, changes: { date: '2027-01-01' } })),
    ).toMatch(/after today/)
    expect(values('correct_movement', { id: 1, changes: { amount: '3800' } }).kind).toBe('ok')
  })

  it('searches: bad filters are refused, the page is the caller’s, WhatsApp caps it', () => {
    expect(rejection(values('find_movements', { amount: 'abc' }))).toMatch(/decimal/)
    expect(rejection(values('find_movements', { from: '2026-13-01' }))).toMatch(/from/)
    const read = values('find_movements', { text: 'nafta', limit: 500 })
    expect(read).toMatchObject({ kind: 'read', filter: { text: 'nafta', limit: 500 } })
    if (read.kind === 'read') expect(capFind(read.filter).limit).toBe(MAX_FOUND)
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

  it('answers a secret or contact data in a fact with a typed decline, never text the model could fix', () => {
    expect(
      values('remember_fact', { kind: 'note', key: 'tarjeta', value: '4509 9530 1234 5678' }),
    ).toEqual({ kind: 'declined', declined: 'secret' })
    expect(values('remember_fact', { kind: 'note', key: 'mail', value: 'a@b.com' })).toEqual({
      kind: 'declined',
      declined: 'contact',
    })
    expect(DECLINES).toEqual(['secret', 'contact', 'reminder_past', 'reminder_far'])
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

  it('checks ask_user’s change and sends each movement once', () => {
    expect(
      rejection(values('ask_user', { movement_ids: [41], then: { do: 'correct', changes: {} } })),
    ).toMatch(/changes is empty/)
    expect(
      values('ask_user', { movement_ids: [41, 41, 38], then: { do: 'delete' } }),
    ).toMatchObject({ call: { input: { movement_ids: [41, 38] } } })
  })

  it('checks a skip structurally: few words, no figures', () => {
    expect(values('skip', { part: 'la nafta del lunes', reason: 'not_found' }).kind).toBe('ok')
    expect(rejection(values('skip', { part: 'a b c d e f g h i', reason: 'cannot' }))).toMatch(
      /at most 8 words/,
    )
    expect(rejection(values('skip', { part: 'el de 12000', reason: 'cannot' }))).toMatch(/number/)
    expect(rejection(values('skip', { part: 'doce mil', reason: 'cannot' }))).toMatch(/number/)
    expect(rejection(values('reply', { text: ' ' }))).toMatch(/empty/)
  })
})

describe('checkValues: a reminder', () => {
  const remind = (input: object) =>
    values('set_reminder', { what: 'pagar la Visa', first: { month_day: 10 }, ...input })

  it('accepts a first occurrence in the next year, the text on one line', () => {
    expect(remind({ what: 'pagar\n la   Visa' })).toMatchObject({
      kind: 'ok',
      call: { input: { what: 'pagar la Visa' } },
    })
    expect(remind({ first: { in: { n: 20, unit: 'minutes' } } }).kind).toBe('ok')
  })

  it('answers a time that has passed with a typed decline: the person is told, the model is not asked to fix it', () => {
    expect(remind({ first: { day: 'today', time: '09:00' } })).toEqual({
      kind: 'declined',
      declined: 'reminder_past',
    })
    expect(remind({ first: { date: '2020-01-01' } })).toEqual({
      kind: 'declined',
      declined: 'reminder_past',
    })
    expect(remind({ first: { day: 'today', time: '15:00' } }).kind).toBe('ok')
  })

  it('answers a first occurrence more than 366 days away, and allows exactly that far', () => {
    expect(remind({ first: { date: '2028-01-01' } })).toEqual({
      kind: 'declined',
      declined: 'reminder_far',
    })
    expect(remind({ first: { date: '2027-11-21', time: '12:00' } }).kind).toBe('ok')
  })

  it('declines a secret value or contact data in the text, and lets plain words through', () => {
    expect(remind({ what: 'anotar que la clave es 7788' })).toEqual({
      kind: 'declined',
      declined: 'secret',
    })
    expect(remind({ what: 'llamar al 11 5555 1234' })).toEqual({
      kind: 'declined',
      declined: 'contact',
    })
    expect(remind({ what: 'mandar un mail a juan@mail.com' })).toEqual({
      kind: 'declined',
      declined: 'contact',
    })
    expect(remind({ what: 'cambiar la contraseña del wifi' }).kind).toBe('ok')
  })

  it('sends the model back what it can fix: empty or long text, a schedule that does not parse', () => {
    expect(rejection(remind({ what: '  ' }))).toMatch(/what is empty/)
    expect(rejection(remind({ what: 'x'.repeat(101) }))).toMatch(/too long/)
    expect(rejection(remind({ every: 'day', weekdays: ['mon'] }))).toMatch(
      /weekdays: only for every week/,
    )
    expect(rejection(remind({ every: 'week', weekdays: ['mon', 'mon'] }))).toMatch(/weekday twice/)
  })

  it('works out a repeating schedule from the first day and the repeat fields', () => {
    const r = remind({
      first: { weekday: 'mon', time: '08:00' },
      every: 'week',
      weekdays: ['mon', 'thu'],
    })
    expect(r.kind).toBe('ok')
  })
})

describe('checkTurn: the conversation', () => {
  const ok = (c: Checked) => c.kind === 'ok'
  const correct = (id: number): Call => ({
    tool: 'correct_movement',
    input: { id, changes: { amount: '3800' } },
  })

  it('an id the model was not shown is refused, one it was shown goes through', () => {
    expect(turnOf([correct(41)])[0]?.kind).toBe('ok')
    expect(rejection(turnOf([correct(99)])[0] as Checked)).toMatch(/id 99 was not shown to you/)
    expect(
      rejection(turnOf([{ tool: 'delete_movement', input: { id: 99 } }])[0] as Checked),
    ).toMatch(/not shown/)
    expect(
      rejection(
        turnOf([
          { tool: 'ask_user', input: { movement_ids: [41, 99], then: { do: 'delete' } } },
        ])[0] as Checked,
      ),
    ).toMatch(/id 99/)
  })

  it('the movements of the whole message are counted, not only one call', () => {
    const six: Call = { tool: 'log_movements', input: { movements: Array(6).fill(cafe()) } }
    const verdicts = turnOf([six, six])
    expect(ok(verdicts[0] as Checked)).toBe(true)
    expect(rejection(verdicts[1] as Checked)).toMatch(/at most 10 movements per message, got 12/)
  })

  it('a fact is words the person wrote, with only numbers they wrote, once per key', () => {
    const remember = (key: string, value: string): Call => ({
      tool: 'remember_fact',
      input: { kind: 'note', key, value },
    })
    expect(turnOf([remember('cobro', 'el 5')], 'acordate que cobro el 5')[0]?.kind).toBe('ok')
    expect(rejection(turnOf([remember('alquiler', 'el 5')], 'hola')[0] as Checked)).toMatch(
      /words the person wrote/,
    )
    expect(
      rejection(turnOf([remember('cobro', 'el 7')], 'acordate que cobro el 5')[0] as Checked),
    ).toMatch(/numbers the person did not write: 7/)
    const twice = turnOf(
      [remember('cobro', 'el 5'), remember('cobro', 'el 5')],
      'acordate que cobro el 5',
    )
    expect(ok(twice[0] as Checked)).toBe(true)
    expect(rejection(twice[1] as Checked)).toMatch(/one value per key/)
    expect(turnOf([remember('clave', 'la del banco')], 'mi clave 1234 del banco')[0]).toEqual({
      kind: 'declined',
      declined: 'secret',
    })
  })

  it('a fact id and a reminder id must have been shown', () => {
    expect(turnOf([{ tool: 'forget_fact', input: { target: { id: 7 } } }])[0]?.kind).toBe('ok')
    expect(
      rejection(turnOf([{ tool: 'forget_fact', input: { target: { id: 8 } } }])[0] as Checked),
    ).toMatch(/fact id 8/)
    expect(turnOf([{ tool: 'forget_fact', input: { target: { key: 'la visa' } } }])[0]?.kind).toBe(
      'ok',
    )
    expect(turnOf([{ tool: 'cancel_reminder', input: { id: 3 } }])[0]?.kind).toBe('ok')
    expect(
      rejection(turnOf([{ tool: 'cancel_reminder', input: { id: 4 } }])[0] as Checked),
    ).toMatch(/reminder id 4/)
  })

  it('a reminder may hold only numbers the person wrote, and a message with a secret sets none', () => {
    const r = (what: string): Call => ({
      tool: 'set_reminder',
      input: { what, first: { month_day: 10 }, interval: 1 },
    })
    expect(turnOf([r('pagar la cuota 7')], 'recordame el 10 pagar la cuota 7')[0]?.kind).toBe('ok')
    expect(
      rejection(turnOf([r('pagar la cuota 7')], 'recordame el 10 pagar la cuota')[0] as Checked),
    ).toMatch(/numbers the person did not write in what: 7/)
    expect(turnOf([r('pagar')], 'mi clave 7788, recordame pagar el 10')[0]).toEqual({
      kind: 'declined',
      declined: 'secret',
    })
  })

  it('undo, forget-everything and reply go alone', () => {
    const undo: Call = { tool: 'undo_last', input: {} }
    const forgetAll: Call = { tool: 'forget_all_facts', input: {} }
    const reply: Call = { tool: 'reply', input: { text: 'hola' } }
    expect(turnOf([undo])[0]?.kind).toBe('ok')
    expect(rejection(turnOf([undo, correct(41)])[0] as Checked)).toMatch(
      /undo_last goes alone.*skip/,
    )
    expect(rejection(turnOf([correct(41), forgetAll])[1] as Checked)).toMatch(
      /forget_all_facts goes alone/,
    )
    expect(rejection(turnOf([reply, correct(41)])[0] as Checked)).toMatch(/reply goes alone/)
    expect(turnOf([reply, correct(41)])[1]?.kind).toBe('ok')
  })

  it('a change to the only option of a pending question is the correction, not a second question', () => {
    const ask: Call = {
      tool: 'ask_user',
      input: { movement_ids: [41], then: { do: 'correct', changes: { amount: '4100' } } },
    }
    expect(turnOf([ask], '', shown({ sole: 41 }))[0]).toEqual({
      kind: 'ok',
      call: {
        tool: 'correct_movement',
        input: { id: 41, changes: { amount: '4100' } },
        version: 410,
      },
    })
    expect(turnOf([ask])[0]).toMatchObject({ kind: 'ok', call: { tool: 'ask_user' } })
  })

  it('a change to a movement carries the version it was shown at, which the model never sends', () => {
    const del: Call = { tool: 'delete_movement', input: { id: 38 } }
    const fix: Call = { tool: 'correct_movement', input: { id: 41, changes: { amount: '1' } } }
    expect(turnOf([del])[0]).toEqual({ kind: 'ok', call: { ...del, version: 380 } })
    expect(turnOf([fix])[0]).toEqual({ kind: 'ok', call: { ...fix, version: 410 } })
    // The model's own `version` is not part of the input: the registry's schema drops it.
    const parsed = values('delete_movement', { id: 38, version: 1 })
    expect(parsed).toMatchObject({
      kind: 'ok',
      call: { tool: 'delete_movement', input: { id: 38 } },
    })
    expect('version' in (parsed.kind === 'ok' ? parsed.call : {})).toBe(false)
  })
})
