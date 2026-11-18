import { parseCbu, parseCuit, parseDateTime, parseDigits, parseMoney, parseText } from '../fields'
import { alternatingRows, takeFields } from '../html'
import type { Template } from '../types'

/**
 * "Realizaste una transferencia": sent when the owner makes a transfer from the app.
 * The mail repeats the data in a desktop and a mobile table; the mobile one is one field
 * per row, so that is the one read. Its mobile table does not print the CBU.
 */
export const bbvaTransferSent: Template = {
  id: 'bbva.transfer-sent',
  version: 1,
  senderId: 'bbva-transfers',
  subject: /^Realizaste una transferencia$/,
  parse(doc) {
    const f = takeFields(alternatingRows(doc, 'table.card-style-mobile'), {
      name: ['Destinatario'],
      taxId: ['CUIL', 'CUIT'],
      amount: ['Importe'],
      when: ['Fecha y hora'],
      reference: ['Número de referencia'],
      reason: ['Motivo'],
    })
    const { date, time } = parseDateTime(f.when ?? '')
    return {
      kind: 'transfer_out',
      ...parseMoney(f.amount ?? ''),
      date,
      time,
      ownAccount: null,
      counterparty: {
        name: parseText(f.name ?? '', 'name'),
        account: desktopCbu(doc),
        taxId: parseCuit(f.taxId ?? ''),
      },
      reference: parseDigits(f.reference ?? '', 'reference'),
      reason: parseText(f.reason ?? '', 'reason'),
    }
  },
}

/** The CBU appears only in the desktop table: a "CBU" label cell, value in the next row. */
function desktopCbu(doc: Parameters<Template['parse']>[0]): string {
  const rows = [...doc.querySelectorAll('table.card-style-desktop tr')]
  for (let i = 0; i < rows.length - 1; i++) {
    const cells = [...(rows[i]?.children ?? [])]
    const col = cells.findIndex((c) => (c.textContent ?? '').trim() === 'CBU')
    if (col >= 0) return parseCbu([...(rows[i + 1]?.children ?? [])][col]?.textContent ?? '')
  }
  return parseCbu('')
}
