import { describe, expect, it } from 'vitest'
import {
  checkSay,
  composeReply,
  hasForeignDigit,
  hasLongNumber,
  hasNumberWord,
  MAX_SAY_LENGTH,
} from './say'

/** What the model saw this message, as the sources of the check. */
const sources = [
  'borraste el super?',
  'out 12000 ARS 2026-11-21 09:12 súper supermercado crédito visa',
  'out 2900.50 ARS 2026-11-03 11:54 café restaurantes',
  '(persona, hace 2 min) borra el super',
  '(Warren) ✓ Borré: Súper $12.000 · 09:12',
  '(Warren) ✓ Corregido: Café $3.800,50 (antes $3.500) · 10:10',
  'opción 1',
]

const ok = (text: string, extra: string[] = []) => checkSay(text, [...sources, ...extra]).ok
const reason = (text: string, extra: string[] = []) => {
  const r = checkSay(text, [...sources, ...extra])
  return r.ok ? null : r.reason
}

describe('checkSay: numbers must be ones code gave', () => {
  it('lets through a text with no number at all', () => {
    expect(ok('Sí, lo borré.')).toBe(true)
    expect(ok('No encontré el súper.')).toBe(true)
  })

  it('accepts amounts as written in a source, in Argentine form', () => {
    expect(ok('Sí, borré el súper de $12.000.')).toBe(true)
    expect(ok('El café quedó en $3.800,50.')).toBe(true)
    expect(ok('Antes era $3.500.')).toBe(true)
  })

  it('compares what the number means, not how it is written', () => {
    // 12000 (plain, in the movement list) = 12.000 (Argentine) = $12.000,00
    expect(ok('Eran 12000.')).toBe(true)
    expect(ok('Eran 12.000.')).toBe(true)
    expect(ok('Eran $12.000,00.')).toBe(true)
    expect(ok('Eran US$ 12.000.')).toBe(true)
    // 2900.50 in the list is 2.900,50 for the person
    expect(ok('El café fue $2.900,50.')).toBe(true)
    expect(ok('El café fue 2900.5.')).toBe(true)
  })

  it('rejects an amount no source has, however it is written', () => {
    expect(reason('Borré $12.500.')).toMatch(/number not given by code: 12\.500/)
    expect(ok('Borré 12500.')).toBe(false)
    expect(ok('Borré $13.000.')).toBe(false)
    expect(ok('Son $15.800 entre los dos.')).toBe(false)
  })

  it('does not take a thousands dot for a decimal point, or the reverse', () => {
    // 3.500 is three thousand five hundred, not 3.5
    expect(ok('Antes $3.500.')).toBe(true)
    expect(ok('Antes $3,5.')).toBe(false)
    expect(ok('Antes $35.')).toBe(false)
    // 12,000 is a decimal 12 in Argentine writing, and 12 is not in any source
    expect(ok('Eran 12,000.')).toBe(false)
    // 1.500.000 groups; a source with it lets the plain form through
    expect(ok('Sueldo de 1500000.', ['cobré 1.500.000'])).toBe(true)
    expect(ok('Sueldo de 1500000.')).toBe(false)
  })

  it('treats trailing zeros of a decimal as nothing, and leading zeros too', () => {
    expect(ok('Eran $12.000,00.')).toBe(true)
    expect(ok('Eran 012000.')).toBe(true)
    expect(ok('Eran $12.000,50.')).toBe(false)
  })

  it('does not join a number to the full stop that ends the sentence', () => {
    expect(ok('Eran $12.000.')).toBe(true)
    expect(ok('Eran $12.000, creo.')).toBe(true)
    expect(ok('Eran $12.001.')).toBe(false)
  })

  it('accepts the person’s own numbers and an option number from the question', () => {
    expect(ok('No hay un 7.', ['borrá el 7'])).toBe(true)
    expect(ok('El 2 no existe.', ['borrá el 2'])).toBe(true)
    expect(ok('Elegí la opción 1.')).toBe(true)
    expect(ok('Elegí la opción 3.')).toBe(false)
  })

  it('reads times as times: 09:12 matches 09:12 and 9:12, not 09:13 or the bare hour', () => {
    expect(ok('Lo anotaste a las 09:12.')).toBe(true)
    expect(ok('Lo anotaste a las 9:12.')).toBe(true)
    expect(ok('Lo anotaste a las 09:13.')).toBe(false)
    expect(ok('Lo anotaste a las 9.')).toBe(false)
    expect(ok('Lo anotaste a las 10:10.')).toBe(true)
  })

  it('reads days as days, in any of the forms code shows', () => {
    // the list has 2026-11-03: the person sees 03/11
    expect(ok('Fue el 03/11.')).toBe(true)
    expect(ok('Fue el 3/11.')).toBe(true)
    expect(ok('Fue el 2026-11-03.')).toBe(true)
    expect(ok('Fue el 04/11.')).toBe(false)
    expect(ok('Fue el 3/12.')).toBe(false)
    // a year form, when the source has one
    expect(ok('Fue el 03/11/26.')).toBe(true)
    expect(ok('Fue el 03/11/2026.')).toBe(true)
    expect(ok('Fue el 03/11/25.')).toBe(false)
  })

  it('a day written in a source with a year can be quoted without it, and the reverse is refused', () => {
    expect(ok('Fue el 05/10.', ['(Warren) ✓ Café $100 · 05/10/25'])).toBe(true)
    expect(ok('Fue el 05/10/25.', ['(Warren) ✓ Café $100 · 05/10'])).toBe(false)
  })

  it('does not let a bare day number through just because it is inside a date of the list', () => {
    // the list has 2026-11-21 and 2026-11-03: "21" and "3" alone are not given
    expect(ok('El 21 lo borré.')).toBe(false)
    expect(ok('Fue el 3.')).toBe(false)
  })

  it('does not let the calendar, the clock or an id be a source', () => {
    // nothing here lists "12:00" or id 905 as a source
    expect(ok('Son las 12:00.')).toBe(false)
    expect(ok('Es el movimiento 905.')).toBe(false)
  })

  it('refuses a number a source has only as part of a longer one', () => {
    expect(ok('Fueron 120.')).toBe(false)
    expect(ok('Fueron 1200.')).toBe(false)
    expect(ok('Fueron 12.')).toBe(false)
  })

  it('names every offending number once, and the first offence is enough to drop the text', () => {
    expect(reason('Sumé $1.111 y $2.222 y $1.111.')).toBe('number not given by code: 1.111, 2.222')
  })

  it('takes the rendered lines as a source too', () => {
    const lines = ['✓ Borré: Súper $20.000 · 09:12']
    expect(ok('Borré el súper de $20.000.', lines)).toBe(true)
    expect(ok('Borré el súper de $20.000.')).toBe(false)
  })

  it('catches a figure hidden in a unit: 20k, 5%, x7, 9na', () => {
    expect(ok('Eran 20k.')).toBe(false)
    expect(ok('Subió 5%.')).toBe(false)
    expect(ok('Lo anoté x7.')).toBe(false)
    expect(ok('Es la 9na vez.')).toBe(false)
  })
})

