import { describe, expect, it } from 'vitest'
import { skeleton } from '../src/mail/skeleton'

const MARKER = 'ZZMARKERQ'
const MERCHANTS = [
  'Kiosco Uno',
  'Libreria Dos',
  'Panaderia Tres',
  'Ferreteria Cuatro',
  'Cafe Cinco',
]

/** A synthetic card mail: constant labels, one varying merchant, constants that must not print. */
function cardMail(merchant: string, i: number, extra = ''): string {
  return `<html><head><title>Aviso secreto</title><style>.x{color:red}</style></head><body>
<script>var secret = "SCRIPTVALUE"</script>
<table class="outer" style="width:1px"><tr><td>Compra aprobada</td></tr>
<tr><td>Comercio</td><td>${merchant}</td></tr>
<tr><td>Importe</td><td>$ ${100 + i},50</td></tr>
<tr><td>Limite fijo</td><td>$ 100,00</td></tr>
<tr><td>Fecha fija</td><td>14/11/2026</td></tr>
<tr><td>Tarjeta</td><td>terminada en 1774</td></tr>
<tr><td>Cuotas   y
   detalle</td><td>${extra}</td></tr>
</table><a href="https://bank.example/track?id=SECRETID${i}">Ver mas</a><img src="https://bank.example/px/USERID${i}.gif"></body></html>`
}

const five = (override: (i: number) => string = (i) => cardMail(MERCHANTS[i] ?? '', i)) =>
  [0, 1, 2, 3, 4].map(override)

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
    const out = skeleton(five((i) => cardMail(i === 0 ? MARKER : 'Comercio igual', i)))
    expect(out).not.toContain(MARKER)
    const withExtra = skeleton(five((i) => cardMail('Comercio igual', i, i === 0 ? MARKER : '')))
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

  it('refuses fewer than five mails', () => {
    expect(() => skeleton(five().slice(0, 4))).toThrow(/at least 5/)
    expect(() => skeleton([])).toThrow()
  })

  it('prints one skeleton per layout with its mail count', () => {
    const wide = (i: number) =>
      cardMail(MERCHANTS[i] ?? '', i).replace('</table>', '<tr><td>Cuotas</td></tr></table>')
    const out = skeleton([...five(), ...[5, 6, 7, 8, 9].map(wide)])
    expect(out).toContain('layout 1: 5 mails')
    expect(out).toContain('layout 2: 5 mails')
    expect(out.split('\n\n')).toHaveLength(2)
  })

  it('prints no verbatim text for a layout with fewer than five mails', () => {
    const odd = (i: number) =>
      cardMail('Comercio igual', i).replace('</table>', '<tr><td>Etiqueta rara</td></tr></table>')
    const out = skeleton([...five(), odd(5), odd(6)])
    expect(out).toContain('layout 1: 5 mails')
    expect(out).toContain('layout 2: 2 mails')
    const small = out.split('\n\n')[1] ?? ''
    expect(small).not.toContain('Etiqueta rara')
    expect(small).not.toContain('Comercio')
    expect(small).not.toMatch(/^\s*"/m)
    expect(small).toContain('<text:13>')
  })
})
