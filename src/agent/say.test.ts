import { describe, expect, it } from 'vitest'
import {
  checkSay,
  composeReply,
  type Evidence,
  echoes,
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

const NOTHING = { deleted: false, corrected: false, logged: false }
const EVERYTHING = { deleted: true, corrected: true, logged: true }
/** Evidence where this message did every kind of change, so that only numbers and words are judged. */
const evidence = (extra: string[] = [], o: Partial<Evidence> = {}): Evidence => ({
  numbers: [...sources, ...extra],
  words: [...sources, ...extra],
  applied: EVERYTHING,
  ...o,
})
const ok = (text: string, extra: string[] = []) => checkSay(text, evidence(extra)).ok
const reason = (text: string, extra: string[] = []) => {
  const r = checkSay(text, evidence(extra))
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
    const r = checkSay('  No encontré\n\nel   súper.  ', evidence())
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
      /figure made of given pieces/,
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

describe('checkSay: a text cannot say a change happened that this message did not make', () => {
  const facts = ['el café fue 3800', 'out 3500 ARS 2026-11-21 10:10 café restaurantes']
  const say = (text: string, applied = NOTHING, window?: string[]) =>
    checkSay(text, { numbers: facts, words: facts, applied, ...(window ? { window } : {}) }).ok

  it('refuses the claim when the message did not make that change', () => {
    expect(say('Listo, el café quedó en $3.500 (antes $3.500).')).toBe(false)
    expect(say('Corregí el café.')).toBe(false)
    expect(say('Ya borré el súper.')).toBe(false)
    expect(say('Anoté el café.')).toBe(false)
    expect(say('Ya está.')).toBe(false)
  })

  it('lets it through when the message made that change', () => {
    expect(say('Corregí el café.', { ...NOTHING, corrected: true })).toBe(true)
    expect(say('Ya borré el súper.', { ...NOTHING, deleted: true })).toBe(true)
    expect(say('Anoté el café.', { ...NOTHING, logged: true })).toBe(true)
    expect(say('Listo, ya está.', { ...NOTHING, deleted: true })).toBe(true)
  })

  it('does not count a different change as the proof', () => {
    expect(say('Corregí el café.', { ...NOTHING, deleted: true })).toBe(false)
    expect(say('Ya borré el súper.', { ...NOTHING, corrected: true })).toBe(false)
    expect(say('Anoté el café.', { ...NOTHING, deleted: true })).toBe(false)
  })

  it('does not take the person’s own words or an earlier message as proof', () => {
    // the person wrote "borre el super" and the numbers/words sources hold it: it proves nothing
    const said = ['borre el super y el cafe fue 3800', '(Warren) ✓ Anoté 2:']
    expect(checkSay('Borré el súper.', { numbers: said, words: said, applied: NOTHING }).ok).toBe(
      false,
    )
    expect(checkSay('Listo, ya está.', { numbers: said, words: said, applied: NOTHING }).ok).toBe(
      false,
    )
  })

  it('lets a reply lean on what Warren answered earlier, and only a reply', () => {
    const earlier = ['✓ Borré: Súper $12.000 · 09:12']
    expect(say('Sí, lo borré.', NOTHING, earlier)).toBe(true)
    expect(say('Sí, lo borré.', NOTHING)).toBe(false) // not a reply: no window
    // the window proves the kind it shows, not another
    expect(say('Sí, lo corregí.', NOTHING, earlier)).toBe(false)
    expect(say('Listo, ya está.', NOTHING, ['✓ Anoté 2:'])).toBe(true) // the generic claim: any ✓ line
    expect(say('Sí, lo anoté.', NOTHING, ['✓ Corregido: Café $3.800 (antes $3.500)'])).toBe(false)
  })

  it('leaves a denial alone: not doing something is not a claim', () => {
    expect(say('No borré nada: no encontré el súper.')).toBe(true)
    expect(say('No lo anoté porque falta el monto.')).toBe(true)
  })
})

describe('composeReply', () => {
  const step = (tool: string, outcome = 'applied') => ({ tool, outcome })
  const base = {
    message: 'borra el super',
    facts: ['borra el super'],
    window: [] as string[],
    fallback: 'FALLBACK',
  }

  it('puts the lines first, then the texts that pass, once each', () => {
    const r = composeReply({
      ...base,
      lines: ['✓ Borré: Súper $12.000'],
      says: [
        { action: 0, text: 'No encontré la nafta.' },
        { action: 1, text: 'No encontré la nafta.' },
      ],
      steps: [step('log_movements'), step('log_movements')],
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
      steps: [step('delete_movement', 'gone'), step('delete_movement')],
    })
    expect(r.reply).toBe('Ese movimiento ya fue corregido o borrado.\n✓ Borré: Café $2.900')
    expect(r.verdicts.get(0)).toEqual({ text: 'dropped', textReason: 'its action was gone' })
    expect(r.verdicts.get(1)?.textReason).toMatch(/9\.999/)
  })

  it('judges a claim by this message’s steps: a delete that came back gone proves nothing', () => {
    const r = composeReply({
      ...base,
      lines: ['Ese movimiento ya fue corregido o borrado.', '✓ Café $3.500'],
      says: [{ action: 1, text: 'Corregí el café y borré la nafta.' }],
      steps: [step('delete_movement', 'gone'), step('log_movements')],
    })
    expect(r.verdicts.get(1)?.textReason).toMatch(
      /claims a (correction|deletion) this message did not make/,
    )
    // …and a correct that was sent alone does not prove a deletion (live message 48)
    const only = composeReply({
      ...base,
      lines: ['✓ Corregido: Nafta $4.000 (antes $20.000)'],
      says: [{ action: 0, text: 'Borré la nafta y corregí el café.' }],
      steps: [step('correct_movement')],
    })
    expect(only.reply).toBe('✓ Corregido: Nafta $4.000 (antes $20.000)')
    expect(only.verdicts.get(0)?.textReason).toMatch(/deletion/)
  })

  it('lets only a reply lean on the window', () => {
    const window = ['✓ Borré: Súper $12.000']
    const asReply = composeReply({
      ...base,
      window,
      lines: [],
      says: [{ action: 0, text: 'Sí, lo borré.' }],
      steps: [step('reply')],
    })
    expect(asReply.reply).toBe('Sí, lo borré.')
    const beside = composeReply({
      ...base,
      window,
      lines: ['✓ Café $3.500'],
      says: [{ action: 0, text: 'Sí, lo borré.' }],
      steps: [step('log_movements')],
    })
    expect(beside.reply).toBe('✓ Café $3.500')
  })

  it('sends the fallback when there is no line and no text left, never an empty reply', () => {
    expect(
      composeReply({
        ...base,
        lines: [],
        says: [{ action: 0, text: 'Son $9.999.' }],
        steps: [step('log_movements')],
      }).reply,
    ).toBe('FALLBACK')
    expect(composeReply({ ...base, lines: [], says: [], steps: [] }).reply).toBe('FALLBACK')
  })

  it('takes numbers from the lines but number words only from the facts', () => {
    // a description the model wrote ("doce mil") sits in the line; it must not let its own words through
    const lines = ['✓ Anoté: café doce mil $3.500']
    const r = composeReply({
      ...base,
      lines,
      says: [{ action: 0, text: 'Anoté el de $3.500, no el de doce mil.' }],
      steps: [step('log_movements')],
    })
    expect(r.verdicts.get(0)?.textReason).toMatch(/words/)
    expect(
      composeReply({
        ...base,
        lines,
        says: [{ action: 0, text: 'Anoté el de $3.500.' }],
        steps: [step('log_movements')],
      }).verdicts.get(0),
    ).toEqual({ text: 'sent' })
  })
})

describe('canonical numbers with odd separators', () => {
  it('keeps "1,000,000" and "1.2.3" distinct instead of reading them as another number', () => {
    // 1,000,000 must not be read as 1 thousand; nothing given may make it pass
    expect(ok('Fueron 1,000,000.')).toBe(false)
    expect(ok('Fueron 1000.', ['gasté 1,000,000'])).toBe(false)
    expect(ok('Fueron 1,000,000.', ['gasté 1,000,000'])).toBe(true) // exactly as given
    expect(ok('Fueron 1.2.3.')).toBe(false)
    expect(ok('Fueron 123.', ['1.2.3'])).toBe(false)
    expect(ok('Fueron 1.500.000.', ['1500000'])).toBe(true) // a real grouping is still read
    expect(ok('Fueron 1.500.000,50.', ['1500000.5'])).toBe(true)
  })
})

describe('checkSay: pieces that are each given', () => {
  it('a source "12 lucas" does not allow "2 lucas"', () => {
    expect(ok('Son 2 lucas.', ['12 lucas', 'hace 2 min'])).toBe(false)
    expect(ok('Son 12 lucas.', ['12 lucas'])).toBe(true)
  })

  it('refuses a minus, a range and a percent that no source has', () => {
    expect(ok('Fueron -3.500.', ['3500'])).toBe(false)
    expect(ok('Entre 2900-3500.', ['2900', '3500'])).toBe(false)
    expect(ok('Subió 10%.', ['10'])).toBe(false)
    expect(ok('Subió 10%.', ['subió 10%'])).toBe(true)
    // a date's dashes are not a minus
    expect(ok('Fue el 2026-11-03.')).toBe(true)
  })

  it('refuses a number split by a space unless a source has it that way', () => {
    expect(ok('Son 12 500.', ['12', '500'])).toBe(false)
    expect(ok('Son 12 500.', ['pagué 12 500'])).toBe(true) // exactly as given
    expect(ok('Son 2 900.', ['hace 2', '900'])).toBe(false)
  })
})

describe('echoes and checkSay: a text that only repeats the person adds nothing', () => {
  it.each([
    ['cuanto voy este mes', 'cuanto voy este mes'],
    ['cuanto voy este mes', '¿Cuánto voy este mes?'],
    ['cuanto voy este mes', 'Cuánto voy este mes?!'],
    ['cuanto voy este mes', 'Me preguntás cuanto voy este mes'],
    ['borraste el super', 'borraste el súper?'],
  ])('"%s" ← "%s"', (message, text) => {
    expect(echoes(text, message)).toBe(true)
  })

  it.each([
    ['cuanto voy este mes', 'Este mes vas $43.300'],
    ['cuanto voy este mes', 'No encontré gastos este mes, ¿querés que mire otro período?'],
    ['borraste el super', 'Sí, lo borré.'],
    ['ok', 'ok'], // two words or fewer are never an echo: "gracias" → "gracias" is a courtesy
    ['hola que tal', ''],
  ])('"%s" ← "%s" is its own text', (message, text) => {
    expect(echoes(text, message)).toBe(false)
  })

  it('checkSay refuses an echo and marks it, so the caller can drop it without a repair', () => {
    const r = checkSay('Cuánto voy este mes', {
      ...evidence(),
      message: 'cuanto voy este mes',
    })
    expect(r).toEqual({ ok: false, reason: "echoes the person's message", echo: true })
    // the same text is fine when it is not the message
    expect(checkSay('Cuánto voy este mes', { ...evidence(), message: 'hola' }).ok).toBe(true)
  })

  it('composeReply drops an echo, with its reason in the verdict', () => {
    const r = composeReply({
      lines: ['Este mes gastaste $43.800 (5 movimientos).'],
      says: [{ action: 0, text: 'cuanto voy este mes' }],
      steps: [{ tool: 'summarize', outcome: 'applied' }],
      message: 'cuanto voy este mes?',
      facts: ['cuanto voy este mes?'],
      window: [],
      fallback: 'FALLBACK',
    })
    expect(r.reply).toBe('Este mes gastaste $43.800 (5 movimientos).')
    expect(r.verdicts.get(0)).toEqual({
      text: 'dropped',
      textReason: "echoes the person's message",
    })
  })
})