describe('checkSay: numbers written in words', () => {
  it('refuses a number word no source spells', () => {
    expect(reason('Borré los dos cafés.')).toMatch(/number written in words not given by code: dos/)
    expect(ok('Eran doce mil pesos.')).toBe(false)
    expect(ok('Fueron cinco.')).toBe(false)
    expect(ok('Tres movimientos.')).toBe(false)
  })

  it('refuses them accents and case aside', () => {
    expect(ok('Eran DIECISÉIS.')).toBe(false)
    expect(ok('Un MILLÓN.')).toBe(false)
    expect(ok('Veinte lucas.')).toBe(false)
  })

  it('lets one through when the person wrote that word', () => {
    expect(ok('El dos no existe.', ['borrá el dos'])).toBe(true)
    expect(ok('Anoté las 20 lucas.', ['20 lucas de nafta'])).toBe(true)
    expect(ok('Eran cinco mil.', ['eran cinco mil'])).toBe(true)
  })

  it('does not take a word that merely contains one for a number', () => {
    expect(ok('Es parecido, similar al otro.')).toBe(true) // "mil" inside similar
    expect(ok('Sí, claro, no hay problema.')).toBe(true)
  })

  it('leaves un, una and uno alone', () => {
    expect(ok('Hay un súper y una nafta.')).toBe(true)
  })
})

