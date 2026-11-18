/**
 * Synthetic BBVA mail bodies: the real layouts (tables, classes, labels) with invented values.
 * No real mail or real account data belongs in this repository.
 */
function digit(digits: string, weights: number[]): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++)
    sum += Number(digits[i]) * (weights[i % weights.length] ?? 0)
  return (10 - (sum % 10)) % 10
}

/** Builds a CBU/CVU with valid check digits from 7 + 13 arbitrary digits. */
export function fakeCbu(bank = '0170099', account = '2000001234567'): string {
  return `${bank}${digit(bank, [7, 1, 3, 9, 7, 1, 3])}${account}${digit(account, [3, 9, 7, 1])}`
}

/** Builds a CUIT with a valid check digit from 10 digits. */
export function fakeCuit(base = '2012345678'): string {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 10; i++) sum += Number(base[i]) * (w[i] ?? 0)
  const mod = 11 - (sum % 11)
  return `${base}${mod === 11 ? 0 : mod === 10 ? 9 : mod}`
}

export const CBU = fakeCbu()
export const CUIT = fakeCuit()

export type SentValues = {
  name: string
  when: string
  cbu: string
  reference: string
  cuit: string
  reason: string
  amount: string
}
export const SENT: SentValues = {
  name: 'Juana Ejemplo',
  when: '14/11/2026 - 09:58',
  cbu: CBU,
  reference: '10170000000000001',
  cuit: CUIT,
  reason: 'VARIOS',
  amount: '$ 12.345,60',
}

export function transferSentHtml(v: Partial<SentValues> = {}, extraMobileRows = ''): string {
  const x = { ...SENT, ...v }
  return `<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>
<table class="layout-container layout-table"><tr><td id="content-slot"><div class="main-text-content">
Hola, <b>Persona De Prueba</b>:<br><br>Te informamos que realizaste la siguiente transferencia:<br><br>
<table class="card-style-desktop">
<tr><td class="first-tr"><b>Destinatario</b></td><td class="first-tr"><b>Fecha y hora</b></td></tr>
<tr><td class="not-bold-text">${x.name} </td><td class="not-bold-text">${x.when}</td></tr>
<tr><td><b>CBU</b></td><td><b>N&uacute;mero de referencia</b></td></tr>
<tr><td class="not-bold-text">${x.cbu}</td><td class="not-bold-text">${x.reference}</td></tr>
<tr><td><b>CUIL</b></td><td><b>Motivo</b></td></tr>
<tr><td class="not-bold-text">${x.cuit}</td><td class="not-bold-text">${x.reason}</td></tr>
<tr><td><b>Importe</b></td></tr><tr><td class="not-bold-text">${x.amount}</td></tr>
</table>
<table class="card-style-mobile">
<tr><td class="first-tr"><b>Destinatario</b></td></tr><tr><td class="not-bold-text">${x.name} </td></tr>
<tr><td><b>CUIL</b></td></tr><tr><td class="not-bold-text">${x.cuit}</td></tr>
<tr><td><b>Importe</b></td></tr><tr><td class="not-bold-text">${x.amount}</td></tr>
<tr><td><b>Fecha y hora</b></td></tr><tr><td class="not-bold-text">${x.when}</td></tr>
<tr><td><b>N&uacute;mero de referencia</b></td></tr><tr><td class="not-bold-text">${x.reference}</td></tr>
<tr><td><b>Motivo</b></td></tr><tr><td class="not-bold-text">${x.reason}</td></tr>${extraMobileRows}
</table>
<br>Si no fuiste vos, te pedimos que completes el <a>formulario de contacto</a>
</div></td></tr>
<tfoot><tr><td><table class="layout-table table-desktop"><tr><td class="security-image"><img></td><td><span>Nunca te vamos a pedir tus claves.</span></td></tr></table></td></tr></tfoot>
</table></body></html>`
}

export type NoticeValues = {
  date: string
  account: string
  cbu: string
  cuit: string
  amount: string
}
export const NOTICE: NoticeValues = {
  date: '14/11/2026',
  account: 'CA-ARS ***123/4',
  cbu: CBU,
  cuit: CUIT,
  amount: 'ARS 12.345,60',
}

