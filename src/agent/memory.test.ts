import { describe, expect, it } from 'vitest'
import { checkCall, type Guard } from './calls'
import { checkFact, looksSecret, normalizeKey, sameValue, tidy } from './memory'
import { unwritten } from './say'

const check = (kind: 'alias' | 'category' | 'note', key: string, value: string, message: string) =>
  checkFact({ kind, key, value }, message)
const ok = (...args: Parameters<typeof check>) => {
  const r = check(...args)
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r.fact
}
const why = (...args: Parameters<typeof check>) => {
  const r = check(...args)
  return r.ok ? null : 'secret' in r ? 'secret' : r.message
}

describe('normalizeKey and tidy', () => {
  it('lowercases, drops accents and punctuation, squeezes spaces', () => {
    expect(normalizeKey('  ¡El  Chino! ')).toBe('el chino')
    expect(normalizeKey('Cafés')).toBe('cafes')
    expect(normalizeKey('la 4509.')).toBe('la 4509')
  })
  it('takes out what could close a tag or a quote, and line breaks', () => {
    expect(tidy('a "b" <c>\nd')).toBe('a b c d')
  })
  it('two values are the same when only case, accents or spacing differ', () => {
    expect(sameValue('Galicia', ' galicia ')).toBe(true)
    expect(sameValue('Santander', 'galicia')).toBe(false)
  })
})

describe('looksSecret', () => {
  it.each([
    'mi tarjeta es 4509 9535 6623 3704',
    '4509-9535-6623-3704',
    'el cbu 0170099220000067797370',
    'la contraseña del banco',
    'mi clave es 1234',
    'mi PIN',
    'el cvv',
    'DNI 12.345.678',
    'dni: 12345678',
    'mi home banking',
  ])('%s', (text) => expect(looksSecret(text)).toBe(true))

  it.each([
    'cobro el 5',
    'la visa es la del galicia',
    'la 4509 es la visa',
    'el alquiler son 450.000',
    'pagué 12.345.678 de impuestos',
  ])('%s is not', (text) => expect(looksSecret(text, false)).toBe(false))

  it('an 8-digit number is a DNI in what would be stored, an amount in a message', () => {
    expect(looksSecret('12.345.678', true)).toBe(true)
    expect(looksSecret('12.345.678', false)).toBe(false)
  })
})

describe('unwritten', () => {
  it('is every number the person did not write, compared by what it means', () => {
    expect(unwritten('el 5', 'cobro el 5')).toEqual([])
    expect(unwritten('12000', 'pagué 12.000')).toEqual([])
    expect(unwritten('el 10', 'cobro el 5')).toEqual(['10'])
    expect(unwritten('cinco lucas', 'cobro 5 lucas')).toEqual(['cinco'])
    expect(unwritten('veinte lucas', 'son veinte lucas')).toEqual([])
  })
})

