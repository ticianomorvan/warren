import { describe, expect, it } from 'vitest'
import { forbiddenTokens, SKELETON_REFUSAL, skeleton } from '../src/mail/skeleton'

const MARKER = 'ZZMARKERQ'
const MERCHANTS = [
  'Kiosco Uno',
  'Libreria Dos',
  'Panaderia Tres',
  'Ferreteria Cuatro',
  'Cafe Cinco',
  'Verduleria Seis',
  'Jugueteria Siete',
]

type Opts = { merchant?: string; amount?: string; extra?: string; rows?: string }

/** A synthetic card mail: constant labels, a varying merchant and amount, constants that must not print. */
function cardMail(i: number, o: Opts = {}): string {
  const merchant = o.merchant ?? MERCHANTS[i] ?? ''
  const amount = o.amount ?? `$ ${100 + i},50`
  return `<html><head><title>Aviso secreto</title><style>.x{color:red}</style></head><body>
<script>var secret = "SCRIPTVALUE"</script>
<table class="outer" style="width:1px"><tr><td>Compra aprobada</td></tr>
<tr><td>Comercio</td><td>${merchant}</td></tr>
<tr><td>Importe</td><td>${amount}</td></tr>
<tr><td>Limite fijo</td><td>$ 100,00</td></tr>
<tr><td>Fecha fija</td><td>14/11/2026</td></tr>
<tr><td>Tarjeta</td><td>terminada en 1774</td></tr>
<tr><td>Cuotas   y
   detalle</td><td>${o.extra ?? ''}</td></tr>${o.rows ?? ''}
</table><a href="https://bank.example/track?id=SECRETID${i}">Ver mas</a><br><img src="https://bank.example/px/USERID${i}.gif"></body></html>`
}

const five = (o: (i: number) => Opts = () => ({})) => [0, 1, 2, 3, 4].map((i) => cardMail(i, o(i)))
const row = (label: string) => `<tr><td>${label}</td><td>x</td></tr>`
const lines = (s: string) => s.split('\n').map((l) => l.trim())