describe('checkSay: shape', () => {
  it('refuses an empty text', () => {
    expect(reason('')).toBe('empty')
    expect(reason('   \n ')).toBe('empty')
  })

  it('refuses a text longer than the limit, and accepts one at the limit', () => {
    expect(ok('a'.repeat(MAX_SAY_LENGTH))).toBe(true)
    expect(reason('a'.repeat(MAX_SAY_LENGTH + 1))).toMatch(/longer than/)
  })

  it('refuses a text shaped like a line code renders (✓), so it cannot pass for the record', () => {
    expect(reason('✓ Borré: Súper $12.000')).toMatch(/imitates/)
    expect(reason('Listo ✓')).toMatch(/imitates/)
  })

  it('returns the text on one line, single spaces', () => {
    const r = checkSay('  No encontré\n\nel   súper.  ', sources)
    expect(r).toEqual({ ok: true, text: 'No encontré el súper.' })
  })
})

describe('hasLongNumber', () => {
  it('finds a run of four or more digits, with or without separators', () => {
    for (const value of [
      'café 3500',
      '12000',
      '12.000',
      '3,500',
      'visa 4509',
      'ticket 1234 b',
      '1.5 1.5 1.5',
    ]) {
      expect(hasLongNumber(value), value).toBe(value !== '1.5 1.5 1.5')
    }
  })

  it('lets short numbers be', () => {
    for (const value of [
      'mc 100',
      'cuota 3',
      'pedidos ya',
      '24/7',
      'café',
      'club 99',
      '1,5',
      'cuota 12/12',
    ]) {
      expect(hasLongNumber(value), value).toBe(false)
    }
  })
})

describe('checkSay: pieces that make a new amount', () => {
  it('refuses a number next to a multiplier unless that very phrase was given', () => {
    // "2" is in the conversation ("hace 2 min") and "lucas" in the person's message, but "2 lucas" is 2000
    expect(ok('La nafta fue 2 lucas.', ['nafta 20 lucas'])).toBe(false)
    expect(reason('La nafta fue 2 lucas.', ['nafta 20 lucas'])).toMatch(
      /amount made of given pieces/,
    )
    expect(ok('La nafta fue 20 lucas.', ['nafta 20 lucas'])).toBe(true)
    expect(ok('Son 2k.')).toBe(false)
    expect(ok('Son 20k.', ['gasté 20k'])).toBe(true)
    expect(ok('Son 5 mil.', ['era 5 mil'])).toBe(true)
    expect(ok('Son 5 mil.', ['era 5, mil cosas'])).toBe(false)
    expect(ok('Son 2 palos.', ['1 palo'])).toBe(false)
  })
})

describe('checkSay: number words that are open families', () => {
  it.each([
    'veinticinco lucas',
    'veintiuno',
    'quinientas lucas',
    'doscientas',
    'dieciséis',
    'cientos de pesos',
    'el doble',
    'la mitad',
    'el triple',
  ])('refuses "%s"', (text) => {
    expect(ok(`Fueron ${text}.`)).toBe(false)
  })

  it('does not take ordinary words for them', () => {
    expect(ok('Es científico, ¿cómo lo anoto?')).toBe(true)
    expect(ok('Medio de pago: efectivo.')).toBe(true)
  })
})

describe('checkSay: digits that are not 0-9', () => {
  it('refuses full-width and other scripts’ digits', () => {
    expect(reason('Gastaste ２５.０００')).toMatch(/number not given/) // read as 25.000, then judged
    expect(reason('Fueron ٢٥.')).toMatch(/not 0-9/)
    expect(ok('Fueron ٢٥.')).toBe(false)
    expect(hasForeignDigit('٣')).toBe(true)
    expect(hasForeignDigit('１２')).toBe(false) // full-width is read as 12 (NFKC), and then judged as a number
    expect(hasForeignDigit('12')).toBe(false)
    expect(hasLongNumber('café １２０００')).toBe(true)
    expect(hasNumberWord('doce')).toBe(true)
    expect(hasNumberWord('٣')).toBe(true)
    expect(hasNumberWord('Cuál café')).toBe(false)
  })
})

