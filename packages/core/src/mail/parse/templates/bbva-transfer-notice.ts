import { parseCbu, parseCuit, parseDate, parseMoney, parseText } from '../fields'
import { labelValueRows, takeFields } from '../html'
import type { BankOperation, Template } from '../types'

/**
 * "AVISO TRANSFERENCIA INMEDIATA DEBITADA / ACREDITADA": the account-side notice of an
 * immediate transfer. It prints the date without a time and has no reference number.
 */
function notice(kind: BankOperation['kind'], side: 'destino' | 'origen'): Template['parse'] {
  return (doc) => {
    const f = takeFields(labelValueRows(doc), {
      date: ['Fecha'],
      ownAccount: ['Número cuenta'],
      account: [`CVU ${side}`, `CBU ${side}`],
      taxId: [`CUIT ${side}`, `CUIL ${side}`],
      amount: ['Importe'],
    })
    return {
      kind,
      ...parseMoney(f.amount ?? ''),
      date: parseDate(f.date ?? ''),
      time: null,
      ownAccount: parseText(f.ownAccount ?? '', 'ownAccount', 40),
      counterparty: {
        name: null,
        account: parseCbu(f.account ?? ''),
        taxId: parseCuit(f.taxId ?? ''),
      },
      reference: null,
      reason: null,
    }
  }
}

export const bbvaTransferDebited: Template = {
  id: 'bbva.transfer-debited',
  version: 1,
  senderId: 'bbva-transfers',
  subject: /AVISO TRANSFERENCIA INMEDIATA DEBITADA$/,
  parse: notice('transfer_out', 'destino'),
}

/** Written by analogy with the debit notice; not yet confirmed against a real mail. */
export const bbvaTransferCredited: Template = {
  id: 'bbva.transfer-credited',
  version: 1,
  senderId: 'bbva-transfers',
  subject: /AVISO TRANSFERENCIA INMEDIATA ACREDITADA$/,
  parse: notice('transfer_in', 'origen'),
}