describe('skeleton', () => {
  it('prints constant label text verbatim', () => {
    const out = skeleton(five())
    for (const label of ['Compra aprobada', 'Comercio', 'Importe', 'Ver mas'])
      expect(out).toContain(JSON.stringify(label))
    expect(out).toContain('"Cuotas y detalle"')
  })

  it('never prints values that vary across mails', () => {
    const out = skeleton(five())
    for (const merchant of MERCHANTS) expect(out).not.toContain(merchant)
    expect(out).not.toMatch(/10[0-4],50/)
    expect(out).toContain('<money>')
    expect(out).toContain(`<text:${MERCHANTS[0]?.length}>`)
  })

  it('never prints a marker planted in one mail', () => {
    const out = skeleton(five((i) => ({ merchant: i === 0 ? MARKER : 'Comercio igual' })))
    expect(out).not.toContain(MARKER)
    const withExtra = skeleton(
      five((i) => ({ merchant: 'Comercio igual', extra: i === 0 ? MARKER : '' })),
    )
    expect(withExtra).not.toContain(MARKER)
  })

  it('prints a constant money, date or digits value as its class', () => {
    const out = skeleton(five())
    expect(out).not.toContain('100,00')
    expect(out).not.toContain('14/11/2026')
    expect(out).not.toContain('1774')
    expect(out).toContain('<date>')
    expect(out).toContain('<digits:17>')
  })

  it('never prints attributes, urls, head, script or style content', () => {
    const out = skeleton(five())
    for (const leak of ['href', 'src', 'http', 'bank.example', 'SECRETID', 'USERID', 'class'])
      expect(out).not.toContain(leak)
    for (const leak of ['Aviso secreto', 'SCRIPTVALUE', 'color:red', 'width'])
      expect(out).not.toContain(leak)
    expect(out).toContain('<table>')
  })

  it('never prints a constant text that holds any digit or an at sign', () => {
    const labels = ['Visa **74', '1 de 3', 'Calle Falsa N 12', '12 USD', 'ayuda@banco.example']
    const out = skeleton(five(() => ({ rows: labels.map(row).join('') })))
    for (const label of labels) expect(out).not.toContain(label)
    for (const part of ['Visa', 'Falsa', '1 de', 'ayuda', 'banco']) expect(out).not.toContain(part)
    expect(out).toContain('<money>') // "12 USD" is an amount
    expect(out).toContain('<text:9>') // "Visa **74", "1 de 3" is 6
    expect(out).toContain('"Comercio"') // the rest is unharmed
  })

  it('prints text that holds a forbidden token as its class, ignoring case and accents', () => {
    const rows = ['Hola Josefina', 'Cuenta de JOSÉ', 'Ver mas detalles'].map(row).join('')
    const forbidden = forbiddenTokens(['Jose Pérez', 'jose.perez+bbva@mail.example'])
    expect(forbidden).toEqual(expect.arrayContaining(['jose', 'perez', 'bbva']))
    const out = skeleton(
      five(() => ({ rows })),
      { forbidden },
    )
    expect(out).not.toMatch(/jose|JOS/i)
    expect(out).toContain('"Ver mas detalles"')
    // tokens shorter than 3 characters are ignored
    expect(
      skeleton(
        five(() => ({ rows })),
        { forbidden: ['ve'] },
      ),
    ).toContain('"Ver mas detalles"')
    // without the option the same text prints
    expect(skeleton(five(() => ({ rows })))).toContain('"Hola Josefina"')
  })

  it('prints no verbatim text when no text slot varies', () => {
    // Five mails of one merchant: only the amount changes, so labels cannot be told from values.
    const out = skeleton(five(() => ({ merchant: 'NETFLIX.COM' })))
    expect(out).not.toMatch(/^\s*"/m)
    expect(out).not.toContain('NETFLIX')
    expect(out).not.toContain('Comercio')
    expect(out).toContain('<money>')
  })

  it('counts mails with the same text values once', () => {
    const same = [0, 1, 2, 3, 4, 5, 6, 7].map(() => cardMail(0))
    expect(() => skeleton(same)).toThrow(SKELETON_REFUSAL)
    const four = [0, 1, 2, 3].flatMap((i) => [cardMail(i), cardMail(i)])
    expect(() => skeleton(four)).toThrow(SKELETON_REFUSAL)
    expect(skeleton([...four, cardMail(4)])).toContain('layout 1: 5 mails')
  })

  it('refuses fewer than five mails with a message that does not say how many', () => {
    for (const n of [0, 1, 4]) {
      let message = ''
      try {
        skeleton(five().slice(0, n))
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toBe(SKELETON_REFUSAL)
      expect(message).not.toMatch(/\d/)
    }
  })

  it('prints one skeleton per layout, with a count only for layouts of five or more', () => {
    const wide = [5, 6, 7, 8, 9].map((i) =>
      cardMail(i, { merchant: `Comercio ${MERCHANTS[i % 7]}`, rows: row('Cuotas') }),
    )
    const out = skeleton([...five(), ...wide])
    expect(out).toContain('layout 1: 5 mails')
    expect(out).toContain('layout 2: 5 mails')
    expect(out.split('\n\n')).toHaveLength(2)
  })

  it('prints no verbatim text, and no count, for a layout with fewer than five mails', () => {
    const odd = [5, 6].map((i) => cardMail(i, { merchant: 'Igual', rows: row('Etiqueta rara') }))
    const out = skeleton([...five(), ...odd])
    const parts = out.split('\n\n')
    expect(parts[0]).toContain('layout 1: 5 mails')
    expect(parts[1]?.split('\n')[0]).toBe('layout 2')
    expect(parts[1]).not.toContain('Etiqueta rara')
    expect(parts[1]).not.toContain('Comercio')
    expect(parts[1]).not.toMatch(/^\s*"/m)
    expect(parts[1]).toContain('<text:13>')
  })

  it('reads html that has content outside body, and never prints head text', () => {
    const fragments = five().map((full, i) => {
      const inner = full.slice(full.indexOf('<table'), full.indexOf('</table>') + 8)
      return i % 2 === 0
        ? `<title>Titulo secreto</title>${inner}`
        : `${inner}</body></html><div>Comercio</div><p>Pie ${i}</p>`
    })
    const out = skeleton(fragments)
    expect(out).toContain('<table>')
    expect(out.split('\n').length).toBeGreaterThan(5)
    expect(out).not.toContain('Titulo secreto')
    expect(out).not.toContain('Aviso secreto')
    expect(out).toContain('<div>')
  })

  it('prints void elements without a closing tag, and keeps the indent right', () => {
    const out = lines(skeleton(five()))
    expect(out).toContain('<br>')
    expect(out).toContain('<img>')
    expect(out).not.toContain('</br>')
    expect(out).not.toContain('</img>')
    const raw = skeleton(five()).split('\n')
    expect(raw.at(-1)).toBe('</body>')
  })
})