describe('checkFact', () => {
  it('accepts what the person said, with the key normalized', () => {
    expect(ok('alias', 'La del Galicia', 'la visa', 'la visa es la del galicia')).toEqual({
      kind: 'alias',
      key: 'la del galicia',
      value: 'la visa',
    })
    expect(
      ok('category', 'café', 'entretenimiento', 'los cafés ponelos en entretenimiento'),
    ).toEqual({
      kind: 'category',
      key: 'cafe',
      value: 'entretenimiento',
    })
    expect(ok('note', 'cobro', 'el 5', 'cobro el 5').value).toBe('el 5')
  })

  it('an alias may be the person’s words on either side; a category or a note only by its key', () => {
    expect(why('alias', 'la visa gold', 'galicia', 'la visa es la del galicia')).toBeNull()
    expect(why('note', 'sueldo', 'el 5', 'cobro el 5')).toMatch(
      /key must be words the person wrote/,
    )
    expect(why('category', 'comida', 'supermercado', 'cobro el 5')).toMatch(/key must be words/)
  })

  it('never keeps what looks like a secret, whichever field or message holds it', () => {
    expect(why('note', 'tarjeta', '4509 9535 6623 3704', 'mi tarjeta es 4509 9535 6623 3704')).toBe(
      'secret',
    )
    expect(why('note', 'banco', 'ver mensaje', 'mi clave del banco es azul')).toBe('secret')
    expect(why('alias', 'dni', '12345678', 'mi dni es 12345678')).toBe('secret')
  })

  it('refuses a number the person did not write, in digits or words', () => {
    expect(why('note', 'cobro', 'el 10', 'cobro el 5')).toMatch(
      /numbers the person did not write: 10/,
    )
    expect(why('note', 'alquiler', 'veinte lucas', 'pago el alquiler a principio de mes')).toMatch(
      /veinte/,
    )
    expect(why('note', 'cobro', 'el ٥', 'cobro el 5')).toMatch(/digits that are not 0-9/)
  })

  it('caps the key and the value, and wants a category from the list', () => {
    expect(why('note', 'a b c d e', 'x', 'a b c d e')).toMatch(/at most 4 words/)
    expect(why('note', 'x'.repeat(41), 'x', 'x'.repeat(41))).toMatch(/too long/)
    expect(why('note', 'cobro', 'x'.repeat(101), 'cobro')).toMatch(/value is too long/)
    expect(why('note', 'cobro', ' ', 'cobro')).toMatch(/value is empty/)
    expect(why('note', '¿?', 'x', 'x')).toMatch(/key is empty/)
    expect(why('category', 'cafe', 'salidas', 'cafe va en salidas')).toMatch(/one of: supermercado/)
  })
})

describe('checkCall: memory tools', () => {
  const guard = (o: Partial<Guard> = {}): Guard => ({
    today: '2026-11-21',
    seen: new Set(),
    seenFacts: new Set([7]),
    logged: 0,
    remembered: new Set(),
    message: 'la visa es la del galicia',
    ...o,
  })
  const remember = (key = 'la del galicia', value = 'la visa') => ({
    kind: 'alias',
    key,
    value,
    text: null,
  })

  it('remember_fact becomes an action with the normalized key', () => {
    const r = checkCall('remember_fact', remember('La del Galicia'), guard())
    expect(r).toMatchObject({
      kind: 'action',
      action: { tool: 'remember_fact', input: { key: 'la del galicia', value: 'la visa' } },
    })
  })

  it('a secret becomes a notice from code, never a refusal the model must fix', () => {
    const r = checkCall(
      'remember_fact',
      remember('banco', 'la clave'),
      guard({ message: 'mi clave es 1' }),
    )
    expect(r).toMatchObject({ kind: 'action', action: { tool: 'notice' } })
  })

  it('one value per key in a message', () => {
    const g = guard()
    expect(checkCall('remember_fact', remember(), g).kind).toBe('action')
    expect(checkCall('remember_fact', remember('la del galicia', 'la master'), g)).toMatchObject({
      kind: 'rejected',
    })
  })

  it('forget_fact takes an id that was shown, or a key', () => {
    expect(checkCall('forget_fact', { id: 7, key: '', text: null }, guard())).toMatchObject({
      kind: 'action',
      action: { input: { id: 7, key: '' } },
    })
    expect(checkCall('forget_fact', { id: 0, key: 'La Visa', text: null }, guard())).toMatchObject({
      kind: 'action',
      action: { input: { id: 0, key: 'la visa' } },
    })
    // Both: the shown id decides, the key is dropped.
    expect(checkCall('forget_fact', { id: 7, key: 'la visa', text: null }, guard())).toMatchObject({
      kind: 'action',
      action: { input: { id: 7, key: '' } },
    })
    for (const input of [
      { id: 8, key: '', text: null },
      { id: 8, key: 'la visa', text: null }, // an id never shown is refused whatever else is sent
      { id: -1, key: '', text: null },
      { id: 0, key: '', text: null },
      { id: 0, key: '¿?', text: null },
    ]) {
      expect(checkCall('forget_fact', input, guard()).kind, JSON.stringify(input)).toBe('rejected')
    }
  })

  it('a fact id is not a movement id: a shown movement is not a shown fact', () => {
    const r = checkCall(
      'forget_fact',
      { id: 7, key: '', text: null },
      guard({ seenFacts: new Set(), seen: new Set([7]) }),
    )
    expect(r.kind).toBe('rejected')
  })
})
