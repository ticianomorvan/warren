import { describe, expect, it } from 'vitest'
import { looksContact, looksSecret, sensitive } from '../core/secrets'
import { checkFactValues, normalizeKey, sameValue, tidy } from './facts'

const check = (kind: 'alias' | 'category' | 'note', key: string, value: string) =>
  checkFactValues({ kind, key, value })
const ok = (...args: Parameters<typeof check>) => {
  const r = check(...args)
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r.fact
}
const why = (...args: Parameters<typeof check>) => {
  const r = check(...args)
  return r.ok ? null : 'refused' in r ? r.refused : r.message
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

describe('checkFactValues', () => {
  it('accepts a fact with the key normalized', () => {
    expect(ok('alias', 'La del Galicia', 'la visa')).toEqual({
      kind: 'alias',
      key: 'la del galicia',
      value: 'la visa',
    })
    expect(ok('category', 'café', 'entretenimiento')).toEqual({
      kind: 'category',
      key: 'cafe',
      value: 'entretenimiento',
    })
    expect(ok('note', 'cobro', 'el 5').value).toBe('el 5')
  })

  it('never keeps what looks like a secret, whichever field holds it', () => {
    expect(why('note', 'tarjeta', '4509 9535 6623 3704')).toBe('secret')
    expect(why('note', 'mi clave del banco', 'azul')).toBe('secret')
    expect(why('alias', 'dni', '12345678')).toBe('secret')
  })

  it('refuses digits that are not 0-9', () => {
    expect(why('note', 'cobro', 'el ٥')).toMatch(/digits that are not 0-9/)
  })

  it('caps the key and the value, and wants a category from the list', () => {
    expect(why('note', 'a b c d e', 'x')).toMatch(/at most 4 words/)
    expect(why('note', 'x'.repeat(41), 'x')).toMatch(/too long/)
    expect(why('note', 'cobro', 'x'.repeat(101))).toMatch(/value is too long/)
    expect(why('note', 'cobro', ' ')).toMatch(/value is empty/)
    expect(why('note', '¿?', 'x')).toMatch(/key is empty/)
    expect(why('category', 'cafe', 'salidas')).toMatch(/one of: supermercado/)
  })
})

describe('what looks like a secret, both ways', () => {
  /** What would be stored in a fact. */
  const refusedStored = [
    // a card: any length from 13, any of the usual separators
    '4509 9535 6623 3704',
    '4509-9535-6623-3704',
    '4509/9535/6623/3704',
    '4509_9535_6623_3704',
    '4509 - 9535 - 6623 - 3704',
    '4509.9535.6623.3704',
    '3782 822463 10005', // 15 digits, as an Amex is written
    '4222222222222', // 13 digits
    '0170099220000067797370', // a CBU
    // a DNI: 7 or 8 digits, plain, dotted or spaced
    '12345678',
    '12.345.678',
    '12 345 678',
    '1.234.567',
    'mi dni 1234',
    'el cbu 0170',
    // words
    'mi clave es azul',
    'la contraseña del banco',
    'password',
    'mi PIN',
    'el cvv',
    'el código del cajero es 1234',
    'cajero',
    'el código de acceso', // "código" with no "cajero"
    'número de tarjeta',
    // a password said with a cue and no keyword
    'en el galicia uso Perro123',
    'entro con Perro123!',
  ]
  const keptStored = [
    'cobro el 5',
    'alquiler 450.000',
    'alquiler 450000',
    '$1.850.000',
    '1.850.000 pesos',
    'sueldo de 2 millones',
    'usd 1.850.000',
    'visa terminada en 4509',
    'la 4509',
    '422222222222', // 12 digits: not a card
    '4509 9535 6623', // 12 digits
    'pago 12 cuotas',
    'cuotas 15.000 20.000 5.000', // three amounts, 14 digits between them
    'alquiler 150.000 expensas 20.000 luz 5.000',
    'vence el 2026-11-20',
    'pago la PlayStation5 en cuotas', // mixed case and digits, but no cue
    'uso la visa',
    'transferencia por cbu',
    'dni', // the word alone
  ]
  it.each(refusedStored)('refuses %s in a fact', (text) => expect(looksSecret(text)).toBe(true))
  it.each(keptStored)('keeps %s in a fact', (text) => expect(looksSecret(text)).toBe(false))

  it('a card number is 13 digits or more, not 12', () => {
    expect(looksSecret('1234567890123')).toBe(true)
    expect(looksSecret('123456789012')).toBe(false)
  })

  /** What a person writes to Warren: only what cannot be a movement counts. */
  const sensitiveMessages = [
    'mi clave del galicia es Perro123',
    'acordate de mi dni 12345678',
    'mi dni es 12.345.678',
    'el código del cajero es 1234',
    'en el galicia uso Perro123',
    'mi tarjeta 4509 9535 6623 3704',
    'guardá mi cbu 0170099220000067797370',
  ]
  const plainMessages = [
    'café 3500',
    'anotá 12.345.678 de alquiler',
    'transferí 15000 por cbu',
    'retiré 20000 del cajero',
    'pagué 3500 el 2026-11-20 y 4000 el 2026-11-21',
    'sueldo 1.850.000',
    'cobro el 5',
    'uso la visa para el súper 9500',
    'la visa es la del galicia',
    'cuotas 15.000 20.000 5.000', // separate amounts are not one long number
  ]
  it.each(sensitiveMessages)('a message "%s" is sensitive', (text) =>
    expect(sensitive(text)).toBe(true),
  )
  it.each(plainMessages)('a message "%s" is not', (text) => expect(sensitive(text)).toBe(false))
})

describe('contact data', () => {
  it.each([
    'juan@gmail.com',
    'mi mail es ana.perez+warren@hotmail.com.ar',
    '11 2345-6789',
    '011 4567-8901',
    '(011) 4567-8901',
    '+54 9 11 2345 6789',
    '1123456789',
    '15-2345-6789',
  ])('%s is contact data', (text) => expect(looksContact(text)).toBe(true))

  it.each([
    'cobro el 5',
    'alquiler 450.000',
    '$1.850.000',
    '12.345.678',
    '1.234.567',
    'la 4509',
    'vence el 2026-11-20',
    'pago 12 cuotas de 15000',
  ])('%s is not', (text) => expect(looksContact(text)).toBe(false))

  it('a fact with a phone or an email is refused as contact data, and a card as a secret, in either field', () => {
    const refused = (key: string, value: string) => {
      const r = checkFactValues({ kind: 'note', key, value })
      return !r.ok && 'refused' in r ? r.refused : null
    }
    expect(refused('mama', '11 2345-6789')).toBe('contact')
    expect(refused('mail@x.com', 'mi mail')).toBe('contact')
    expect(refused('mama', '+54 9 11 2345 6789')).toBe('contact')
    expect(refused('tarjeta', '4509 9535 6623 3704')).toBe('secret')
    expect(refused('tarjeta', '4509_9535_6623_3704')).toBe('secret')
  })
})
