import { ASSETS, isAsset } from '../assets'
import type { PushPayload } from './push'

/** What a notice needs to know about a movement. Names come from the ledger, never a model. */
export type NoticeMovement = {
  type: 'own_transfer' | 'unclassified' | 'card_purchase'
  direction: 'in' | 'out'
  /** Decimal string, as stored. */
  amount: string
  currency: string
  /** yyyy-mm-dd */
  date: string
  /** hh:mm or hh:mm:ss */
  time: string | null
  accountName: string | null
  counterAccountName: string | null
  /** The merchant, for a card purchase. */
  counterpartyName: string | null
  /** The card's last four digits, for a card purchase. */
  cardLastFour?: string | null
}

/** "1500.00000000" becomes "1.500,00". Pure string work: no floating point. */
export function formatAmount(amount: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount)
  if (!match) throw new Error('not a decimal amount')
  const whole = (match[1] ?? '0').replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+$)/g, '.')
  const fraction = (match[2] ?? '').replace(/0+$/, '').padEnd(2, '0')
  return `${whole},${fraction}`
}

export function formatMoney(amount: string, currency: string): string {
  return `${isAsset(currency) ? ASSETS[currency].symbol : currency} ${formatAmount(amount)}`
}

/**
 * `formatMoney` for a net, which can be negative: "-1500.5" becomes "-$ 1.500,50". Zero has no
 * sign, so "-0" and "-0.00000000" are "$ 0,00". The notifier's `formatMoney` stays strict.
 */
export function formatSignedMoney(amount: string, currency: string): string {
  if (!amount.startsWith('-')) return formatMoney(amount, currency)
  const money = formatMoney(amount.slice(1), currency)
  return /^-?0*(\.0*)?$/.test(amount) ? money : `-${money}`
}

function formatWhen(date: string, time: string | null): string {
  const [, month, day] = date.split('-')
  return `${day}/${month}${time ? ` ${time.slice(0, 5)}` : ''}`
}

/** The notice for a new movement, one fact per line. Parts not known yet are left out. */
export function noticeLines(m: NoticeMovement): string[] {
  const money = formatMoney(m.amount, m.currency)
  const when = formatWhen(m.date, m.time)
  if (m.type === 'card_purchase') {
    const card = m.cardLastFour ? ` …${m.cardLastFour}` : ''
    const where = m.counterpartyName ? ` en ${m.counterpartyName}` : ''
    return [
      `Compra con tarjeta${card}`,
      `${money}${where}`,
      [m.accountName, when].filter(Boolean).join(' · '),
    ]
  }
  if (m.type === 'own_transfer') {
    const [from, to] =
      m.direction === 'out'
        ? [m.accountName, m.counterAccountName]
        : [m.counterAccountName, m.accountName]
    const route = [from, to].some(Boolean) ? `${from ?? ''} → ${to ?? ''}`.trim() : null
    return ['Transferencia entre tus cuentas', money, ...(route ? [route] : []), when]
  }
  const out = m.direction === 'out'
  const who = m.counterpartyName ? ` ${out ? 'a' : 'de'} ${m.counterpartyName}` : ''
  return [
    out ? 'Transferencia enviada' : 'Transferencia recibida',
    `${money}${who}`,
    [m.accountName, when].filter(Boolean).join(' · '),
  ]
}

export const noticeText = (m: NoticeMovement) => noticeLines(m).join('\n')

/** What the service worker shows: the first line as the title, the rest as the body. */
export function noticePushPayload(noticeId: number, m: NoticeMovement): PushPayload {
  const [title = '', ...rest] = noticeLines(m)
  return { title, body: rest.join('\n'), tag: `notice-${noticeId}`, url: '/movements' }
}