describe('checkSay: a text cannot say a change happened that the record does not show', () => {
  const none = ['el café fue 3800', 'out 3500 ARS 2026-11-21 10:10 café restaurantes']
  const asText = (text: string, record: string[] = []) => checkSay(text, [...none, ...record]).ok

  it('refuses the claim with no record of it', () => {
    expect(asText('Listo, el café quedó en $3.800 (antes $3.500).')).toBe(false)
    expect(asText('Corregí el café.')).toBe(false)
    expect(asText('Ya borré el súper.')).toBe(false)
    expect(asText('Anoté el café.')).toBe(false)
    expect(asText('Ya está.')).toBe(false)
  })

  it('lets it through when a line of the record shows that change', () => {
    expect(asText('Corregí el café.', ['✓ Corregido: Café $3.800 (antes $3.500)'])).toBe(true)
    expect(asText('Ya borré el súper.', ['✓ Borré: Súper $12.000'])).toBe(true)
    expect(asText('Anoté el café.', ['✓ Café $3.500'])).toBe(true)
    expect(asText('Listo, quedó en $3.800.', ['✓ Corregido: Café $3.800 (antes $3.500)'])).toBe(
      true,
    )
  })

  it('does not count a different change as the record', () => {
    expect(asText('Corregí el café.', ['✓ Borré: Súper $12.000'])).toBe(false)
    expect(asText('Ya borré el súper.', ['✓ Corregido: Café $3.800 (antes $3.500)'])).toBe(false)
  })

  it('leaves a denial alone: not doing something is not a claim', () => {
    expect(asText('No borré nada: no encontré el súper.')).toBe(true)
    expect(asText('No lo anoté porque falta el monto.')).toBe(true)
  })
})

describe('composeReply', () => {
  const base = { facts: ['borra el super'], fallback: 'FALLBACK' }

  it('puts the lines first, then the texts that pass, once each', () => {
    const r = composeReply({
      ...base,
      lines: ['✓ Borré: Súper $12.000'],
      says: [
        { action: 0, text: 'No encontré la nafta.' },
        { action: 1, text: 'No encontré la nafta.' },
      ],
      outcomes: ['applied', 'applied'],
    })
    expect(r.reply).toBe('✓ Borré: Súper $12.000\nNo encontré la nafta.')
    expect(r.verdicts.get(1)).toEqual({ text: 'sent' })
  })

  it('drops a text whose action did not apply, one with a bad number, and says why', () => {
    const r = composeReply({
      ...base,
      lines: ['Ese movimiento ya fue corregido o borrado.', '✓ Borré: Café $2.900'],
      says: [
        { action: 0, text: 'Listo.' },
        { action: 1, text: 'Borré $9.999.' },
      ],
      outcomes: ['gone', 'applied'],
    })
    expect(r.reply).toBe('Ese movimiento ya fue corregido o borrado.\n✓ Borré: Café $2.900')
    expect(r.verdicts.get(0)).toEqual({ text: 'dropped', textReason: 'its action was gone' })
    expect(r.verdicts.get(1)?.textReason).toMatch(/9\.999/)
  })

  it('sends the fallback when there is no line and no text left, never an empty reply', () => {
    expect(
      composeReply({
        ...base,
        lines: [],
        says: [{ action: 0, text: 'Son $9.999.' }],
        outcomes: ['applied'],
      }).reply,
    ).toBe('FALLBACK')
    expect(composeReply({ ...base, lines: [], says: [], outcomes: [] }).reply).toBe('FALLBACK')
  })

  it('takes numbers from the lines but number words only from the facts', () => {
    // a description the model wrote ("doce mil") sits in the line; it must not let its own words through
    const lines = ['✓ Anoté: café doce mil $3.500']
    const r = composeReply({
      ...base,
      lines,
      says: [{ action: 0, text: 'Anoté el de $3.500, no el de doce mil.' }],
      outcomes: ['applied'],
    })
    expect(r.verdicts.get(0)?.textReason).toMatch(/words/)
    expect(
      composeReply({
        ...base,
        lines,
        says: [{ action: 0, text: 'Anoté el de $3.500.' }],
        outcomes: ['applied'],
      }).verdicts.get(0),
    ).toEqual({ text: 'sent' })
  })
})