export function transferNoticeHtml(
  side: 'destino' | 'origen',
  v: Partial<NoticeValues> = {},
  accountLabel = 'CVU',
): string {
  const x = { ...NOTICE, ...v }
  const verb = side === 'destino' ? 'el d&eacute;bito' : 'la acreditaci&oacute;n'
  return `<html><body><table class="stylingblock-content-wrapper"><tbody><tr><td class="camarker-inner">
<table class="width300"><tbody><tr><td class="width20"><img></td><td><div class="LH18">Hola PERSONA DE PRUEBA,<br><br>
Se efectu&oacute; ${verb} de una transferencia inmediata con el siguiente detalle:<br><br></div></td><td class="width20"><img></td></tr></tbody></table>
<table class="width300"><tbody><tr><td><table class="width300"><td class="width30"><img></td><td>
<table class="FS14"><tbody>
<tr><td> Fecha <br><br></td><td> ${x.date} <br><br></td></tr>
<tr><td> N&uacute;mero cuenta <br><br></td><td> ${x.account} <br><br></td></tr>
<tr><td> ${accountLabel} ${side} <br><br></td><td> ${x.cbu} <br><br></td></tr>
<tr><td> CUIT ${side} <br><br></td><td> ${x.cuit} <br><br></td></tr>
<tr><td> Importe <br><br></td><td> ${x.amount} <br><br></td></tr>
</tbody></table></td><td class="width30"><img></td></table></td></tr></tbody></table>
<table><tr><td class="width24"><a><img></a></td><td class="width24"><a><img></a></td><td class="width24"><a><img></a></td></tr></table>
</td></tr></tbody></table></body></html>`
}

/** A complete unsigned message with the given Subject and HTML body. */
export function htmlMessage(
  subject: string,
  html: string,
  to: string,
  from = 'avisos@bbva.com.ar',
): string {
  return [
    `From: BBVA <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Date: Sat, 14 Nov 2026 10:00:00 -0300',
    'Message-ID: <synthetic@bbva.com.ar>',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html.replaceAll('\n', '\r\n'),
    '',
  ].join('\r\n')
}

export type CardPurchaseValues = {
  heading: string
  intro: string
  date: string
  merchant: string
  amount: string
  /** Extra rows appended to the value table, spacer-separated. */
  extraRows: string
}
export const CARD_PURCHASE: CardPurchaseValues = {
  heading: 'Pagaste con tu tarjeta de crédito',
  intro:
    'Hola PERSONA DE PRUEBA, se aprobó un pago con tu tarjeta VISA terminada en 1234. Si tenés dudas, escribinos.',
  date: '14/11/2026',
  merchant: 'COMERCIO DE EJEMPLO SRL',
  amount: '$ 12.345,60',
  extraRows: '',
}

const valueRow = (value: string) => `<tr><td><img></td><td></td><td><p>${value}</p><br></td></tr>`
const spacerRow = '<tr><td></td><td></td><td></td></tr>'

/** A further value row after a spacer, for a layout with more than three. */
export const cardValueRow = (value: string) => spacerRow + valueRow(value)

/** "Compra aprobada": nested tables, three unlabeled value rows, then the legal text. */
export function cardPurchaseHtml(v: Partial<CardPurchaseValues> = {}): string {
  const x = { ...CARD_PURCHASE, ...v }
  return `<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>
<table class="wrapper"><tr><td><table class="main"><tr><td>
<div><p>${x.heading}</p></div>
<div><p>${x.intro}</p></div>
<table>${valueRow(x.date)}${spacerRow}${valueRow(x.merchant)}${spacerRow}${valueRow(x.amount)}${x.extraRows}</table>
<div><p>¿No reconocés el pago?</p></div>
<div><p>Si no hiciste esta compra, comunicate con nosotros desde la app.</p></div>
<div><p>Para tener presente</p></div>
<div><p>Nunca te vamos a pedir tus claves por mail ni por teléfono. Consultas 0800-000-0000.</p></div>
<table><tr><td><a><img></a></td><td><a><img></a></td><td><a><img></a></td></tr></table>
<div><p>Este mensaje es confidencial. BBVA Argentina S.A., CUIT 30-00000000-0, domicilio ficticio 123. Tasas del 12/11/2026 al 31/12/2026, TNA 100,00%.</p></div>
<span>PagoAprobado_sinmillasTIT / NM</span>
</td></tr></table></td></tr></table></body></html>`
}
